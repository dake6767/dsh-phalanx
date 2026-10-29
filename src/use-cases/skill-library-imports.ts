import { BusinessRuleError } from '../domain/business-error.js'
import type { CommunityAccountActor } from '../domain/community-account.js'
import { parseSkillGitSource, type SkillGitTarget } from '../domain/skill-git-source.js'
import type { SkillImportCandidates } from '../domain/skill-import.js'
import type { SkillPack } from '../domain/skill-pack.js'
import type { CommunitySkillImportInput, CommunitySkillImportPreview } from '../domain/admin-contract.js'
import { administratorLibraryVersion } from '../domain/library-contribution.js'
import type { SkillArtifactsPort, SkillLibraryStorePort } from '../ports/skill-library.js'
import type { SkillPackState } from '../ports/skill-packs.js'
import type { SkillUnitOfWork } from '../ports/skill-unit-of-work.js'
import type { Clock } from '../ports/clock.js'

export interface SkillImportLifecycle {
  readonly intake: Set<AbortController>
  run<T>(operation: () => Promise<T>): Promise<T>
  transaction: SkillUnitOfWork['run']
  assertAdmin(actor: CommunityAccountActor): Promise<void>
  assertOpen(): void
  expire(): void
  collect(): Promise<void>
  revision(name: string): Promise<string>
  impact(name: string): Promise<{ managedMembers: number; selectedMembers: number }>
  reconcile(): Promise<void>
}

