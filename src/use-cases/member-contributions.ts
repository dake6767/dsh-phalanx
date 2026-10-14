import { validateContributionMaintenance } from '../domain/library-contribution.js'
import type { ContributionPolicyPort } from '../ports/contribution-policy.js'
import { contributionDeclaration, redactContributionDeclaration } from '../domain/contribution-checks.js'
import type { CommunityContributionReview, CommunityContributionInspection, CommunityPluginUpstreamInput } from '../domain/admin-contract.js'
import { CommunityAuthenticationError, type CommunityAccountActor } from '../domain/community-account.js'
import { BusinessRuleError } from '../domain/business-error.js'
import type { ContributionDeclaration, ContributionDecision, MemberContribution } from '../domain/member-contribution.js'
import type { CommunityAccountStorePort } from '../ports/community-accounts.js'
import type { ContributionStore, ContributionArtifacts, ContributionAdoption, ContributionMaintenancePort, ContributionExecutionPort } from '../ports/member-contributions.js'
import type { Clock } from '../ports/clock.js'
import type { PluginContributionInput, PluginContributionPort } from '../ports/plugin-contributions.js'
import { ContributionCheckError } from '../domain/contribution-check-error.js'
import { contributionDeclarationTexts, scanContributionCredentials } from '../domain/contribution-checks.js'

