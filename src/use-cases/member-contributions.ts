import type { CommunitySkillPreview } from '../domain/admin-contract.js'
import { CommunityAuthenticationError, type CommunityAccountActor } from '../domain/community-account.js'
import { BusinessRuleError } from '../domain/business-error.js'
import type { ContributionDeclaration, ContributionDecision, MemberContribution } from '../domain/member-contribution.js'
import type { CommunityAccountStorePort } from '../ports/community-accounts.js'
import type { ContributionStore, ContributionArtifacts, ContributionAdoption, ContributionMaintenancePort } from '../ports/member-contributions.js'
import type { Clock } from '../ports/clock.js'

/** Owns the private intake lifecycle; library mutation remains with its existing owner. */
export class MemberContributions {
  private readonly reviews = new Map<string, { actor: CommunityAccountActor, id: string, revision: string, preview: CommunitySkillPreview, expires: number }>()
  private stopMaintenance: (() => void) | undefined
  private stopped = false
  private readonly intake = new Set<AbortController>()
  private tail: Promise<unknown> = Promise.resolve()
  constructor(private readonly accounts: Pick<CommunityAccountStorePort, 'get'>, private readonly store: ContributionStore,
    private readonly artifacts: ContributionArtifacts, private readonly adoption: ContributionAdoption, private readonly clock: Clock, private readonly maintenance?: ContributionMaintenancePort) {}
  start(): void { this.stopMaintenance ??= this.maintenance?.start(() => this.recover()) }
  list(actor: CommunityAccountActor, administration = false): readonly MemberContribution[] {
    if (administration) this.admin(actor); else this.current(actor)
    return this.store.list().filter(row => !this.expired(row) && (administration || this.sameMember(row.contributor, actor)))
  }
  submit(actor: CommunityAccountActor, declaration: ContributionDeclaration, content: AsyncIterable<Uint8Array>, signal: AbortSignal): Promise<MemberContribution> {
    const controller = new AbortController(); this.intake.add(controller)
    signal = AbortSignal.any([signal, controller.signal])
    return this.serial(async () => {
      this.current(actor)
      if (typeof declaration?.purpose !== 'string' || !declaration.purpose.trim() || declaration.purpose.length > 4096)
        throw new BusinessRuleError('invalid', 'Describe the purpose of this contribution.', 'contribution-invalid')
      try {
        const upload = await this.artifacts.accept(content, signal)
        signal.throwIfAborted(); this.current(actor)
        const pending = this.store.list().filter(row => row.status === 'pending' && this.sameMember(row.contributor, actor))
        const previous = pending.find(row => row.name === upload.name)
        if (!previous && pending.length >= 20) throw new BusinessRuleError('conflict', 'Withdraw a pending contribution or wait for review; the limit is 20.', 'contribution-limit')
        const now = this.clock.now()
        const row: MemberContribution = { ...upload, revision: this.artifacts.newId(), id: previous?.id ?? this.artifacts.newId(), contributor: { username: actor.username, spaceId: actor.spaceId, sessionEpoch: actor.sessionEpoch }, declaration: { purpose: declaration.purpose.trim() }, submittedAt: now, updatedAt: now, status: 'pending' }
        this.store.save(row)
        return row
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
  review(actor: CommunityAccountActor, id: string, revision: string): Promise<CommunitySkillPreview> {
    return this.serial(async () => {
      this.admin(actor); const row = this.required(id); this.pending(row)
      if (row.revision !== revision) throw new BusinessRuleError('conflict', 'Review the changed contribution.', 'contribution-unavailable')
      const bytes = await this.artifacts.read(row.hash)
      async function* content() { yield bytes }
      const preview = await this.adoption.upload(actor, content(), new AbortController().signal)
      this.admin(actor)
      for (const [token, old] of this.reviews) if (old.id === id) this.reviews.delete(token)
      this.reviews.set(preview.token, { actor: { ...actor }, id, revision, preview, expires: this.clock.now() + 30 * 60 * 1000 })
      return preview
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
      const alreadyAdopted = this.adoption.adopted(row.name, row.hash)
      this.store.begin({ id, revision: row.revision, actor, hash: row.hash })
      try {
        await this.adoption.confirm(actor, review.preview.token, review.preview.revision)
        this.finishAdoption()
        this.reviews.delete(decision.token)
      } catch (error) {
        if (alreadyAdopted || !this.adoption.adopted(row.name, row.hash)) this.store.finish(this.store.list())
        throw error
      }
    })
  }
  recover(): Promise<void> { return this.serial(async () => { this.finishAdoption(); this.prune(); await this.collect() }) }
  async stop(): Promise<void> { this.stopped = true; this.stopMaintenance?.(); for (const controller of this.intake) controller.abort(); await this.tail; this.reviews.clear() }
  private finishAdoption(): void {
    const intent = this.store.intent(); if (!intent) return
    const row = this.required(intent.id)
    if (this.adoption.adopted(row.name, intent.hash)) {
      this.store.finish(this.store.list().map(other => other.id === row.id ? { ...other, status: 'adopted', updatedAt: this.clock.now() }
        : other.status === 'pending' && other.name === row.name ? { ...other, status: 'declined', reason: 'Another contribution with this name was adopted.', updatedAt: this.clock.now() } : other))
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
  private collect(): Promise<void> { return this.artifacts.collect(this.store.list().map(row => row.hash)) }
  private serial<T>(run: () => Promise<T>): Promise<T> { const result = this.tail.then(() => { if (this.stopped) throw new BusinessRuleError('conflict', 'Contributions are stopping.', 'contribution-unavailable'); this.finishAdoption(); this.prune(); return run() }); this.tail = result.catch(() => {}); return result }
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
