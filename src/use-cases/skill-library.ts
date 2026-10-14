import { parseSkillGitSource, type SkillGitTarget } from '../domain/skill-git-source.js'
import type { SkillImportIntentPort } from '../ports/skill-import-intent.js'
import type { SkillImportCandidates } from '../domain/skill-import.js'
import type { SkillPack } from '../domain/skill-pack.js'
import type { CommunitySkillImportPreview, CommunitySkillImportInput } from '../domain/admin-contract.js'
import type { SkillPackState } from '../ports/skill-packs.js'
import type { MemberSkillNamesPort } from '../ports/member-skills.js'
import type { SkillMembership } from './skill-membership.js'
import type { CommunityAccountActor } from '../domain/community-account.js'
import { CommunityAuthenticationError } from '../domain/community-account.js'
import { BusinessRuleError } from '../domain/business-error.js'
import type { LibrarySkill, UploadedSkill } from '../domain/skill-library.js'
import type { CommunitySkillView, CommunitySkillDetail, CommunitySkillPreview } from '../domain/admin-contract.js'
import type { CommunityAccountStorePort } from '../ports/community-accounts.js'
import type { SkillLibraryStorePort, SkillArtifactsPort } from '../ports/skill-library.js'
import type { Clock } from '../ports/clock.js'

