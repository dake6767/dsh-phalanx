import { contributionDeclaration, redactContributionDeclaration } from '../domain/contribution-checks.js'
import type { CommunitySkillGroupView, CommunityExecutionView, CommunitySkillPreview } from '../domain/admin-contract.js'
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
  private readonly reviews = new Map<string, { actor: CommunityAccountActor, id: string, revision: string, preview: CommunitySkillPreview, expires: number }>()
  private stopMaintenance: (() => void) | undefined
  private stopped = false
  private readonly intake = new Set<AbortController>()
  private tail: Promise<unknown> = Promise.resolve()
  constructor(private readonly accounts: Pick<CommunityAccountStorePort, 'get'>, private readonly store: ContributionStore,
    private readonly artifacts: ContributionArtifacts, private readonly adoption: ContributionAdoption, private readonly clock: Clock, private readonly maintenance?: ContributionMaintenancePort, private readonly execution?: ContributionExecutionPort, private readonly plugins?: PluginContributionPort) {}
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
        signal.throwIfAborted(); this.current(actor); this.execution?.checkContribution(upload.name, declaration)
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
      try {
        const upload = await this.plugins.accept(input, signal)
        signal.throwIfAborted(); this.current(actor)
        const checked = [...findings, ...upload.findings ?? []]
        if (checked.some(row => row.severity === 'reject') || checked.length && !retainWarnings) throw new ContributionCheckError(checked)
        const pending = this.store.list().filter(row => row.status === 'pending' && this.sameMember(row.contributor, actor))
        const previous = pending.find(row => row.kind === 'plugin' && row.name === upload.name)
        if (!previous && pending.length >= 20) throw new BusinessRuleError('conflict', 'Withdraw a pending contribution or wait for review; the limit is 20.', 'contribution-limit')
        const now = this.clock.now()
        const row: MemberContribution = { ...upload, kind: 'plugin', revision: this.artifacts.newId(), id: previous?.id ?? this.artifacts.newId(), contributor: { ...actor }, declaration, findings: checked, retainedWarnings: retainWarnings, submittedAt: now, updatedAt: now, status: 'pending' }
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
  review(actor: CommunityAccountActor, id: string, revision: string): Promise<CommunitySkillPreview & { execution?: CommunityExecutionView, groups?: readonly CommunitySkillGroupView[] }> {
    return this.serial(async () => {
      this.admin(actor); const row = this.required(id); this.pending(row)
      if (row.revision !== revision) throw new BusinessRuleError('conflict', 'Review the changed contribution.', 'contribution-unavailable')
      let preview: CommunitySkillPreview
      if (row.kind === 'plugin') preview = this.plugins!.review(actor, row, this.artifacts.newId())
      else {
        const bytes = await this.artifacts.read(row.hash)
        async function* content() { yield bytes }
        preview = await this.adoption.upload(actor, content(), new AbortController().signal)
      }
      this.admin(actor)
      for (const [token, old] of this.reviews) if (old.id === id) this.reviews.delete(token)
      this.reviews.set(preview.token, { actor: { ...actor }, id, revision, preview, expires: this.clock.now() + 30 * 60 * 1000 })
      return redactContributionDeclaration({ ...preview, ...(row.kind !== 'plugin' && this.adoption.contributionGroups ? { groups: this.adoption.contributionGroups(actor) } : {}), ...(row.kind !== 'plugin' && this.execution ? { execution: this.execution.contributionPreview(row.name, row.declaration) } : {}) })
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
      if (row.kind === 'plugin' && decision.setup) throw new BusinessRuleError('invalid', 'Review the plugin before configuring distribution.', 'contribution-invalid')
      if (row.kind !== 'plugin') { this.adoption.validateContributionDistribution?.(actor, decision.setup); this.execution?.checkAdoption(row, decision.setup?.execution) }
      const alreadyAdopted = this.isAdopted(row)
      this.store.begin({ id, revision: row.revision, actor, hash: row.hash, ...(decision.setup ? { setup: decision.setup } : {}) })
      let confirmed = false
      try {
        const committed = () => { confirmed = true; this.store.begin({ ...this.store.intent()!, confirmed: true }) }
        if (row.kind === 'plugin') await this.plugins!.confirm(actor, row, review.preview, committed)
        else await this.adoption.confirm(actor, review.preview.token, review.preview.revision, { id: row.id, revision: row.revision, committed })
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
  recover(): Promise<void> { return this.serial(async () => { await this.finishAdoption(); this.prune(); await this.collect() }) }
  async stop(): Promise<void> { this.stopped = true; this.stopMaintenance?.(); for (const controller of this.intake) controller.abort(); await this.tail; this.reviews.clear() }
  private async finishAdoption(): Promise<void> {
    const intent = this.store.intent(); if (!intent) return
    const row = this.required(intent.id)
    if (intent.confirmed || this.isAdopted(row)) {
      let warnings: readonly string[] = []
      if (row.kind === 'plugin') { /* Plugin configuration remains under its library owner. */ }
      else if (this.isAdopted(row)) {
        const executionWarnings = await this.execution?.adoptContribution(row, intent.setup?.execution) ?? []
        warnings = [...executionWarnings, ...await this.adoption.distributeContribution?.(row, intent.setup) ?? []]
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
  private isAdopted(row: MemberContribution): boolean { return row.kind === 'plugin' ? this.plugins?.adopted(row) ?? false : this.adoption.adopted(row.name, row.hash) }
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
