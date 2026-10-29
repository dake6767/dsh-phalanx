import type { ContributionPersistence } from '../ports/contribution-persistence.js'
import { validateContributionMaintenance } from '../domain/library-contribution.js'
import type { ContributionPolicyPort } from '../ports/contribution-policy.js'
import { contributionDeclaration, redactContributionDeclaration } from '../domain/contribution-checks.js'
import type { CommunityContributionReview, CommunityContributionInspection, CommunityPluginUpstreamInput } from '../domain/admin-contract.js'
import { CommunityAuthenticationError, type CommunityAccountActor } from '../domain/community-account.js'
import { BusinessRuleError } from '../domain/business-error.js'
import type { ContributionDeclaration, ContributionDecision, MemberContribution } from '../domain/member-contribution.js'
import type { CommunityAccountStorePort } from '../ports/community-accounts.js'
import type { ContributionArtifacts, ContributionAdoption, ContributionMaintenancePort, ContributionExecutionPort } from '../ports/member-contributions.js'
import type { Clock } from '../ports/clock.js'
import type { PluginContributionInput, PluginContributionPort } from '../ports/plugin-contributions.js'
import { ContributionCheckError } from '../domain/contribution-check-error.js'
import { contributionDeclarationTexts, scanContributionCredentials } from '../domain/contribution-checks.js'

