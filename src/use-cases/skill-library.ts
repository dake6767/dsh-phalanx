import type { CommunitySkillDetail, CommunitySkillPreview, CommunitySkillView } from '../domain/admin-contract.js'
import { BusinessRuleError } from '../domain/business-error.js'
import type { CommunityAccountActor } from '../domain/community-account.js'
import { CommunityAuthenticationError } from '../domain/community-account.js'
import { redactContributionContent, redactContributionDeclaration } from '../domain/contribution-checks.js'
import { administratorLibraryVersion, libraryContributionProvenance, type LibraryContributionAdoption } from '../domain/library-contribution.js'
import { PlatformDatabaseError } from '../domain/platform-database.js'
import type { RuntimeDependencyVersion } from '../domain/runtime-dependency.js'
import type { LibrarySkill, UploadedSkill } from '../domain/skill-library.js'
import type { Clock } from '../ports/clock.js'
import type { CommunityAccountStorePort } from '../ports/community-accounts.js'
import type { ExpertReferencesPort } from '../ports/experts.js'
import type { MemberSkillNamesPort } from '../ports/member-skills.js'
import type { SkillArtifactsPort, SkillLibraryStorePort } from '../ports/skill-library.js'
import type { SkillPackState } from '../ports/skill-packs.js'
import type { SkillRepositories, SkillUnitOfWork } from '../ports/skill-unit-of-work.js'
import type { RuntimeDependencies } from './runtime-dependencies.js'
import { SkillContributionPolicy } from './skill-contribution-policy.js'
import { SkillLibraryCatalog } from './skill-library-catalog.js'
import { SkillLibraryImports } from './skill-library-imports.js'
import { SkillLibraryRemoval } from './skill-library-removal.js'
import type { SkillMembership } from './skill-membership.js'

