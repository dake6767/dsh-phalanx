import { BusinessRuleError } from '../domain/business-error.js'
import { CommunityAuthenticationError, type CommunityAccountActor } from '../domain/community-account.js'
import type { UsageCapability, UsageMember, UsageQuery, UsageResult } from '../domain/usage-record.js'
import type { Clock } from '../ports/clock.js'
import type { CommunityAccountStorePort } from '../ports/community-accounts.js'
import type { ExecutionMaintenancePort } from '../ports/execution-control.js'
import type { UsageDecisionPort, UsageRecordsPort } from '../ports/usage-records.js'

/** Owns attempt lifetime, admission and metadata retention across gateways. */
export class UsagePolicy {
  private stopMaintenance: (() => void) | undefined
  constructor(private readonly store: UsageRecordsPort, private readonly clock: Clock,
    private readonly accounts: Pick<CommunityAccountStorePort, 'get'>, private readonly decision?: UsageDecisionPort,
    private readonly maintenance?: ExecutionMaintenancePort) {}
  start(): void { this.prune(); this.stopMaintenance ??= this.maintenance?.start(() => this.prune()) }
  stop(): void { this.stopMaintenance?.(); this.stopMaintenance = undefined }
  prune(): void { this.store.prune(this.clock.now() - this.store.retentionDays() * 86400000) }
  begin(member: UsageMember, capability: UsageCapability) {
    const startedAt = this.clock.now(), identity = { username: member.username, groupId: member.groupId }, target = { kind: capability.kind, id: capability.id, operation: capability.operation }
    const allowed = this.decision?.allow(identity, target) ?? true
    let finished = false
    return { allowed, finish: (result: UsageResult): void => {
      if (finished) return
      finished = true
      this.prune()
      this.store.append({ ...identity, capability: target, startedAt, durationMs: Math.max(0, this.clock.now() - startedAt),
        outcome: allowed ? result.outcome : 'denied', ...(result.httpStatus === undefined ? {} : { httpStatus: result.httpStatus }),
        ...(!allowed ? { reason: 'policy' as const } : result.reason === undefined ? {} : { reason: result.reason }) })
    } }
  }
  view(actor: CommunityAccountActor, query: UsageQuery) {
    this.assertAdmin(actor)
    if (Object.values(query).some(value => typeof value === 'string' && value.length > 256)
      || [query.from, query.until].some(value => value !== undefined && (!Number.isSafeInteger(value) || value < 0))
      || query.from !== undefined && query.until !== undefined && query.from >= query.until
      || query.outcome !== undefined && !['succeeded', 'failed', 'denied'].includes(query.outcome)
      || query.page !== undefined && (!Number.isSafeInteger(query.page) || query.page < 1)) throw new BusinessRuleError('invalid', 'Review the usage filters.', 'usage-query-invalid')
    this.prune(); return this.store.view(query)
  }
  settings(actor: CommunityAccountActor) { this.assertAdmin(actor); return { retentionDays: this.store.retentionDays() } }
  saveRetention(actor: CommunityAccountActor, input: unknown) {
    this.assertAdmin(actor)
    const days = (input as { retentionDays?: unknown } | null)?.retentionDays
    if (!Number.isSafeInteger(days) || (days as number) < 1 || (days as number) > 3650 || !input || typeof input !== 'object' || Object.keys(input).length !== 1)
      throw new BusinessRuleError('invalid', 'Choose a retention period from 1 to 3650 days.', 'usage-retention-invalid')
    this.store.saveRetention(days as number); this.prune(); return this.settings(actor)
  }
  private assertAdmin(actor: CommunityAccountActor): void {
    const current = this.accounts.get(actor.username)
    if (!current || current.disabled || current.spaceId !== actor.spaceId || current.sessionEpoch !== actor.sessionEpoch) throw new CommunityAuthenticationError('Sign in is required', 'sign-in-required')
    if (!current.admin) throw new BusinessRuleError('forbidden', 'Administrator access is required', 'admin-required')
  }
}