/** Owns the private intake lifecycle; library mutation remains with its existing owner. */
export class MemberContributions {
  private readonly reviews = new Map<
    string,
    { actor: CommunityAccountActor; id: string; revision: string; preview: CommunityContributionReview; expires: number }
  >()
  private stopMaintenance: (() => void) | undefined
  private stopped = false
  private readonly intake = new Set<AbortController>()
  private tail: Promise<unknown> = Promise.resolve()
  constructor(
    private readonly accounts: Pick<CommunityAccountStorePort, 'get'>,
    private readonly persistence: ContributionPersistence,
    private readonly artifacts: ContributionArtifacts,
    private readonly adoption: ContributionAdoption,
    private readonly clock: Clock,
    private readonly maintenance?: ContributionMaintenancePort,
    private readonly execution?: ContributionExecutionPort,
    private readonly plugins?: PluginContributionPort,
    private readonly policy?: ContributionPolicyPort,
    private readonly publish?: (kind: 'skill' | 'plugin') => Promise<void>,
  ) {}
  start(): void {
    this.stopMaintenance ??= this.maintenance?.start(() => this.recover())
  }
  async list(actor: CommunityAccountActor, administration = false): Promise<readonly MemberContribution[]> {
    if (administration) await this.admin(actor)
    else await this.current(actor)
    const rows = await this.rows(),
      expired = await Promise.all(rows.map(row => this.expired(row)))
    return rows.filter((row, index) => !expired[index] && (administration || this.sameMember(row.contributor, actor))).map(row => this.publicRow(row))
  }
  submit(
    actor: CommunityAccountActor,
    declaration: ContributionDeclaration,
    content: AsyncIterable<Uint8Array>,
    signal: AbortSignal,
    retainWarnings = false,
  ): Promise<MemberContribution> {
    const controller = new AbortController()
    this.intake.add(controller)
    signal = AbortSignal.any([signal, controller.signal])
    return this.serial(async () => {
      await this.current(actor)
      declaration = contributionDeclaration(declaration)
      try {
        const upload = await this.artifacts.accept(content, signal, declaration, retainWarnings)
        signal.throwIfAborted()
        await this.current(actor)
        await this.execution?.checkContribution(upload.name, declaration)
        await this.policy?.check('skill', actor, upload.name)
        const now = this.clock.now()
        const row: MemberContribution = {
          ...upload,
          revision: this.artifacts.newId(),
          id: this.artifacts.newId(),
          contributor: { username: actor.username, spaceId: actor.spaceId, sessionEpoch: actor.sessionEpoch },
          declaration,
          ...(upload.findings?.length ? { findings: upload.findings, retainedWarnings: retainWarnings } : {}),
          submittedAt: now,
          updatedAt: now,
          status: 'pending',
        }
        return this.publicRow(await this.persistence.actions.submit(actor, row))
      } finally {
        await this.collect()
      }
    }).finally(() => {
      this.intake.delete(controller)
    })
  }
  submitPlugin(
    actor: CommunityAccountActor,
    declaration: ContributionDeclaration,
    input: PluginContributionInput,
    signal: AbortSignal,
    retainWarnings = false,
  ): Promise<MemberContribution> {
    const controller = new AbortController()
    this.intake.add(controller)
    signal = AbortSignal.any([signal, controller.signal])
    return this.serial(async () => {
      await this.current(actor)
      if (!this.plugins) throw new BusinessRuleError('conflict', 'Plugin contributions are unavailable.', 'contribution-unavailable')
      declaration = contributionDeclaration(declaration)
      const findings = scanContributionCredentials(contributionDeclarationTexts(declaration)).findings
      if (findings.some(row => row.severity === 'reject') || (findings.length && !retainWarnings)) throw new ContributionCheckError(findings)
      if (input.source === 'npm') await this.policy?.check('plugin', actor, input.packageName, input.version)
      try {
        const upload = await this.plugins.accept(input, signal, declaration, retainWarnings)
        signal.throwIfAborted()
        await this.current(actor)
        await this.policy?.check('plugin', actor, upload.name, upload.plugin.prepared.version)
        const checked = [...findings, ...(upload.findings ?? [])]
        if (checked.some(row => row.severity === 'reject') || (checked.length && !retainWarnings)) throw new ContributionCheckError(checked)
        const now = this.clock.now()
        const row: MemberContribution = {
          ...upload,
          kind: 'plugin',
          revision: this.artifacts.newId(),
          id: this.artifacts.newId(),
          contributor: { username: actor.username, spaceId: actor.spaceId, sessionEpoch: actor.sessionEpoch },
          declaration,
          findings: checked,
          retainedWarnings: retainWarnings,
          submittedAt: now,
          updatedAt: now,
          status: 'pending',
        }
        return this.publicRow(await this.persistence.actions.submit(actor, row))
      } finally {
        await this.collect()
      }
    }).finally(() => {
      this.intake.delete(controller)
    })
  }
  withdraw(actor: CommunityAccountActor, id: string): Promise<void> {
    return this.serial(async () => {
      await this.current(actor)
      const record = await this.required(id),
        { row } = record
      if (!this.sameMember(row.contributor, actor)) throw new BusinessRuleError('missing', 'Contribution not found.', 'contribution-unavailable')
      this.pending(row)
      await this.persistence.actions.withdraw(actor, record, this.clock.now())
    })
  }
  inspect(actor: CommunityAccountActor, id: string, revision: string): Promise<CommunityContributionInspection> {
    return this.serial(async () => {
      await this.admin(actor)
      const { row } = await this.required(id)
      if (row.revision !== revision) throw new BusinessRuleError('conflict', 'Review the changed contribution.', 'contribution-unavailable')
      const maintenance = this.policy && row.status === 'pending' ? await this.policy.review(row) : undefined
      await this.admin(actor)
      return redactContributionDeclaration(maintenance ? { maintenance } : {})
    })
  }
  review(actor: CommunityAccountActor, id: string, revision: string): Promise<CommunityContributionReview> {
    return this.serial(async () => {
      await this.admin(actor)
      const { row } = await this.required(id)
      this.pending(row)
      if (row.revision !== revision) throw new BusinessRuleError('conflict', 'Review the changed contribution.', 'contribution-unavailable')
      let preview: CommunityContributionReview
      if (row.kind === 'plugin') preview = await this.plugins!.review(actor, row, this.artifacts.newId())
      else {
        const bytes = await this.artifacts.read(row.hash)
        async function* content() {
          yield bytes
        }
        preview = await this.adoption.upload(actor, content(), new AbortController().signal)
      }
      const executionRevision = row.kind !== 'plugin' ? await this.execution?.contributionRevision?.(row.name) : undefined
      if (row.kind !== 'plugin')
        preview = {
          ...preview,
          ...(this.adoption.contributionDependencies ? { dependencies: await this.adoption.contributionDependencies(actor, row.name, row.declaration) } : {}),
          ...(this.adoption.contributionGroups
            ? {
                groups: (await this.adoption.contributionGroups(actor)).map(group => ({
                  group: group.group,
                  members: group.members,
                  revision: group.revision,
                  granted: group.skills.some(skill => skill.name === row.name && skill.granted),
                })),
              }
            : {}),
          ...(this.execution
            ? {
                execution: await this.execution.contributionPreview(row.name, row.declaration),
                ...(executionRevision !== undefined ? { configuration: { execution: executionRevision } } : {}),
                ...(this.execution.contributionRemoved ? { executionRemoved: await this.execution.contributionRemoved(row.name, row.declaration) } : {}),
              }
            : {}),
        }
      if (executionRevision !== undefined && executionRevision !== (await this.execution?.contributionRevision?.(row.name)))
        throw new BusinessRuleError('conflict', 'Review the newer execution settings.', 'skill-preview-changed')
      if (this.policy) preview = { ...preview, maintenance: await this.policy.review(row) }
      await this.admin(actor)
      for (const [token, old] of this.reviews) if (old.id === id) this.reviews.delete(token)
      this.reviews.set(preview.token, { actor: { ...actor }, id, revision, preview, expires: this.clock.now() + 30 * 60 * 1000 })
      return redactContributionDeclaration(
        preview,
        new Set([
          ...(row.declaration.plugin?.environment.map(variable => variable.name) ?? []),
          ...(preview.plugin?.access.environment.map(variable => variable.name) ?? []),
        ]),
      )
    })
  }
  decide(actor: CommunityAccountActor, id: string, decision: ContributionDecision): Promise<void> {
    decision = structuredClone(decision)
    return this.serial(async () => {
      await this.admin(actor)
      const record = await this.required(id),
        { row } = record
      if (decision.revision !== row.revision) throw new BusinessRuleError('conflict', 'This contribution changed. Review it again.', 'contribution-unavailable')
      if (decision.action === 'adopt' && row.status === 'adopted') {
        await this.persistence.actions.replay(actor, record)
        await this.synchronize(row.kind ?? 'skill')
        return
      }
      this.pending(row)
      if (decision.action === 'decline') {
        if (typeof decision.reason !== 'string' || decision.reason.length > 4096)
          throw new BusinessRuleError('invalid', 'Use a reason of at most 4096 characters.', 'contribution-invalid')
        await this.persistence.actions.decline(actor, record, decision.reason, this.clock.now())
        return
      }
      const review = this.reviews.get(decision.token)
      if (
        !review ||
        review.id !== row.id ||
        review.revision !== row.revision ||
        !this.sameMember(review.actor, actor) ||
        review.actor.sessionEpoch !== actor.sessionEpoch
      )
        throw new BusinessRuleError('conflict', 'Review this contribution before adopting.', 'contribution-unavailable')
      const requested =
        row.kind !== 'plugin' && review.preview.dependencies
          ? { ...decision.setup, runtimeDependencies: decision.setup?.runtimeDependencies ?? review.preview.dependencies.references }
          : decision.setup
      const setup = review.preview.configuration ? { ...requested, configuration: review.preview.configuration } : requested
      validateContributionMaintenance(setup?.maintenance)
      await this.policy?.check(row.kind ?? 'skill', row.contributor, row.name, row.plugin?.prepared.version)
      if (row.kind === 'plugin') await this.plugins?.validate?.(actor, row, setup)
      if (row.kind !== 'plugin') {
        if (setup?.runtimeDependencies) await this.adoption.validateContributionDependencies?.(actor, row, setup.runtimeDependencies)
        await this.adoption.validateContributionDistribution?.(actor, setup)
        await this.execution?.checkAdoption(row, setup?.execution, setup?.configuration?.execution)
      }
      if (row.kind === 'plugin')
        await this.plugins!.confirm(
          actor,
          row,
          review.preview,
          () => {},
          setup,
          (plugin, committed) => this.persistence.actions.plugin(actor, record, plugin, setup, this.clock.now(), committed, review.preview.revision),
        )
      else
        await this.adoption.confirm(actor, review.preview.token, review.preview.revision, {
          id: row.id,
          revision: row.revision,
          committed: () => {},
          commit: skill => this.persistence.actions.skill(actor, record, skill, setup, this.clock.now(), review.preview.revision),
          adoption: {
            row,
            ...(setup?.runtimeDependencies ? { runtimeDependencies: setup.runtimeDependencies } : {}),
            ...(setup?.maintenance ? { maintenance: setup.maintenance } : {}),
          },
        })
      this.reviews.delete(decision.token)
      await this.publish?.(row.kind ?? 'skill')
    })
  }
  testPlugin(actor: CommunityAccountActor, id: string, revision: string, token: string, input: CommunityPluginUpstreamInput) {
    return this.serial(async () => {
      await this.admin(actor)
      const { row } = await this.required(id)
      this.pending(row)
      const review = this.reviews.get(token)
      if (
        row.kind !== 'plugin' ||
        row.revision !== revision ||
        !review ||
        review.id !== id ||
        review.revision !== revision ||
        !this.sameMember(review.actor, actor) ||
        review.actor.sessionEpoch !== actor.sessionEpoch
      )
        throw new BusinessRuleError('conflict', 'Review this plugin before testing.', 'contribution-unavailable')
      if (!this.plugins?.test) throw new BusinessRuleError('conflict', 'Upstream testing is unavailable.', 'contribution-unavailable')
      return this.plugins.test(actor, row, input)
    })
  }
  recover(): Promise<void> {
    return this.serial(async () => {
      await this.synchronize('skill')
      await this.collect()
    })
  }
  async stop(): Promise<void> {
    this.stopped = true
    this.stopMaintenance?.()
    for (const controller of this.intake) controller.abort()
    await this.tail
    this.reviews.clear()
  }
  private async synchronize(kind: 'skill' | 'plugin'): Promise<void> {
    if (kind === 'skill') await this.adoption.synchronizeContribution?.()
    await this.publish?.(kind)
  }
  private async expired(row: MemberContribution): Promise<boolean> {
    const account = await this.accounts.get(row.contributor.username)
    return (
      (row.status === 'pending' && (!account || account.spaceId !== row.contributor.spaceId)) ||
      ((row.status === 'declined' || row.status === 'withdrawn') && row.updatedAt <= this.clock.now() - 30 * 24 * 60 * 60 * 1000)
    )
  }
  private async prune(): Promise<void> {
    const records = await this.persistence.rows.list()
    for (const record of records)
      if (await this.expired(record.row)) {
        try {
          await this.persistence.actions.remove(record)
        } catch (error) {
          if (!(error instanceof BusinessRuleError) || error.code !== 'contribution-unavailable') throw error
        }
      }
    for (const [token, review] of this.reviews) {
      const current = await this.persistence.rows.get(review.id),
        row = current?.row
      if (!row || row.status !== 'pending' || row.revision !== review.revision || review.expires <= this.clock.now()) this.reviews.delete(token)
    }
  }
  private async collect(): Promise<void> {
    const rows = await this.rows()
    await this.artifacts.collect(rows.filter(row => row.kind !== 'plugin').map(row => row.hash))
    await this.plugins?.collect(rows)
  }
  private publicRow(row: MemberContribution): MemberContribution {
    const { plugin: privateArtifact, ...publicRow } = row
    void privateArtifact
    return redactContributionDeclaration(publicRow, new Set(row.declaration.plugin?.environment.map(variable => variable.name)))
  }
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      if (this.stopped) throw new BusinessRuleError('conflict', 'Contributions are stopping.', 'contribution-unavailable')
      await this.prune()
      return run()
    })
    this.tail = result.catch(() => {})
    return result
  }
  private sameMember(left: CommunityAccountActor, right: CommunityAccountActor) {
    return left.username === right.username && left.spaceId === right.spaceId
  }
  private async rows(): Promise<readonly MemberContribution[]> {
    return (await this.persistence.rows.list()).map(record => record.row)
  }
  private async required(id: string) {
    const record = await this.persistence.rows.get(id)
    if (!record) throw new BusinessRuleError('missing', 'Contribution not found.', 'contribution-unavailable')
    return record
  }
  private pending(row: MemberContribution) {
    if (row.status !== 'pending') throw new BusinessRuleError('conflict', 'Contribution is no longer pending.', 'contribution-unavailable')
  }
  private async current(actor: CommunityAccountActor) {
    const account = await this.accounts.get(actor.username)
    if (!account || account.disabled || !this.sameMember(account, actor) || account.sessionEpoch !== actor.sessionEpoch)
      throw new CommunityAuthenticationError('Sign in is required', 'sign-in-required')
    return account
  }
  private async admin(actor: CommunityAccountActor) {
    if (!(await this.current(actor)).admin) throw new BusinessRuleError('forbidden', 'Administrator access is required', 'admin-required')
  }
}
