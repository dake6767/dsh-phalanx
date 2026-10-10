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
  private readonly intake = new Set<AbortController>()
  private stopped = false
  private tail: Promise<unknown> = Promise.resolve()
  constructor(private readonly accounts: Pick<CommunityAccountStorePort, 'get'>, private readonly store: SkillLibraryStorePort,
    private readonly artifacts: SkillArtifactsPort, private readonly clock: Clock) {}
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
      const revision = this.revision(upload.name), token = this.artifacts.newToken()
      this.pending.set(token, { actor, upload, revision, expires: this.clock.now() + 30 * 60 * 1000 })
      return { ...upload, token, revision, replacing: this.store.list().some(row => row.name === upload.name), managedMembers: 0, selectedMembers: 0 }
      } finally { await this.collect() }
    }).finally(() => { this.intake.delete(controller) })
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
      await this.collect()
      return this.view(row)
    })
  }
  remove(actor: CommunityAccountActor, name: string, revision: string): Promise<void> {
    return this.serial(async () => {
      this.assertAdmin(actor); this.assertOpen(); this.required(name)
      if (revision !== this.revision(name)) throw new BusinessRuleError('conflict', 'Review the skill again before confirming.', 'skill-preview-changed')
      this.store.remove(name); await this.collect()
    })
  }
  cancel(actor: CommunityAccountActor, token: string): Promise<void> {
    return this.serial(async () => {
      this.assertAdmin(actor)
      const row = this.pending.get(token)
      if (row?.actor.username === actor.username && row.actor.spaceId === actor.spaceId && row.actor.sessionEpoch === actor.sessionEpoch) this.pending.delete(token)
      this.expire(); await this.collect()
    })
  }
  recover(): Promise<void> { return this.serial(() => this.collect()) }
  async stop(): Promise<void> {
    this.stopped = true; for (const controller of this.intake) controller.abort(); await this.tail; this.pending.clear(); await this.collect()
  }
  private expire(): void { for (const [token, row] of this.pending) if (row.expires <= this.clock.now()) this.pending.delete(token) }
  private assertOpen(): void { if (this.stopped) throw new BusinessRuleError('conflict', 'Skill library is stopping.', 'skill-unavailable') }
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const result = this.tail.then(run); this.tail = result.catch(() => {}); return result
  }
  private collect(): Promise<void> { return this.artifacts.collect([...this.store.list().map(row => row.hash), ...[...this.pending.values()].map(row => row.upload.hash)]) }
  private revision(name: string): string { return JSON.stringify(this.store.list().find(row => row.name === name) ?? null) }
  private view(row: LibrarySkill): CommunitySkillView { return { ...row, managedMembers: 0, selectedMembers: 0 } }
  private required(name: string): LibrarySkill {
    const row = this.store.list().find(item => item.name === name)
    if (!row) throw new BusinessRuleError('missing', 'Skill was not found.', 'skill-unavailable')
    return row
  }
  private assertAdmin(actor: CommunityAccountActor): void {
    const account = this.accounts.get(actor.username)
    if (!account || account.disabled || account.spaceId !== actor.spaceId || account.sessionEpoch !== actor.sessionEpoch)
      throw new CommunityAuthenticationError('Sign in is required', 'sign-in-required')
    if (!account.admin) throw new BusinessRuleError('forbidden', 'Administrator access is required', 'admin-required')
  }
}
