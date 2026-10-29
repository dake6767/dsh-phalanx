import { writeSuiteSkills } from './suite-skill-facts.js'
import { BusinessRuleError } from '../domain/business-error.js'
import type { SuiteSkillAssignments } from '../domain/suite-install.js'
import type { LibrarySkill } from '../domain/skill-library.js'
import type { SkillGitTarget } from '../domain/skill-git-source.js'
import type { SkillLibraryStorePort, SkillArtifactsPort } from '../ports/skill-library.js'
import type { SkillUnitOfWork } from '../ports/skill-unit-of-work.js'
import type { Clock } from '../ports/clock.js'
import type { SkillMembership } from './skill-membership.js'

interface CatalogLifecycle {
  run<T>(operation: () => Promise<T>): Promise<T>
  transaction: SkillUnitOfWork['run']
  assertOpen(): void
  collect(): Promise<void>
}
/** Staged artifacts survive until the single library queue commits or discards their catalog operation. */
export class SkillLibraryCatalog {
  private readonly suiteStaged = new Map<string, readonly LibrarySkill[]>()
  constructor(
    private readonly store: SkillLibraryStorePort,
    private readonly artifacts: SkillArtifactsPort,
    private readonly clock: Clock,
    private readonly membership: SkillMembership | undefined,
    private readonly lifecycle: CatalogLifecycle,
  ) {}
  retained(): readonly string[] {
    return [...this.suiteStaged.values()].flat().map(row => row.hash)
  }
  preparedSuiteImport(stageId: string): readonly LibrarySkill[] {
    this.lifecycle.assertOpen()
    const rows = this.suiteStaged.get(stageId)
    if (!rows) throw new BusinessRuleError('conflict', 'This suite import was not prepared.', 'suite-catalog-invalid')
    return structuredClone(rows)
  }
  /** The library queue excludes every artifact collector while notes cross preparation and the final fact commit. */
  withSuiteNotes<T>(
    jobs: readonly { readonly id: string; readonly name: string; readonly description: string; readonly instructions: string }[],
    run: (notes: ReadonlyMap<string, LibrarySkill | undefined>) => Promise<T>,
  ): Promise<T> {
    return this.lifecycle.run(async () => {
      this.lifecycle.assertOpen()
      try {
        const notes = new Map<string, LibrarySkill | undefined>()
        for (const job of jobs) {
          if (!job.instructions.trim()) {
            notes.set(job.id, undefined)
            continue
          }
          if (!this.artifacts.createNote) throw new BusinessRuleError('missing', 'Skill note preparation is unavailable.', 'skill-unavailable')
          const note = await this.artifacts.createNote(job.name, job.description, job.instructions)
          notes.set(job.id, { name: note.name, description: note.description, hash: note.hash, importedAt: this.clock.now(), published: false })
        }
        return await run(notes)
      } finally {
        try {
          await this.lifecycle.collect()
        } catch {
          console.warn('Skill artifact collection deferred; the next collection will retry.')
        }
      }
    })
  }
  /** Suite installs stage Git imports headlessly; rows are written only when the whole install commits. */
  async prepareSuiteImport(
    origin: string,
    source: SkillGitTarget,
    names: readonly string[],
    log: (line: string) => Promise<void>,
    signal: AbortSignal,
    replacing: readonly string[] = [],
    stageId = origin,
  ): Promise<void> {
    return this.lifecycle.run(async () => {
      this.lifecycle.assertOpen()
      signal.throwIfAborted()
      if (!this.artifacts.acceptGit) throw new BusinessRuleError('missing', 'Git import is unavailable.', 'skill-unavailable')
      await this.lifecycle.collect()
      try {
        const bundle = await this.artifacts.acceptGit(source, signal, 'catalog')
        signal.throwIfAborted()
        const rows = names.map(name => {
          const candidate = bundle.candidates.find(row => row.name === name)
          if (!candidate)
            throw new BusinessRuleError('conflict', `The catalog lists skill ${name}, which the pinned source does not provide.`, 'suite-skill-mismatch')
          return candidate
        })
        for (const candidate of rows) {
          const existing = (await this.store.list()).find(skill => skill.name === candidate.name)
          if (existing && existing.suiteOrigin !== origin && !(replacing.includes(existing.name) && !existing.suiteOrigin))
            throw new BusinessRuleError(
              'conflict',
              `Skill ${candidate.name} already exists with a different origin. Remove or rename it first.`,
              'suite-skill-conflict',
              { name: candidate.name },
            )
        }
        this.suiteStaged.set(
          stageId,
          rows.map(candidate => ({
            name: candidate.name,
            description: candidate.description,
            hash: candidate.hash,
            ...(candidate.source ? { source: candidate.source } : {}),
            suiteOrigin: origin,
            importedAt: this.clock.now(),
            published: false,
          })),
        )
        await log(`Staged ${rows.length} skills from the pinned source.`)
      } finally {
        await this.lifecycle.collect()
      }
    })
  }
  /** Runtime dependency names are known only once the install has committed them, so they are attached here. */
  /** `replacing` holds the confirmed manual rows recorded for restore; any other same-name row, or a changed one, refuses the commit. */
  commitSuiteSkills(origin: string, runtimeDependencies: readonly string[] = [], replacing: readonly LibrarySkill[] = []): Promise<readonly LibrarySkill[]> {
    return this.lifecycle.run(async () => {
      this.lifecycle.assertOpen()
      const prepared = this.suiteStaged.get(origin)
      if (!prepared) throw new BusinessRuleError('conflict', 'This suite import was not prepared.', 'suite-catalog-invalid')
      const staged = await this.lifecycle.transaction(repositories =>
        writeSuiteSkills(repositories, origin, prepared, runtimeDependencies, { kind: 'install', replacing }),
      )
      this.suiteStaged.delete(origin)
      await this.membership?.reconcile()
      return structuredClone(staged)
    })
  }
  /** Library rows this suite owns, as an update finds them. */
  async suiteSkills(origin: string): Promise<readonly LibrarySkill[]> {
    return structuredClone((await this.store.list()).filter(row => row.suiteOrigin === origin))
  }
  /** Switches a suite's skills to the staged update in one step: changed rows keep publication, new rows start unpublished,
   * rows the catalog dropped go last through dropSuiteSkills. Skills detached meanwhile are left alone. */
  commitSuiteUpdate(origin: string, runtimeDependencies: readonly string[], stageId = origin): Promise<readonly LibrarySkill[]> {
    return this.lifecycle.run(async () => {
      this.lifecycle.assertOpen()
      const prepared = this.suiteStaged.get(stageId)
      if (!prepared) throw new BusinessRuleError('conflict', 'This suite import was not prepared.', 'suite-catalog-invalid')
      const staged = await this.lifecycle.transaction(repositories => writeSuiteSkills(repositories, origin, prepared, runtimeDependencies, { kind: 'update' }))
      this.suiteStaged.delete(stageId)
      await this.membership?.reconcile()
      return structuredClone(staged)
    })
  }
  /** Removes suite skills a new version dropped, with their grants and selections; the update's last step. */
  dropSuiteSkills(origin: string, names: readonly string[], checkpoint: (assignments: SuiteSkillAssignments) => void): Promise<void> {
    return this.lifecycle.run(async () => {
      const rows = (await this.store.list()).filter(row => row.suiteOrigin === origin && names.includes(row.name))
      const assignments = await this.membership?.snapshotSuiteAssignments(rows.map(row => row.name))
      if (assignments) checkpoint(assignments)
      await this.lifecycle.transaction(async repositories => {
        await repositories.expertReferences?.detach(rows.map(row => ({ kind: 'skill', name: row.name })))
        for (const row of rows) await repositories.library.remove(row.name, row.rowRevision)
      })
      try {
        await this.membership?.reconcile()
      } catch (error) {
        await this.lifecycle.transaction(async repositories => {
          for (const row of rows) {
            const { rowRevision, ...restored } = row
            void rowRevision
            await repositories.library.save(restored)
          }
          if (assignments) await this.membership?.restoreSuiteAssignments(assignments, repositories)
        })
        if (assignments) checkpoint({ grants: [], selections: [], packs: [] })
        throw error
      }
    })
  }
  /** Restores only entries the suite still owns, in one transaction with their associations. */
  restoreSuiteUpdate(origin: string, rows: readonly LibrarySkill[], assignments?: SuiteSkillAssignments): Promise<void> {
    return this.lifecycle.run(async () => {
      await this.lifecycle.transaction(async repositories => {
        const current = await repositories.library.list()
        const removing = current.filter(row => row.suiteOrigin === origin && !rows.some(next => next.name === row.name))
        await repositories.expertReferences?.detach(removing.map(row => ({ kind: 'skill', name: row.name })))
        for (const row of removing) await repositories.library.remove(row.name, row.rowRevision)
        for (const row of rows) {
          const existing = current.find(skill => skill.name === row.name)
          if (!existing || existing.suiteOrigin === origin) {
            const { rowRevision, ...restored } = row
            void rowRevision
            await repositories.library.save({
              ...restored,
              ...(existing ? { ...(existing.rowRevision !== undefined ? { rowRevision: existing.rowRevision } : {}) } : {}),
            })
          }
        }
        if (assignments) await this.membership?.restoreSuiteAssignments(assignments, repositories)
      })
      await this.membership?.reconcile()
      await this.lifecycle.collect()
    })
  }
  discardSuiteImport(origin: string): Promise<void> {
    return this.lifecycle.run(async () => {
      this.suiteStaged.delete(origin)
      await this.lifecycle.collect()
    })
  }
  /** Catalog preview support: names already held by another origin cannot be installed. */
  async suiteSkillConflicts(origin: string, names: readonly string[]): Promise<readonly string[]> {
    const library = await this.store.list()
    return names.filter(name => {
      const row = library.find(skill => skill.name === name)
      return row !== undefined && row.suiteOrigin !== origin
    })
  }
  /** Manual skills with these names imported from the same repository; only these may be replaced by a suite. */
  async suiteReplaceable(names: readonly string[], url: string): Promise<readonly LibrarySkill[]> {
    const normalize = (value: string) =>
      value
        .toLowerCase()
        .replace(/\.git$/u, '')
        .replace(/\/+$/u, '')
    return (await this.store.list())
      .filter(row => names.includes(row.name) && !row.suiteOrigin && row.source !== undefined && normalize(row.source.url) === normalize(url))
      .map(row => structuredClone(row))
  }
  /** Puts replaced manual skill rows back while the install still owns them; their artifacts are retained through the install record. */
  restoreSuiteSkills(origin: string, rows: readonly LibrarySkill[]): Promise<void> {
    return this.lifecycle.run(async () => {
      await this.lifecycle.transaction(async repositories => {
        const current = await repositories.library.list()
        for (const row of rows) {
          const existing = current.find(skill => skill.name === row.name)
          if (existing?.suiteOrigin === origin)
            await repositories.library.save({ ...row, ...(existing.rowRevision !== undefined ? { rowRevision: existing.rowRevision } : {}) })
        }
      })
      await this.membership?.reconcile()
    })
  }
  /** Artifacts that suite install records still hold (replaced rows a failure would restore). */

  /** Detaching keeps the artifact, grants, publication and references; only the suite ownership goes. */
  detachSuiteSkill(origin: string, name: string): Promise<void> {
    return this.lifecycle.run(async () => {
      const row = (await this.store.list()).find(skill => skill.name === name && skill.suiteOrigin === origin)
      if (!row) return
      const { suiteOrigin, ...detached } = row
      void suiteOrigin
      await this.store.save(detached)
    })
  }
  removeSuiteSkills(origin: string): Promise<void> {
    return this.lifecycle.run(async () => {
      await this.lifecycle.transaction(async repositories => {
        const removing = (await repositories.library.list()).filter(row => row.suiteOrigin === origin)
        await repositories.expertReferences?.detach(removing.map(row => ({ kind: 'skill', name: row.name })))
        for (const row of removing) await repositories.library.remove(row.name, row.rowRevision)
      })
      await this.membership?.reconcile()
      await this.lifecycle.collect()
    })
  }
}