/** Preview artifacts live outside transactions; an approved batch registers all facts in one unit. */
export class SkillLibraryImports {
  private readonly previews = new Map<
    string,
    { actor: CommunityAccountActor; bundle: SkillImportCandidates; deleted: readonly string[]; revisions: Readonly<Record<string, string>>; expires: number }
  >()
  private readonly completed = new Map<string, { actor: CommunityAccountActor; expires: number }>()
  constructor(
    private readonly store: SkillLibraryStorePort,
    private readonly artifacts: SkillArtifactsPort,
    private readonly clock: Clock,
    private readonly bundledNames: readonly string[],
    private readonly packs: SkillPackState | undefined,
    private readonly lifecycle: SkillImportLifecycle,
  ) {}
  previewImport(actor: CommunityAccountActor, content: AsyncIterable<Uint8Array>, signal: AbortSignal, filename: string): Promise<CommunitySkillImportPreview> {
    return this.preview(actor, signal, async signal => {
      if (!this.artifacts.acceptImport) throw new BusinessRuleError('missing', 'Import is unavailable.', 'skill-unavailable')
      return { bundle: await this.artifacts.acceptImport(content, signal), filename }
    })
  }
  previewGit(actor: CommunityAccountActor, input: string, signal: AbortSignal, updateName?: string): Promise<CommunitySkillImportPreview> {
    return this.preview(actor, signal, async signal => {
      if (!this.artifacts.acceptGit) throw new BusinessRuleError('missing', 'Git import is unavailable.', 'skill-unavailable')
      const target = updateName ? (await this.required(updateName)).source : parseSkillGitSource(input)
      if (!target) throw new BusinessRuleError('invalid', 'This skill has no Git source.', 'skill-unavailable')
      return {
        bundle: await this.artifacts.acceptGit(target, signal),
        filename: target.url
          .split('/')
          .at(-1)!
          .replace(/\.git$/u, ''),
        target: updateName ? target : undefined,
      }
    })
  }
  private preview(
    actor: CommunityAccountActor,
    signal: AbortSignal,
    load: (signal: AbortSignal) => Promise<{ bundle: SkillImportCandidates; filename: string; target?: SkillGitTarget | undefined }>,
  ): Promise<CommunitySkillImportPreview> {
    const controller = new AbortController()
    this.lifecycle.intake.add(controller)
    signal = AbortSignal.any([signal, controller.signal])
    return this.lifecycle
      .run(async () => {
        await this.lifecycle.assertAdmin(actor)
        this.lifecycle.assertOpen()
        signal.throwIfAborted()
        this.lifecycle.expire()
        await this.lifecycle.collect()
        try {
          const { bundle, filename, target } = await load(signal)
          signal.throwIfAborted()
          await this.lifecycle.assertAdmin(actor)
          this.lifecycle.assertOpen()
          if (!target && !bundle.candidates.length)
            throw new BusinessRuleError('invalid', 'No skills were found in this source.', 'skill-archive-invalid', {
              reason: 'No skills were found in this source.',
            })
          const sameSource = (source?: SkillGitTarget) =>
            !!source && !!target && source.url === target.url && source.subpath === target.subpath && source.ref === target.ref
          const deleted = (await this.store.list())
            .filter(row => sameSource(row.source) && !bundle.candidates.some(candidate => candidate.name === row.name))
            .map(row => row.name)
          const token = this.artifacts.newToken(),
            revisions = Object.fromEntries(
              await Promise.all([...bundle.candidates.map(row => row.name), ...deleted].map(async name => [name, await this.lifecycle.revision(name)])),
            )
          this.completed.delete(token)
          this.previews.set(token, { actor, bundle, deleted, revisions, expires: this.clock.now() + 30 * 60 * 1000 })
          return {
            token,
            ...(target
              ? {
                  updating: true,
                  deleted: await Promise.all(
                    deleted.map(async name => ({
                      name,
                      packs: (await this.packs?.store.list())?.filter(pack => pack.skills.includes(name)).map(pack => pack.name) ?? [],
                      ...(await this.lifecycle.impact(name)),
                    })),
                  ),
                }
              : {}),
            defaultPackName:
              bundle.candidates.find(row => row.orchestration && !row.internal)?.name ??
              (filename
                .replace(/\.zip$/iu, '')
                .toLowerCase()
                .replace(/[^a-z0-9]+/gu, '-')
                .replace(/^-|-$/gu, '')
                .slice(0, 64) ||
                'imported-skills'),
            candidates: await Promise.all(
              bundle.candidates.map(async row => {
                const existing = (await this.store.list()).find(skill => skill.name === row.name)
                return {
                  ...row,
                  replacing: !!existing,
                  ...(await this.lifecycle.impact(row.name)),
                  ...(target
                    ? {
                        change: !existing
                          ? ('added' as const)
                          : sameSource(existing.source) && existing.source!.contentHash === row.source?.contentHash
                            ? ('unchanged' as const)
                            : ('changed' as const),
                      }
                    : {}),
                }
              }),
            ),
            packs: bundle.packs,
          }
        } finally {
          await this.lifecycle.collect()
        }
      })
      .finally(() => {
        this.lifecycle.intake.delete(controller)
      })
  }
  confirmImport(actor: CommunityAccountActor, input: CommunitySkillImportInput): Promise<void> {
    return this.lifecycle.run(async () => {
      await this.lifecycle.assertAdmin(actor)
      this.lifecycle.assertOpen()
      this.lifecycle.expire()
      const completed = this.completed.get(input.token)
      if (completed && this.sameActor(completed.actor, actor)) return await this.lifecycle.reconcile()
      const preview = this.previews.get(input.token)
      const changed = () => new BusinessRuleError('conflict', 'Review the skill again before confirming.', 'skill-preview-changed')
      if (!preview || !this.sameActor(preview.actor, actor)) throw changed()
      const selected = preview.bundle.candidates.filter(row => input.names.includes(row.name)),
        names = new Set(input.names),
        removals = input.removals ?? []
      if (
        (!selected.length && !removals.length) ||
        new Set(removals).size !== removals.length ||
        removals.some(name => !preview.deleted.includes(name) || names.has(name)) ||
        names.size !== input.names.length ||
        selected.length !== names.size ||
        input.packs.length > 64
      )
        throw changed()
      const fresh = async () => {
        for (const name of removals) if ((await this.lifecycle.revision(name)) !== preview.revisions[name]) throw changed()
        for (const row of selected) {
          const current = (await this.store.list()).find(skill => skill.name === row.name)
          if (current?.suiteOrigin)
            throw new BusinessRuleError(
              'forbidden',
              'Suite catalog entries are read-only. Uninstall the suite or detach the entry first.',
              'suite-entry-locked',
            )
          if ((await this.lifecycle.revision(row.name)) !== preview.revisions[row.name] || (current && !input.replacements.includes(row.name))) throw changed()
          if ((await this.packs?.store.list())?.some(pack => pack.note?.name === row.name))
            throw new BusinessRuleError('conflict', 'The orchestration skill name is already in use.', 'skill-pack-name-conflict')
        }
      }
      await fresh()
      const noteNames = input.packs.flatMap(pack => (pack.note ? [pack.note] : []))
      if (noteNames.some(name => names.has(name) || !preview.bundle.candidates.some(row => row.name === name))) throw changed()
      const packNames = new Set<string>(),
        plans: SkillPack[] = []
      for (const pack of input.packs) {
        if (
          !this.packs ||
          !this.artifacts.createNote ||
          !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(pack.name) ||
          pack.name.length > 64 ||
          !pack.description.trim() ||
          pack.description.length > 4096 ||
          packNames.has(pack.name) ||
          (await this.packs.store.list()).some(existing => existing.name === pack.name) ||
          pack.skills.some(name => !names.has(name)) ||
          new Set(pack.skills).size !== pack.skills.length
        )
          throw new BusinessRuleError('invalid', 'Review the skill pack name and selected skills.', 'skill-pack-invalid')
        if (pack.note && (names.has(pack.name) || (await this.store.list()).some(skill => skill.name === pack.name) || this.bundledNames.includes(pack.name)))
          throw new BusinessRuleError('conflict', 'The orchestration skill name is already in use.', 'skill-pack-name-conflict')
        packNames.add(pack.name)
      }
      try {
        for (const pack of input.packs) {
          const instructions = preview.bundle.candidates.find(row => row.name === pack.note)?.markdown ?? ''
          const note = pack.note ? await this.artifacts.createNote!(pack.name, pack.description, instructions) : undefined
          plans.push({
            name: pack.name,
            description: pack.description,
            skills: pack.skills,
            instructions,
            published: false,
            ...(note ? { note: { name: note.name, description: note.description, hash: note.hash, importedAt: this.clock.now(), published: false } } : {}),
          })
        }
        await this.lifecycle.assertAdmin(actor)
        this.lifecycle.assertOpen()
        await fresh()
        const library = await this.store.list()
        const batch = {
          token: input.token,
          actor,
          packs: plans,
          removals,
          skills: selected.map(row => ({
            ...(library.find(skill => skill.name === row.name)?.rowRevision === undefined
              ? {}
              : { rowRevision: library.find(skill => skill.name === row.name)!.rowRevision! }),
            runtimeDependencies: library.find(skill => skill.name === row.name)?.runtimeDependencies ?? [],
            provenance: administratorLibraryVersion(
              library.find(skill => skill.name === row.name)?.provenance,
              row.hash,
              row.hash,
              actor,
              this.clock.now(),
              row.fileHashes,
            ),
            name: row.name,
            description: row.description,
            hash: row.hash,
            ...(row.source ? { source: row.source } : {}),
            importedAt: this.clock.now(),
            published: library.find(skill => skill.name === row.name)?.published ?? false,
          })),
        }
        await this.lifecycle.transaction(async repositories => {
          await repositories.expertReferences?.detach(batch.removals.map(name => ({ kind: 'skill', name })))
          for (const name of batch.removals) await repositories.library.remove(name)
          for (const skill of batch.skills) await repositories.library.save(skill)
          for (const pack of batch.packs) await repositories.packs.store.save(pack)
        })
        this.previews.delete(input.token)
        this.completed.set(input.token, { actor, expires: this.clock.now() + 30 * 60 * 1000 })
        await this.lifecycle.reconcile()
      } finally {
        await this.lifecycle.collect()
      }
    })
  }
  cancel(actor: CommunityAccountActor, token: string): void {
    const preview = this.previews.get(token)
    if (preview && this.sameActor(preview.actor, actor)) this.previews.delete(token)
  }
  expire(): void {
    for (const [token, row] of this.completed) if (row.expires <= this.clock.now()) this.completed.delete(token)
    for (const [token, row] of this.previews) if (row.expires <= this.clock.now()) this.previews.delete(token)
  }
  clear(): void {
    this.previews.clear()
    this.completed.clear()
  }
  retained(): readonly string[] {
    return [...this.previews.values()].flatMap(preview => preview.bundle.candidates.map(row => row.hash))
  }
  private async required(name: string) {
    const skill = (await this.store.list()).find(row => row.name === name)
    if (!skill) throw new BusinessRuleError('missing', 'Skill was not found.', 'skill-unavailable')
    return skill
  }
  private sameActor(left: CommunityAccountActor, right: CommunityAccountActor): boolean {
    return left.username === right.username && left.spaceId === right.spaceId && left.sessionEpoch === right.sessionEpoch
  }
}