/** Serializes skill intake, confirmation and artifact collection. */
export class SkillLibrary {
  private readonly removal: SkillLibraryRemoval
  private readonly pending = new Map<string, { actor: CommunityAccountActor; upload: UploadedSkill; revision: string; expires: number }>()
  private readonly imports: SkillLibraryImports
  private readonly intake = new Set<AbortController>()
  private readonly contributions: SkillContributionPolicy
  private readonly catalog: SkillLibraryCatalog
  prepareSuiteImport: SkillLibraryCatalog['prepareSuiteImport']
  commitSuiteSkills: SkillLibraryCatalog['commitSuiteSkills']
  suiteSkills: SkillLibraryCatalog['suiteSkills']
  readonly preparedSuiteImport: SkillLibraryCatalog['preparedSuiteImport']
  readonly withSuiteNotes: SkillLibraryCatalog['withSuiteNotes']
  private stopped = false
  private tail: Promise<unknown> = Promise.resolve()
  constructor(
    private readonly accounts: Pick<CommunityAccountStorePort, 'get'>,
    private readonly store: SkillLibraryStorePort,
    private readonly artifacts: SkillArtifactsPort,
    private readonly clock: Clock,
    private readonly membership?: SkillMembership,
    private readonly memberNames?: MemberSkillNamesPort,
    private readonly bundledNames: readonly string[] = [],
    private readonly packs?: SkillPackState,
    private readonly work?: SkillUnitOfWork,
    private readonly runtimeDependencies?: Pick<RuntimeDependencies, 'readReady'> & Partial<Pick<RuntimeDependencies, 'list'>>,
    private readonly executionSources?: { sourceVersions(): readonly string[] },
    private readonly expertReferences?: ExpertReferencesPort,
  ) {
    this.removal = new SkillLibraryRemoval(expertReferences, store, membership, packs, operation => this.transaction(operation))
    this.contributions = new SkillContributionPolicy(store, membership, runtimeDependencies, {
      assertAdmin: actor => this.assertAdmin(actor),
      group: (actor, id) => this.group(actor, id),
    })
    this.catalog = new SkillLibraryCatalog(store, artifacts, clock, membership, {
      run: operation => this.serial(operation),
      transaction: operation => this.transaction(operation),
      assertOpen: () => this.assertOpen(),
      collect: () => this.collect(),
    })
    this.prepareSuiteImport = this.catalog.prepareSuiteImport.bind(this.catalog)
    this.commitSuiteSkills = this.catalog.commitSuiteSkills.bind(this.catalog)
    this.suiteSkills = this.catalog.suiteSkills.bind(this.catalog)
    this.preparedSuiteImport = this.catalog.preparedSuiteImport.bind(this.catalog)
    this.withSuiteNotes = this.catalog.withSuiteNotes.bind(this.catalog)
    this.imports = new SkillLibraryImports(store, artifacts, clock, bundledNames, packs, {
      intake: this.intake,
      run: operation => this.serial(operation),
      transaction: operation => this.transaction(operation),
      assertAdmin: actor => this.assertAdmin(actor),
      assertOpen: () => this.assertOpen(),
      expire: () => this.expire(),
      collect: () => this.collect(),
      revision: name => this.removal.revision(name),
      impact: name => this.impact(name),
      reconcile: async () => {
        await this.membership?.reconcile()
      },
    })
  }
  transaction<T>(operation: (repositories: SkillRepositories) => Promise<T>): Promise<T> {
    if (!this.work) throw new BusinessRuleError('conflict', 'Skill transactions are unavailable.', 'skill-unavailable')
    return this.work.run(async repositories => {
      const result = await operation(repositories)
      await this.membership?.pruneSelections(repositories)
      return result
    })
  }
  contributionDependencies(...args: Parameters<SkillContributionPolicy['contributionDependencies']>) {
    return this.contributions.contributionDependencies(...args)
  }
  validateContributionDependencies(...args: Parameters<SkillContributionPolicy['validateContributionDependencies']>) {
    return this.contributions.validateContributionDependencies(...args)
  }
  contributionGroups(...args: Parameters<SkillContributionPolicy['contributionGroups']>) {
    return this.contributions.contributionGroups(...args)
  }
  validateContributionDistribution(...args: Parameters<SkillContributionPolicy['validateContributionDistribution']>) {
    return this.contributions.validateContributionDistribution(...args)
  }
  async list(actor: CommunityAccountActor): Promise<readonly CommunitySkillView[]> {
    await this.assertAdmin(actor)
    return Promise.all((await this.store.list()).map(row => this.view(row)))
  }
  async detail(actor: CommunityAccountActor, name: string): Promise<CommunitySkillDetail> {
    return this.serial(async () => {
      await this.assertAdmin(actor)
      const row = await this.required(name)
      const contents = await this.artifacts.read(row.hash)
      await this.assertAdmin(actor)
      const expertImpact = await this.expertReferences?.impact([{ kind: 'skill', name }])
      const result = {
        ...(await this.view(row)),
        ...contents,
        experts: expertImpact?.experts ?? [],
        revision: await this.removal.revision(name, expertImpact, row),
      }
      return row.contributionReceipt ? redactContributionDeclaration(result) : result
    })
  }
  setRuntimeDependencies(actor: CommunityAccountActor, name: string, names: readonly string[], revision: string): Promise<CommunitySkillView> {
    return this.serial(async () => {
      await this.assertAdmin(actor)
      this.assertOpen()
      const row = await this.required(name)
      this.assertNotSuite(row)
      if ((await this.removal.revision(name)) !== revision)
        throw new BusinessRuleError('conflict', 'Review the skill again before confirming.', 'skill-preview-changed')
      if (!Array.isArray(names) || names.some(value => typeof value !== 'string') || new Set(names).size !== names.length || !this.runtimeDependencies)
        throw new BusinessRuleError('invalid', 'Select existing runtime dependencies.', 'runtime-dependency-invalid')
      await this.runtimeDependencies.readReady(names)
      await this.store.save({ ...row, runtimeDependencies: [...names] })
      await this.membership?.reconcile()
      return await this.view(await this.required(name))
    })
  }
  upload(actor: CommunityAccountActor, content: AsyncIterable<Uint8Array>, signal: AbortSignal): Promise<CommunitySkillPreview> {
    const controller = new AbortController()
    this.intake.add(controller)
    signal = AbortSignal.any([signal, controller.signal])
    return this.serial(async () => {
      await this.assertAdmin(actor)
      this.assertOpen()
      signal.throwIfAborted()
      this.expire()
      await this.collect()
      try {
        const upload = await this.artifacts.accept(content, signal)
        signal.throwIfAborted()
        await this.assertAdmin(actor)
        this.assertOpen()
        if ((await this.packs?.store.list())?.some(pack => pack.note?.name === upload.name))
          throw new BusinessRuleError('conflict', 'The orchestration skill name is already in use.', 'skill-pack-name-conflict')
        const revision = await this.removal.revision(upload.name),
          token = this.artifacts.newToken()
        this.pending.set(token, { actor, upload, revision, expires: this.clock.now() + 30 * 60 * 1000 })
        return { ...upload, token, revision, replacing: (await this.store.list()).some(row => row.name === upload.name), ...(await this.impact(upload.name)) }
      } finally {
        await this.collect()
      }
    }).finally(() => {
      this.intake.delete(controller)
    })
  }
  previewImport(...args: Parameters<SkillLibraryImports['previewImport']>) {
    return this.imports.previewImport(...args)
  }
  previewGit(...args: Parameters<SkillLibraryImports['previewGit']>) {
    return this.imports.previewGit(...args)
  }
  confirmImport(...args: Parameters<SkillLibraryImports['confirmImport']>) {
    return this.imports.confirmImport(...args)
  }
  confirm(
    actor: CommunityAccountActor,
    token: string,
    revision: string,
    contribution?: {
      readonly id: string
      readonly revision: string
      readonly committed: () => void
      readonly commit?: (skill: LibrarySkill) => Promise<void>
      readonly adoption?: LibraryContributionAdoption
    },
  ): Promise<CommunitySkillView> {
    return this.serial(async () => {
      await this.assertAdmin(actor)
      this.assertOpen()
      this.expire()
      const preview = this.pending.get(token)
      if (
        !preview ||
        preview.actor.username !== actor.username ||
        preview.actor.spaceId !== actor.spaceId ||
        preview.actor.sessionEpoch !== actor.sessionEpoch ||
        preview.revision !== revision ||
        (await this.removal.revision(preview.upload.name)) !== revision
      )
        throw new BusinessRuleError('conflict', 'Review the skill again before confirming.', 'skill-preview-changed')
      const { name, description, hash } = preview.upload
      const existing = (await this.store.list()).find(item => item.name === name)
      if (existing?.suiteOrigin)
        throw new BusinessRuleError('forbidden', 'Suite catalog entries are read-only. Uninstall the suite or detach the entry first.', 'suite-entry-locked')
      if (
        contribution?.adoption &&
        (await this.accounts.get(contribution.adoption.row.contributor.username))?.spaceId !== contribution.adoption.row.contributor.spaceId
      )
        throw new BusinessRuleError('conflict', 'The contributor account changed.', 'contribution-unavailable')
      if (contribution?.adoption?.runtimeDependencies)
        await this.validateContributionDependencies(actor, contribution.adoption.row, contribution.adoption.runtimeDependencies)
      const provenance = contribution?.adoption
        ? libraryContributionProvenance(existing?.provenance, contribution.adoption, !!existing)
        : administratorLibraryVersion(existing?.provenance, hash, hash, actor, this.clock.now(), preview.upload.fileHashes)
      const row: LibrarySkill = {
        ...(existing?.runtimeDependencies ? { runtimeDependencies: existing.runtimeDependencies } : {}),
        ...(contribution?.adoption?.runtimeDependencies ? { runtimeDependencies: contribution.adoption.runtimeDependencies } : {}),
        provenance,
        ...(existing?.rowRevision !== undefined ? { rowRevision: existing.rowRevision } : {}),
        name,
        description: contribution ? redactContributionContent(description) : description,
        hash,
        ...(contribution ? { contributionReceipt: { id: contribution.id, revision: contribution.revision } } : {}),
        importedAt: this.clock.now(),
        published: (await this.store.list()).find(item => item.name === name)?.published ?? false,
      }
      if (contribution?.commit) await contribution.commit(row)
      else await this.store.save(row)
      contribution?.committed()
      this.pending.delete(token)
      await this.membership?.reconcile()
      await this.collect()
      return await this.view(row)
    })
  }
  remove(actor: CommunityAccountActor, name: string, revision: string): Promise<void> {
    return this.serial(async () => {
      await this.assertAdmin(actor)
      this.assertOpen()
      const row = await this.required(name)
      this.assertNotSuite(row)
      await this.removal.remove(row, revision)
      await this.membership?.reconcile()
      await this.collect()
    })
  }
  cancel(actor: CommunityAccountActor, token: string): Promise<void> {
    return this.serial(async () => {
      await this.assertAdmin(actor)
      const row = this.pending.get(token)
      if (row?.actor.username === actor.username && row.actor.spaceId === actor.spaceId && row.actor.sessionEpoch === actor.sessionEpoch)
        this.pending.delete(token)
      this.imports.cancel(actor, token)
      this.expire()
      await this.collect()
    })
  }
  publish(actor: CommunityAccountActor, name: string, published: boolean, revision: string) {
    return this.serial(async () => {
      await this.assertAdmin(actor)
      this.assertOpen()
      const row = await this.required(name)
      this.assertNotSuite(row)
      if (revision !== (await this.removal.revision(name)))
        throw new BusinessRuleError('conflict', 'Review the skill again before confirming.', 'skill-preview-changed')
      if (published && row.conflict) throw new BusinessRuleError('conflict', 'Skills are unavailable.', 'skill-unavailable')
      await this.transaction(repositories => repositories.library.save({ ...row, published }))
      await this.membership?.reconcile()
      return await this.view(await this.required(name))
    })
  }
  market(actor: CommunityAccountActor) {
    return this.serial(async () => {
      await this.current(actor)
      const names = (await this.memberNames?.names(actor.username)) ?? []
      await this.current(actor)
      return { skills: await this.requiredMembership().market(actor.username, names), ...this.requiredMembership().synchronization() }
    })
  }
  marketDetail(actor: CommunityAccountActor, name: string) {
    return this.serial(async () => {
      await this.current(actor)
      const names = (await this.memberNames?.names(actor.username)) ?? []
      const skill = (await this.requiredMembership().market(actor.username, names)).find(row => row.name === name)
      if (!skill) throw new BusinessRuleError('missing', 'Skills are unavailable.', 'skill-unavailable')
      const contents = await this.artifacts.read((await this.required(name)).hash)
      await this.current(actor)
      const current = (await this.requiredMembership().market(actor.username, names)).find(row => row.name === name)
      if (!current) throw new BusinessRuleError('missing', 'Skills are unavailable.', 'skill-unavailable')
      const detail = { ...current, ...contents }
      return (await this.required(name)).contributionReceipt ? redactContributionDeclaration(detail) : detail
    })
  }
  select(actor: CommunityAccountActor, name: string, selected: boolean) {
    return this.serial(async () => {
      await this.current(actor)
      this.assertOpen()
      await this.requiredMembership().select(actor.username, name, selected)
      return { applied: true }
    })
  }
  async synchronization(actor: CommunityAccountActor) {
    await this.assertAdmin(actor)
    return {
      pending: this.membership?.synchronization().pending ?? false,
    }
  }
  retrySynchronization(actor: CommunityAccountActor) {
    return this.serial(async () => {
      await this.assertAdmin(actor)
      this.assertOpen()
      await this.requiredMembership().reconcile()
      await this.collect()
      return await this.synchronization(actor)
    })
  }
  async grantCount(id: string): Promise<number> {
    return (await this.membership?.grantCount(id)) ?? 0
  }
  async group(actor: CommunityAccountActor, id: string) {
    await this.assertAdmin(actor)
    return await this.requiredMembership().group(id)
  }
  saveGrants(actor: CommunityAccountActor, id: string, names: readonly string[], revision: string, packs?: readonly string[]) {
    return this.serial(async () => {
      await this.assertAdmin(actor)
      this.assertOpen()
      return await this.requiredMembership().save(id, names, revision, packs)
    })
  }
  commitSuiteUpdate(...args: Parameters<SkillLibraryCatalog['commitSuiteUpdate']>) {
    return this.catalog.commitSuiteUpdate(...args)
  }
  dropSuiteSkills(...args: Parameters<SkillLibraryCatalog['dropSuiteSkills']>) {
    return this.catalog.dropSuiteSkills(...args)
  }
  restoreSuiteUpdate(...args: Parameters<SkillLibraryCatalog['restoreSuiteUpdate']>) {
    return this.catalog.restoreSuiteUpdate(...args)
  }
  discardSuiteImport(...args: Parameters<SkillLibraryCatalog['discardSuiteImport']>) {
    return this.catalog.discardSuiteImport(...args)
  }
  suiteSkillConflicts(...args: Parameters<SkillLibraryCatalog['suiteSkillConflicts']>) {
    return this.catalog.suiteSkillConflicts(...args)
  }
  suiteReplaceable(...args: Parameters<SkillLibraryCatalog['suiteReplaceable']>) {
    return this.catalog.suiteReplaceable(...args)
  }
  restoreSuiteSkills(...args: Parameters<SkillLibraryCatalog['restoreSuiteSkills']>) {
    return this.catalog.restoreSuiteSkills(...args)
  }