/** Serializes skill intake, confirmation and artifact collection. */
export class SkillLibrary {
  private readonly pending = new Map<string, { actor: CommunityAccountActor, upload: UploadedSkill, revision: string, expires: number }>()
  private readonly imports = new Map<string, { actor: CommunityAccountActor, bundle: SkillImportCandidates, deleted: readonly string[], revisions: Readonly<Record<string, string>>, expires: number }>()
  private readonly completedImports = new Map<string, { actor: CommunityAccountActor, expires: number }>()
  private readonly intake = new Set<AbortController>()
  private stopped = false
  private tail: Promise<unknown> = Promise.resolve()
  constructor(private readonly accounts: Pick<CommunityAccountStorePort, 'get'>, private readonly store: SkillLibraryStorePort,
    private readonly artifacts: SkillArtifactsPort, private readonly clock: Clock, private readonly membership?: SkillMembership, private readonly memberNames?: MemberSkillNamesPort, private readonly bundledNames: readonly string[] = [], private readonly packs?: SkillPackState, private readonly importIntent?: SkillImportIntentPort) {}
  adopted(name: string, hash: string): boolean { return this.store.list().some(row => row.name === name && row.hash === hash) }
  list(actor: CommunityAccountActor): readonly CommunitySkillView[] {
    this.assertAdmin(actor); return this.store.list().map(row => this.view(row))
  }
  async detail(actor: CommunityAccountActor, name: string): Promise<CommunitySkillDetail> {
    return this.serial(async () => {
    this.assertAdmin(actor); const row = this.required(name)
    const contents = await this.artifacts.read(row.hash)
    this.assertAdmin(actor)
    return { ...this.view(row), ...contents, revision: this.revision(name) }
    })
  }
  upload(actor: CommunityAccountActor, content: AsyncIterable<Uint8Array>, signal: AbortSignal): Promise<CommunitySkillPreview> {
    const controller = new AbortController()
    this.intake.add(controller)
    signal = AbortSignal.any([signal, controller.signal])
    return this.serial(async () => {
      this.assertAdmin(actor); this.assertOpen(); signal.throwIfAborted()
      this.expire()
      await this.collect()
      try {
      const upload = await this.artifacts.accept(content, signal)
      signal.throwIfAborted(); this.assertAdmin(actor); this.assertOpen()
      if (this.packs?.store.list().some(pack => pack.note?.name === upload.name)) throw new BusinessRuleError('conflict', 'The orchestration skill name is already in use.', 'skill-pack-name-conflict')
      const revision = this.revision(upload.name), token = this.artifacts.newToken()
      this.pending.set(token, { actor, upload, revision, expires: this.clock.now() + 30 * 60 * 1000 })
      return { ...upload, token, revision, replacing: this.store.list().some(row => row.name === upload.name), ...this.impact(upload.name) }
      } finally { await this.collect() }
    }).finally(() => { this.intake.delete(controller) })
  }
  previewImport(actor: CommunityAccountActor, content: AsyncIterable<Uint8Array>, signal: AbortSignal, filename: string): Promise<CommunitySkillImportPreview> {
    return this.preview(actor, signal, async signal => {
      if (!this.artifacts.acceptImport) throw new BusinessRuleError('missing', 'Import is unavailable.', 'skill-unavailable')
      return { bundle: await this.artifacts.acceptImport(content, signal), filename }
    })
  }
  previewGit(actor: CommunityAccountActor, input: string, signal: AbortSignal, updateName?: string): Promise<CommunitySkillImportPreview> {
    return this.preview(actor, signal, async signal => {
      if (!this.artifacts.acceptGit) throw new BusinessRuleError('missing', 'Git import is unavailable.', 'skill-unavailable')
      const target = updateName ? this.required(updateName).source : parseSkillGitSource(input)
      if (!target) throw new BusinessRuleError('invalid', 'This skill has no Git source.', 'skill-unavailable')
      return { bundle: await this.artifacts.acceptGit(target, signal), filename: target.url.split('/').at(-1)!.replace(/\.git$/u, ''), target: updateName ? target : undefined }
    })
  }
  private preview(actor: CommunityAccountActor, signal: AbortSignal, load: (signal: AbortSignal) => Promise<{ bundle: SkillImportCandidates, filename: string, target?: SkillGitTarget | undefined }>): Promise<CommunitySkillImportPreview> {
    const controller = new AbortController(); this.intake.add(controller)
    signal = AbortSignal.any([signal, controller.signal])
    return this.serial(async () => {
      this.assertAdmin(actor); this.assertOpen(); signal.throwIfAborted(); this.expire(); await this.collect()
      try {
        if (!this.importIntent) throw new BusinessRuleError('missing', 'Import is unavailable.', 'skill-unavailable')
        const { bundle, filename, target } = await load(signal)
        signal.throwIfAborted(); this.assertAdmin(actor); this.assertOpen()
        if (!target && !bundle.candidates.length) throw new BusinessRuleError('invalid', 'No skills were found in this source.', 'skill-archive-invalid', { reason: 'No skills were found in this source.' })
        const sameSource = (source?: SkillGitTarget) => !!source && !!target && source.url === target.url && source.subpath === target.subpath && source.ref === target.ref
        const deleted = this.store.list().filter(row => sameSource(row.source) && !bundle.candidates.some(candidate => candidate.name === row.name)).map(row => row.name)
        const token = this.artifacts.newToken(), revisions = Object.fromEntries([...bundle.candidates.map(row => row.name), ...deleted].map(name => [name, this.revision(name)]))
        this.completedImports.delete(token)
        this.imports.set(token, { actor, bundle, deleted, revisions, expires: this.clock.now() + 30 * 60 * 1000 })
        return { token, ...(target ? { updating: true, deleted: deleted.map(name => ({ name, packs: this.packs?.store.list().filter(pack => pack.skills.includes(name)).map(pack => pack.name) ?? [], ...this.impact(name) })) } : {}),
          defaultPackName: bundle.candidates.find(row => row.orchestration && !row.internal)?.name ?? (filename.replace(/\.zip$/iu, '').toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '').slice(0, 64) || 'imported-skills'),
          candidates: bundle.candidates.map(row => { const existing = this.store.list().find(skill => skill.name === row.name); return { ...row, replacing: !!existing, ...this.impact(row.name),
            ...(target ? { change: !existing ? 'added' as const : sameSource(existing.source) && existing.source!.contentHash === row.source?.contentHash ? 'unchanged' as const : 'changed' as const } : {}) } }), packs: bundle.packs }
      } finally { await this.collect() }
    }).finally(() => { this.intake.delete(controller) })
  }
  confirmImport(actor: CommunityAccountActor, input: CommunitySkillImportInput): Promise<void> {
    return this.serial(async () => {
      this.assertAdmin(actor); this.assertOpen(); this.expire()
      const completed = this.completedImports.get(input.token)
      if (completed && this.sameActor(completed.actor, actor)) return
      const preview = this.imports.get(input.token)
      const changed = () => new BusinessRuleError('conflict', 'Review the skill again before confirming.', 'skill-preview-changed')
      if (!preview || !this.sameActor(preview.actor, actor)) throw changed()
      const selected = preview.bundle.candidates.filter(row => input.names.includes(row.name)), names = new Set(input.names), removals = input.removals ?? []
      if ((!selected.length && !removals.length) || new Set(removals).size !== removals.length || removals.some(name => !preview.deleted.includes(name) || names.has(name)) || names.size !== input.names.length || selected.length !== names.size || input.packs.length > 64) throw changed()
      const fresh = () => {
        for (const name of removals) if (this.revision(name) !== preview.revisions[name]) throw changed()
        for (const row of selected) {
          if (this.revision(row.name) !== preview.revisions[row.name] || this.store.list().some(skill => skill.name === row.name) && !input.replacements.includes(row.name)) throw changed()
          if (this.packs?.store.list().some(pack => pack.note?.name === row.name)) throw new BusinessRuleError('conflict', 'The orchestration skill name is already in use.', 'skill-pack-name-conflict')
        }
      }
      fresh()
      const noteNames = input.packs.flatMap(pack => pack.note ? [pack.note] : [])
      if (noteNames.some(name => names.has(name) || !preview.bundle.candidates.some(row => row.name === name))) throw changed()
      const packNames = new Set<string>(), plans: SkillPack[] = []
      for (const pack of input.packs) {
        if (!this.packs || !this.artifacts.createNote || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(pack.name) || pack.name.length > 64 || !pack.description.trim() || pack.description.length > 4096
          || packNames.has(pack.name) || this.packs.store.list().some(existing => existing.name === pack.name) || pack.skills.some(name => !names.has(name)) || new Set(pack.skills).size !== pack.skills.length) throw new BusinessRuleError('invalid', 'Review the skill pack name and selected skills.', 'skill-pack-invalid')
        if (pack.note && (names.has(pack.name) || this.store.list().some(skill => skill.name === pack.name) || this.bundledNames.includes(pack.name))) throw new BusinessRuleError('conflict', 'The orchestration skill name is already in use.', 'skill-pack-name-conflict')
        packNames.add(pack.name)
      }
      try {
        for (const pack of input.packs) {
          const instructions = preview.bundle.candidates.find(row => row.name === pack.note)?.markdown ?? ''
          const note = pack.note ? await this.artifacts.createNote!(pack.name, pack.description, instructions) : undefined
          plans.push({ name: pack.name, description: pack.description, skills: pack.skills, instructions, published: false,
            ...(note ? { note: { name: note.name, description: note.description, hash: note.hash, importedAt: this.clock.now(), published: false } } : {}) })
        }
        this.assertAdmin(actor); this.assertOpen(); fresh()
        for (const pack of this.packs?.store.list() ?? []) if (pack.skills.some(name => removals.includes(name))) plans.push({ ...pack, skills: pack.skills.filter(name => !removals.includes(name)) })
        this.importIntent!.save({ token: input.token, actor, packs: plans, removals, skills: selected.map(row => ({ name: row.name, description: row.description, hash: row.hash, ...(row.source ? { source: row.source } : {}), importedAt: this.clock.now(), published: this.store.list().find(skill => skill.name === row.name)?.published ?? false })) })
        await this.finishImport()
      } finally { await this.collect() }
    })
  }
  confirm(actor: CommunityAccountActor, token: string, revision: string): Promise<CommunitySkillView> {
    return this.serial(async () => {
      this.assertAdmin(actor); this.assertOpen(); this.expire()
      const preview = this.pending.get(token)
      if (!preview || (preview.actor.username !== actor.username || preview.actor.spaceId !== actor.spaceId || preview.actor.sessionEpoch !== actor.sessionEpoch) || preview.revision !== revision || this.revision(preview.upload.name) !== revision)
        throw new BusinessRuleError('conflict', 'Review the skill again before confirming.', 'skill-preview-changed')
      const { name, description, hash } = preview.upload
      const row: LibrarySkill = { name, description, hash, importedAt: this.clock.now(), published: this.store.list().find(item => item.name === name)?.published ?? false }
      this.store.save(row); this.pending.delete(token)
      await this.membership?.reconcile(); await this.collect()
      return this.view(row)
    })
  }
  remove(actor: CommunityAccountActor, name: string, revision: string): Promise<void> {
    return this.serial(async () => {
      this.assertAdmin(actor); this.assertOpen(); this.required(name)
      if (revision !== this.revision(name)) throw new BusinessRuleError('conflict', 'Review the skill again before confirming.', 'skill-preview-changed')
      for (const pack of this.packs?.store.list() ?? []) if (pack.skills.includes(name)) this.packs!.store.save({ ...pack, skills: pack.skills.filter(child => child !== name) })
      this.store.remove(name); await this.membership?.reconcile(); await this.collect()
    })
  }
  cancel(actor: CommunityAccountActor, token: string): Promise<void> {
    return this.serial(async () => {
      this.assertAdmin(actor)
      const row = this.pending.get(token)
      if (row?.actor.username === actor.username && row.actor.spaceId === actor.spaceId && row.actor.sessionEpoch === actor.sessionEpoch) this.pending.delete(token)
      const imported = this.imports.get(token)
      if (imported?.actor.username === actor.username && imported.actor.spaceId === actor.spaceId && imported.actor.sessionEpoch === actor.sessionEpoch) this.imports.delete(token)
      this.expire(); await this.collect()
    })
  }
  publish(actor: CommunityAccountActor, name: string, published: boolean, revision: string) {
    return this.serial(async () => {
      this.assertAdmin(actor); this.assertOpen(); const row = this.required(name)
      if (revision !== this.revision(name)) throw new BusinessRuleError('conflict', 'Review the skill again before confirming.', 'skill-preview-changed')
      if (published && row.conflict) throw new BusinessRuleError('conflict', 'Skills are unavailable.', 'skill-unavailable')
      this.store.save({ ...row, published }); await this.membership?.reconcile(); return this.view(this.required(name))
    })
  }
  market(actor: CommunityAccountActor) {
    return this.serial(async () => {
      this.current(actor)
      const names = await this.memberNames?.names(actor.username) ?? []
      this.current(actor)
      return { skills: this.requiredMembership().market(actor.username, names), ...this.requiredMembership().synchronization() }
    })
  }
  marketDetail(actor: CommunityAccountActor, name: string) {
    return this.serial(async () => {
      this.current(actor)
      const names = await this.memberNames?.names(actor.username) ?? []
      const skill = this.requiredMembership().market(actor.username, names).find(row => row.name === name)
      if (!skill) throw new BusinessRuleError('missing', 'Skills are unavailable.', 'skill-unavailable')
      const contents = await this.artifacts.read(this.required(name).hash)
      this.current(actor)
      const current = this.requiredMembership().market(actor.username, names).find(row => row.name === name)
      if (!current) throw new BusinessRuleError('missing', 'Skills are unavailable.', 'skill-unavailable')
      return { ...current, ...contents }
    })
  }
  select(actor: CommunityAccountActor, name: string, selected: boolean) {
    return this.serial(async () => { this.current(actor); this.assertOpen(); await this.requiredMembership().select(actor.username, name, selected); return { applied: true } })
  }
  synchronization(actor: CommunityAccountActor) { this.assertAdmin(actor); return { pending: !!this.importIntent?.get() || !!this.packs?.store.list().some(pack => pack.removing !== undefined) || (this.membership?.synchronization().pending ?? false) } }
  retrySynchronization(actor: CommunityAccountActor) {
    return this.serial(async () => { this.assertAdmin(actor); this.assertOpen(); await this.requiredMembership().reconcile(); await this.collect(); return this.synchronization(actor) })
  }
  grantCount(id: string): number { return this.membership?.grantCount(id) ?? 0 }
  group(actor: CommunityAccountActor, id: string) { this.assertAdmin(actor); return this.requiredMembership().group(id) }
  saveGrants(actor: CommunityAccountActor, id: string, names: readonly string[], revision: string, packs?: readonly string[]) {
    return this.serial(async () => { this.assertAdmin(actor); this.assertOpen(); return await this.requiredMembership().save(id, names, revision, packs) })
  }
  prepare(username: string): Promise<void> {
    return this.serial(async () => {
      const account = this.accounts.get(username)
      if (!account || account.disabled) throw new CommunityAuthenticationError('Sign in is required', 'sign-in-required')
      await this.membership?.reconcile()
    })
  }
  recover(): Promise<void> {
    return this.serial(async () => {
      await this.artifacts.recover?.()
      for (const row of this.store.list()) {
        const conflict = this.bundledNames.includes(row.name)
        if (!!row.conflict !== conflict) this.store.save({ ...row, conflict })
      }
      for (const pack of this.packs?.store.list() ?? []) {
        const conflict = this.bundledNames.includes(pack.name) || this.store.list().some(skill => skill.name === pack.name)
        if (pack.note && !!pack.note.conflict !== conflict) this.packs!.store.save({ ...pack, note: { ...pack.note, conflict } })
      }
      await this.membership?.reconcile(); await this.collect()
    })
  }
  mutate<T>(run: () => Promise<T>): Promise<T> {
    return this.serial(async () => {
      this.assertOpen()
      try { const result = await run(); await this.finishPackRemovals(); await this.membership?.reconcile(); return result }
      finally { await this.collect() }
    })
  }
  private requiredMembership(): SkillMembership { if (!this.membership) throw new BusinessRuleError('missing', 'Skills are unavailable.', 'skill-unavailable'); return this.membership }
  private impact(name: string) { return this.membership?.impact(name) ?? { managedMembers: 0, selectedMembers: 0 } }
  async stop(): Promise<void> {
    this.stopped = true; for (const controller of this.intake) controller.abort(); await this.tail; this.pending.clear(); this.imports.clear(); this.completedImports.clear(); await this.collect()
  }
  private expire(): void { for (const [token, row] of this.completedImports) if (row.expires <= this.clock.now()) this.completedImports.delete(token); for (const [token, row] of this.imports) if (row.expires <= this.clock.now()) this.imports.delete(token); for (const [token, row] of this.pending) if (row.expires <= this.clock.now()) this.pending.delete(token) }
  private assertOpen(): void { if (this.stopped) throw new BusinessRuleError('conflict', 'Skill library is stopping.', 'skill-unavailable') }
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      if (this.packs?.store.list().some(pack => pack.renamedFrom)) await this.requiredMembership().reconcile()
      await this.finishPackRemovals()
      await this.finishImport()
      return run()
    })
    this.tail = result.catch(() => {}); return result
  }
  private sameActor(left: CommunityAccountActor, right: CommunityAccountActor): boolean { return left.username === right.username && left.spaceId === right.spaceId && left.sessionEpoch === right.sessionEpoch }
  private async finishPackRemovals(): Promise<void> {
    const pending = this.packs?.store.list().filter(pack => pack.removing !== undefined) ?? []
    if (!pending.length) return
    try {
      for (const pack of pending) {
        for (const name of pack.removing!) this.store.remove(name)
        this.packs!.store.remove(pack.name)
      }
      await this.membership?.reconcile()
      await this.collect()
    } catch { throw new BusinessRuleError('conflict', 'The approved pack deletion is incomplete. Retry synchronization.', 'skill-sync-failed') }
  }
  private async finishImport(): Promise<void> {
    const intent = this.importIntent?.get()
    if (!intent) return
    try {
      for (const name of intent.removals ?? []) this.store.remove(name)
      for (const skill of intent.skills) this.store.save(skill)
      for (const pack of intent.packs) this.packs!.store.save(pack)
      await this.membership?.reconcile()
      this.importIntent!.clear()
      this.imports.delete(intent.token)
      this.completedImports.set(intent.token, { actor: intent.actor, expires: this.clock.now() + 30 * 60 * 1000 })
      await this.collect()
    } catch { throw new BusinessRuleError('conflict', 'The approved import is incomplete. Retry synchronization.', 'skill-sync-failed') }
  }
  private collect(): Promise<void> { return this.artifacts.collect([...(this.importIntent?.get()?.skills.map(row => row.hash) ?? []), ...(this.importIntent?.get()?.packs.flatMap(pack => pack.note ? [pack.note.hash] : []) ?? []), ...this.store.list().map(row => row.hash), ...[...this.imports.values()].flatMap(preview => preview.bundle.candidates.map(row => row.hash)), ...(this.packs?.store.list().flatMap(pack => pack.note ? [pack.note.hash] : []) ?? []), ...[...this.pending.values()].map(row => row.upload.hash)]) }
  private revision(name: string): string { return JSON.stringify([this.store.list().find(row => row.name === name) ?? null, this.membership?.revision(name), this.packs?.store.list().filter(pack => pack.skills.includes(name) || pack.note?.name === name)]) }
  private view(row: LibrarySkill): CommunitySkillView { return { ...row, ...this.impact(row.name), packs: this.packs?.store.list().filter(pack => pack.skills.includes(row.name)).map(pack => pack.name) ?? [] } }
  private required(name: string): LibrarySkill {
    const row = this.store.list().find(item => item.name === name)
    if (!row) throw new BusinessRuleError('missing', 'Skill was not found.', 'skill-unavailable')
    return row
  }
  private current(actor: CommunityAccountActor) {
    const account = this.accounts.get(actor.username)
    if (!account || account.disabled || account.spaceId !== actor.spaceId || account.sessionEpoch !== actor.sessionEpoch)
      throw new CommunityAuthenticationError('Sign in is required', 'sign-in-required')
    return account
  }
  private assertAdmin(actor: CommunityAccountActor): void {
    if (!this.current(actor).admin) throw new BusinessRuleError('forbidden', 'Administrator access is required', 'admin-required')
  }
}