/** Owns the private intake lifecycle; library mutation remains with its existing owner. */
export class MemberContributions {
  private readonly reviews = new Map<string, { actor: CommunityAccountActor, id: string, revision: string, preview: CommunityContributionReview, expires: number }>()
  private stopMaintenance: (() => void) | undefined
  private stopped = false
  private readonly intake = new Set<AbortController>()
  private tail: Promise<unknown> = Promise.resolve()
  constructor(private readonly accounts: Pick<CommunityAccountStorePort, 'get'>, private readonly store: ContributionStore,
    private readonly artifacts: ContributionArtifacts, private readonly adoption: ContributionAdoption, private readonly clock: Clock, private readonly maintenance?: ContributionMaintenancePort, private readonly execution?: ContributionExecutionPort, private readonly plugins?: PluginContributionPort, private readonly policy?: ContributionPolicyPort) {}
  start(): void { this.stopMaintenance ??= this.maintenance?.start(() => this.recover()) }
  list(actor: CommunityAccountActor, administration = false): readonly MemberContribution[] {
    if (administration) this.admin(actor); else this.current(actor)
    return this.store.list().filter(row => !this.expired(row) && (administration || this.sameMember(row.contributor, actor))).map(row => this.publicRow(row))
  }
  submit(actor: CommunityAccountActor, declaration: ContributionDeclaration, content: AsyncIterable<Uint8Array>, signal: AbortSignal, retainWarnings = false): Promise<MemberContribution> {
    const controller = new AbortController(); this.intake.add(controller)
    signal = AbortSignal.any([signal, controller.signal])
    return this.serial(async () => {
      this.current(actor)
      declaration = contributionDeclaration(declaration)
      try {
        const upload = await this.artifacts.accept(content, signal, declaration, retainWarnings)
        signal.throwIfAborted(); this.current(actor); this.execution?.checkContribution(upload.name, declaration); this.policy?.check('skill', actor, upload.name)
        const pending = this.store.list().filter(row => row.status === 'pending' && this.sameMember(row.contributor, actor))
        const previous = pending.find(row => row.kind !== 'plugin' && row.name === upload.name)
        if (!previous && pending.length >= 20) throw new BusinessRuleError('conflict', 'Withdraw a pending contribution or wait for review; the limit is 20.', 'contribution-limit')
        const now = this.clock.now()
        const row: MemberContribution = { ...upload, revision: this.artifacts.newId(), id: previous?.id ?? this.artifacts.newId(), contributor: { username: actor.username, spaceId: actor.spaceId, sessionEpoch: actor.sessionEpoch }, declaration, ...(upload.findings?.length ? { findings: upload.findings, retainedWarnings: retainWarnings } : {}), submittedAt: now, updatedAt: now, status: 'pending' }
        this.store.save(row)
        return redactContributionDeclaration(row)
      } finally { await this.collect() }
    }).finally(() => { this.intake.delete(controller) })
  }
  submitPlugin(actor: CommunityAccountActor, declaration: ContributionDeclaration, input: PluginContributionInput, signal: AbortSignal, retainWarnings = false): Promise<MemberContribution> {
    const controller = new AbortController(); this.intake.add(controller)
    signal = AbortSignal.any([signal, controller.signal])
    return this.serial(async () => {
      this.current(actor)
      if (!this.plugins) throw new BusinessRuleError('conflict', 'Plugin contributions are unavailable.', 'contribution-unavailable')
      declaration = contributionDeclaration(declaration)
      const findings = scanContributionCredentials(contributionDeclarationTexts(declaration)).findings
      if (findings.some(row => row.severity === 'reject') || findings.length && !retainWarnings) throw new ContributionCheckError(findings)
      if (input.source === 'npm') this.policy?.check('plugin', actor, input.packageName, input.version)
      try {
        const upload = await this.plugins.accept(input, signal, declaration, retainWarnings)
        signal.throwIfAborted(); this.current(actor)
        this.policy?.check('plugin', actor, upload.name, upload.plugin.prepared.version)
        const checked = [...findings, ...upload.findings ?? []]
        if (checked.some(row => row.severity === 'reject') || checked.length && !retainWarnings) throw new ContributionCheckError(checked)
        const pending = this.store.list().filter(row => row.status === 'pending' && this.sameMember(row.contributor, actor))
        const previous = pending.find(row => row.kind === 'plugin' && row.name === upload.name)
        if (!previous && pending.length >= 20) throw new BusinessRuleError('conflict', 'Withdraw a pending contribution or wait for review; the limit is 20.', 'contribution-limit')
        const now = this.clock.now()
        const row: MemberContribution = { ...upload, kind: 'plugin', revision: this.artifacts.newId(), id: previous?.id ?? this.artifacts.newId(), contributor: { username: actor.username, spaceId: actor.spaceId, sessionEpoch: actor.sessionEpoch }, declaration, findings: checked, retainedWarnings: retainWarnings, submittedAt: now, updatedAt: now, status: 'pending' }
        this.store.save(row)
        return this.publicRow(row)
      } finally { await this.collect() }
    }).finally(() => { this.intake.delete(controller) })
  }
  withdraw(actor: CommunityAccountActor, id: string): Promise<void> {
    return this.serial(async () => {
      this.current(actor); const row = this.required(id)
      if (!this.sameMember(row.contributor, actor)) throw new BusinessRuleError('missing', 'Contribution not found.', 'contribution-unavailable')
      this.pending(row); this.store.save({ ...row, status: 'withdrawn', updatedAt: this.clock.now() })
    })
  }
  inspect(actor: CommunityAccountActor, id: string, revision: string): Promise<CommunityContributionInspection> {
    return this.serial(async () => {
      this.admin(actor); const row = this.required(id)
      if (row.revision !== revision) throw new BusinessRuleError('conflict', 'Review the changed contribution.', 'contribution-unavailable')
      const maintenance = this.policy && row.status === 'pending' ? await this.policy.review(row) : undefined
      this.admin(actor)
      return redactContributionDeclaration(maintenance ? { maintenance } : {})
    })
  }
  review(actor: CommunityAccountActor, id: string, revision: string): Promise<CommunityContributionReview> {
    return this.serial(async () => {
      this.admin(actor); const row = this.required(id); this.pending(row)
      if (row.revision !== revision) throw new BusinessRuleError('conflict', 'Review the changed contribution.', 'contribution-unavailable')
      let preview: CommunityContributionReview
      if (row.kind === 'plugin') preview = this.plugins!.review(actor, row, this.artifacts.newId())
      else {
        const bytes = await this.artifacts.read(row.hash)
        async function* content() { yield bytes }
        preview = await this.adoption.upload(actor, content(), new AbortController().signal)
      }
      if (row.kind !== 'plugin') preview = { ...preview,
        ...(this.adoption.contributionGroups ? { groups: this.adoption.contributionGroups(actor).map(group => ({ group: group.group, members: group.members, revision: group.revision, granted: group.skills.some(skill => skill.name === row.name && skill.granted) })) } : {}),
        ...(this.execution ? { execution: this.execution.contributionPreview(row.name, row.declaration), ...(this.execution.contributionRevision ? { configuration: { execution: this.execution.contributionRevision(row.name) } } : {}), ...(this.execution.contributionRemoved ? { executionRemoved: this.execution.contributionRemoved(row.name, row.declaration) } : {}) } : {}) }
      if (this.policy) preview = { ...preview, maintenance: await this.policy.review(row) }
      this.admin(actor)
      for (const [token, old] of this.reviews) if (old.id === id) this.reviews.delete(token)
      this.reviews.set(preview.token, { actor: { ...actor }, id, revision, preview, expires: this.clock.now() + 30 * 60 * 1000 })
      return redactContributionDeclaration(preview)
    })
  }
  decide(actor: CommunityAccountActor, id: string, decision: ContributionDecision): Promise<void> {
    return this.serial(async () => {
      this.admin(actor); const row = this.required(id); this.pending(row)
      if (decision.revision !== row.revision) throw new BusinessRuleError('conflict', 'This contribution changed. Review it again.', 'contribution-unavailable')
      if (decision.action === 'decline') {
        if (typeof decision.reason !== 'string' || decision.reason.length > 4096) throw new BusinessRuleError('invalid', 'Use a reason of at most 4096 characters.', 'contribution-invalid')
        this.store.save({ ...row, status: 'declined', reason: decision.reason, updatedAt: this.clock.now() }); return
      }
      const review = this.reviews.get(decision.token)
      if (!review || review.id !== row.id || review.revision !== row.revision || !this.sameMember(review.actor, actor) || review.actor.sessionEpoch !== actor.sessionEpoch)
        throw new BusinessRuleError('conflict', 'Review this contribution before adopting.', 'contribution-unavailable')
      const setup = review.preview.configuration ? { ...decision.setup, configuration: review.preview.configuration } : decision.setup
      validateContributionMaintenance(setup?.maintenance)
      this.policy?.check(row.kind ?? 'skill', row.contributor, row.name, row.plugin?.prepared.version)
      if (row.kind === 'plugin') this.plugins?.validate?.(actor, row, setup)
      if (row.kind !== 'plugin') { this.adoption.validateContributionDistribution?.(actor, setup); this.execution?.checkAdoption(row, setup?.execution, setup?.configuration?.execution) }
      const alreadyAdopted = this.isAdopted(row)
      this.store.begin({ id, revision: row.revision, actor, hash: row.hash, ...(setup ? { setup } : {}) })
      let confirmed = false
      try {
        const committed = () => { confirmed = true; this.store.begin({ ...this.store.intent()!, confirmed: true }) }
        if (row.kind === 'plugin') await this.plugins!.confirm(actor, row, review.preview, committed, setup)
        else await this.adoption.confirm(actor, review.preview.token, review.preview.revision, { id: row.id, revision: row.revision, committed, adoption: { row, ...(decision.setup?.maintenance ? { maintenance: decision.setup.maintenance } : {}) } })
        if (!this.store.intent()?.confirmed) this.store.begin({ ...this.store.intent()!, confirmed: true })
        confirmed = true
        await this.finishAdoption()
        this.reviews.delete(decision.token)
      } catch (error) {
        if (!confirmed && (alreadyAdopted || !this.isAdopted(row))) this.store.finish(this.store.list())
        throw error
      }
    })
  }
  testPlugin(actor: CommunityAccountActor, id: string, revision: string, token: string, input: CommunityPluginUpstreamInput) {
    return this.serial(async () => {
      this.admin(actor); const row = this.required(id); this.pending(row)
      const review = this.reviews.get(token)
      if (row.kind !== 'plugin' || row.revision !== revision || !review || review.id !== id || review.revision !== revision || !this.sameMember(review.actor, actor) || review.actor.sessionEpoch !== actor.sessionEpoch) throw new BusinessRuleError('conflict', 'Review this plugin before testing.', 'contribution-unavailable')
      if (!this.plugins?.test) throw new BusinessRuleError('conflict', 'Upstream testing is unavailable.', 'contribution-unavailable')
      return this.plugins.test(actor, row, input)
    })
  }
  recover(): Promise<void> { return this.serial(async () => { await this.finishAdoption(); this.prune(); await this.collect() }) }
  async stop(): Promise<void> { this.stopped = true; this.stopMaintenance?.(); for (const controller of this.intake) controller.abort(); await this.tail; this.reviews.clear() }
  private async finishAdoption(): Promise<void> {
    const intent = this.store.intent(); if (!intent) return
    const row = this.required(intent.id)
    if (intent.confirmed || this.isAdopted(row)) {
      let warnings: readonly string[] = []
      if (row.kind === 'plugin') warnings = this.isAdopted(row) ? await this.plugins?.apply?.(row, intent.setup) ?? [] : ['The current plugin version changed; the older contribution setup was not applied.']
      else if (this.isAdopted(row)) {
        const executionWarnings = await this.execution?.adoptContribution(row, intent.setup?.execution, intent.setup?.configuration?.execution) ?? []
        warnings = executionWarnings.length ? executionWarnings : await this.adoption.distributeContribution?.(row, intent.setup) ?? []
      } else warnings = ['The current skill version changed; the older contribution setup was not applied.']
      this.store.finish(this.store.list().map(other => other.id === row.id ? { ...other, ...(warnings.length ? { reason: warnings.join(' ') } : {}), status: 'adopted', updatedAt: this.clock.now() }
        : other.status === 'pending' && (other.kind ?? 'skill') === (row.kind ?? 'skill') && other.name === row.name ? { ...other, status: 'declined', reason: 'Another contribution with this name was adopted.', updatedAt: this.clock.now() } : other))
    } else this.store.finish(this.store.list())
  }
  private expired(row: MemberContribution): boolean {
    const account = this.accounts.get(row.contributor.username)
    return row.status === 'pending' && (!account || account.spaceId !== row.contributor.spaceId)
      || (row.status === 'declined' || row.status === 'withdrawn') && row.updatedAt <= this.clock.now() - 30 * 24 * 60 * 60 * 1000
  }
  private prune(): void {
    for (const row of this.store.list()) if (row.id !== this.store.intent()?.id && this.expired(row)) this.store.remove(row.id)
    for (const [token, review] of this.reviews) {
      const row = this.store.list().find(row => row.id === review.id)
      if (!row || row.status !== 'pending' || row.revision !== review.revision || review.expires <= this.clock.now()) this.reviews.delete(token)
    }
  }
  private async collect(): Promise<void> { const rows = this.store.list(); await this.artifacts.collect(rows.filter(row => row.kind !== 'plugin').map(row => row.hash)); await this.plugins?.collect(rows) }
  private isAdopted(row: MemberContribution): boolean { return row.kind === 'plugin' ? this.plugins?.adopted(row) ?? false : this.adoption.adopted(row.name, row.hash, { id: row.id, revision: row.revision }) }
  private publicRow(row: MemberContribution): MemberContribution { const { plugin: privateArtifact, ...publicRow } = row; void privateArtifact; return redactContributionDeclaration(publicRow) }
  private serial<T>(run: () => Promise<T>): Promise<T> { const result = this.tail.then(async () => { if (this.stopped) throw new BusinessRuleError('conflict', 'Contributions are stopping.', 'contribution-unavailable'); await this.finishAdoption(); this.prune(); return run() }); this.tail = result.catch(() => {}); return result }
  private sameMember(left: CommunityAccountActor, right: CommunityAccountActor) { return left.username === right.username && left.spaceId === right.spaceId }
  private required(id: string) { const row = this.store.list().find(row => row.id === id); if (!row) throw new BusinessRuleError('missing', 'Contribution not found.', 'contribution-unavailable'); return row }
  private pending(row: MemberContribution) { if (row.status !== 'pending') throw new BusinessRuleError('conflict', 'Contribution is no longer pending.', 'contribution-unavailable') }
  private current(actor: CommunityAccountActor) {
    const account = this.accounts.get(actor.username)
    if (!account || account.disabled || !this.sameMember(account, actor) || account.sessionEpoch !== actor.sessionEpoch) throw new CommunityAuthenticationError('Sign in is required', 'sign-in-required')
    return account
  }
  private admin(actor: CommunityAccountActor) { if (!this.current(actor).admin) throw new BusinessRuleError('forbidden', 'Administrator access is required', 'admin-required') }
}