  detachSuiteSkill(...args: Parameters<SkillLibraryCatalog['detachSuiteSkill']>) {
    return this.catalog.detachSuiteSkill(...args)
  }
  removeSuiteSkills(...args: Parameters<SkillLibraryCatalog['removeSuiteSkills']>) {
    return this.catalog.removeSuiteSkills(...args)
  }
  prepare(username: string, dependencies?: readonly RuntimeDependencyVersion[]): Promise<void> {
    return this.serial(async () => {
      const account = await this.accounts.get(username)
      if (!account || account.disabled) throw new CommunityAuthenticationError('Sign in is required', 'sign-in-required')
      await this.membership?.reconcile(true, dependencies ? { spaceId: account.spaceId, versions: dependencies } : undefined)
    })
  }
  /** Rebuild derived member directories from current facts without replaying an adoption. */
  synchronizeContribution(): Promise<void> {
    return this.serial(async () => {
      await this.membership?.reconcile(true)
      await this.collect()
    })
  }
  recover(): Promise<void> {
    return this.serial(async () => {
      await this.artifacts.recover?.()
      for (const row of await this.store.list()) {
        const conflict = this.bundledNames.includes(row.name)
        if (!!row.conflict !== conflict) await this.store.save({ ...row, conflict })
      }
      for (const pack of (await this.packs?.store.list()) ?? []) {
        const conflict = this.bundledNames.includes(pack.name) || (await this.store.list()).some(skill => skill.name === pack.name)
        if (pack.note && !!pack.note.conflict !== conflict) await this.packs!.store.save({ ...pack, note: { ...pack.note, conflict } })
      }
      await this.membership?.reconcile()
      await this.collect()
    })
  }
  mutate<T>(run: () => Promise<T>): Promise<T> {
    return this.serial(async () => {
      this.assertOpen()
      try {
        const result = await run()
        await this.membership?.reconcile()
        return result
      } finally {
        await this.collect()
      }
    })
  }
  private requiredMembership(): SkillMembership {
    if (!this.membership) throw new BusinessRuleError('missing', 'Skills are unavailable.', 'skill-unavailable')
    return this.membership
  }
  private async impact(name: string) {
    return (await this.membership?.impact(name)) ?? { managedMembers: 0, selectedMembers: 0 }
  }
  async stop(): Promise<void> {
    this.stopped = true
    for (const controller of this.intake) controller.abort()
    await this.tail
    this.pending.clear()
    this.imports.clear()
    try {
      await this.collect()
    } catch (error) {
      // Without authoritative references, preserve artifacts for recovery instead of masking startup failure.
      if (!(error instanceof PlatformDatabaseError) || error.code !== 'unavailable') throw error
    }
  }
  private expire(): void {
    this.imports.expire()
    for (const [token, row] of this.pending) if (row.expires <= this.clock.now()) this.pending.delete(token)
  }
  private assertOpen(): void {
    if (this.stopped) throw new BusinessRuleError('conflict', 'Skill library is stopping.', 'skill-unavailable')
  }
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const result = this.tail.then(run)
    this.tail = result.catch(() => {})
    return result
  }
  private async collect(): Promise<void> {
    return this.artifacts.collect([
      ...(this.executionSources?.sourceVersions() ?? []),
      ...(await this.store.list()).map(row => row.hash),
      ...this.imports.retained(),
      ...((await this.packs?.store.list())?.flatMap(pack => (pack.note ? [pack.note.hash] : [])) ?? []),
      ...[...this.pending.values()].map(row => row.upload.hash),
      ...this.catalog.retained(),
    ])
  }

  setMaintainer(actor: CommunityAccountActor, name: string, username: string | null, revision: string): Promise<CommunitySkillView> {
    return this.serial(async () => {
      await this.assertAdmin(actor)
      this.assertOpen()
      const row = await this.required(name)
      this.assertNotSuite(row)
      if (revision !== this.maintenanceRevision(row)) throw new BusinessRuleError('conflict', 'Review the changed skill ownership.', 'skill-preview-changed')
      const target = username === null ? undefined : await this.accounts.get(username)
      if (username !== null && (!target || target.disabled)) throw new BusinessRuleError('invalid', 'Choose a current member.', 'contribution-invalid')
      await this.store.save({
        ...row,
        provenance: {
          anonymous: row.provenance?.anonymous ?? false,
          versions: row.provenance?.versions ?? [],
          maintainer: target ? { username: target.username, spaceId: target.spaceId } : null,
        },
      })
      return await this.view(await this.required(name))
    })
  }
  private maintenanceRevision(row: LibrarySkill) {
    return JSON.stringify([row.hash, row.provenance?.maintainer ?? null, row.provenance?.anonymous ?? false])
  }
  private async view(row: LibrarySkill): Promise<CommunitySkillView> {
    const { rowRevision, contributionReceipt, contributionPublicationReceipt, contributionDistributionReceipt, ...view } = row
    void rowRevision
    void contributionReceipt
    void contributionPublicationReceipt
    void contributionDistributionReceipt
    return {
      ...view,
      maintenanceRevision: this.maintenanceRevision(row),
      ...(await this.impact(row.name)),
      packs: (await this.packs?.store.list())?.filter(pack => pack.skills.includes(row.name)).map(pack => pack.name) ?? [],
    }
  }
  private assertNotSuite(row: LibrarySkill): void {
    if (row.suiteOrigin)
      throw new BusinessRuleError('forbidden', 'Suite catalog entries are read-only. Uninstall the suite or detach the entry first.', 'suite-entry-locked')
  }
  private async required(name: string): Promise<LibrarySkill> {
    const row = (await this.store.list()).find(item => item.name === name)
    if (!row) throw new BusinessRuleError('missing', 'Skill was not found.', 'skill-unavailable')
    return row
  }
  private async current(actor: CommunityAccountActor) {
    const account = await this.accounts.get(actor.username)
    if (!account || account.disabled || account.spaceId !== actor.spaceId || account.sessionEpoch !== actor.sessionEpoch)
      throw new CommunityAuthenticationError('Sign in is required', 'sign-in-required')
    return account
  }
  private async assertAdmin(actor: CommunityAccountActor): Promise<void> {
    if (!(await this.current(actor)).admin) throw new BusinessRuleError('forbidden', 'Administrator access is required', 'admin-required')
  }
}
