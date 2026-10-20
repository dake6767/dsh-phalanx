import { USAGE_REPORT_MAX_BYTES } from '../domain/usage-record.js'
import { BusinessRuleError } from '../domain/business-error.js'
import { CommunityAuthenticationError, type CommunityAccountActor } from '../domain/community-account.js'
import type { UsageCapability, UsageMember, UsageQuery, UsageResult, UsageModelQuery, UsageReportedQuery } from '../domain/usage-record.js'
import type { Clock } from '../ports/clock.js'
import type { CommunityAccountStorePort } from '../ports/community-accounts.js'
import type { ExecutionMaintenancePort } from '../ports/execution-control.js'
import type { UsageDecisionPort, UsageRecordsPort } from '../ports/usage-records.js'

/** Owns attempt lifetime, admission and metadata retention across gateways. */
export class UsagePolicy {
  private readonly reportWindows = new Map<string, { until: number; count: number }>()
  private stopMaintenance: (() => void) | undefined
  constructor(private readonly store: UsageRecordsPort, private readonly clock: Clock,
    private readonly accounts: Pick<CommunityAccountStorePort, 'get'>, private readonly decision?: UsageDecisionPort,
    private readonly maintenance?: ExecutionMaintenancePort,
    private readonly skills?: { accessible(username: string): readonly { readonly name: string }[] }) {}
  start(): void { this.prune(); this.stopMaintenance ??= this.maintenance?.start(() => this.prune()) }
  stop(): void { this.stopMaintenance?.(); this.stopMaintenance = undefined; this.reportWindows.clear() }
  prune(): void { this.store.prune(this.clock.now() - this.store.retentionDays() * 86400000) }
  begin(member: UsageMember, capability: UsageCapability) {
    const startedAt = this.clock.now(), identity = { username: member.username, groupId: member.groupId }, target = { kind: capability.kind, id: capability.id, operation: capability.operation, ...(capability.kind === 'execution' && capability.firstArgument !== undefined ? { firstArgument: capability.firstArgument } : {}) }
    const allowed = this.decision?.allow(identity, target) ?? true
    let finished = false
    return { allowed, finish: (result: UsageResult): void => {
      if (finished) return
      finished = true
      this.prune()
      if (target.kind === 'model') {
        const denied = !allowed || result.outcome === 'denied', tokens = result.tokens ?? { input: null, output: null, cacheRead: null, cacheWrite: null }
        this.store.appendModel({ ...identity, modelId: target.id, hour: Math.floor(startedAt / 3600000) * 3600000, tokens, requests: 1,
          unknownRequests: denied ? 0 : result.usageUnknown || Object.values(tokens).some(value => value === null) ? 1 : 0, deniedRequests: denied ? 1 : 0 })
        return
      }
      this.store.append({ ...identity, capability: target, startedAt, durationMs: Math.max(0, this.clock.now() - startedAt),
        outcome: allowed ? result.outcome : 'denied', ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }), ...(result.isError === undefined ? {} : { isError: result.isError }), ...(result.httpStatus === undefined ? {} : { httpStatus: result.httpStatus }),
        ...(!allowed ? { reason: 'policy' as const } : result.reason === undefined ? {} : { reason: result.reason }) })
    } }
  }
  receive(member: UsageMember, input: unknown): void {
    const current = this.accounts.get(member.username)
    if (!current || current.disabled) throw new CommunityAuthenticationError('Sign in is required', 'sign-in-required')
    const now = this.clock.now()
    for (const [username, window] of this.reportWindows) if (window.until <= now) this.reportWindows.delete(username)
    let window = this.reportWindows.get(current.username)
    if (!window) {
      if (this.reportWindows.size >= 4096) throw new BusinessRuleError('invalid', 'Too many skill reports.', 'usage-report-rate')
      window = { until: now + 60000, count: 0 }; this.reportWindows.set(current.username, window)
    }
    if (++window.count > 10) throw new BusinessRuleError('invalid', 'Too many skill reports.', 'usage-report-rate')
    const items = (input as { items?: unknown } | null)?.items
    if (!Array.isArray(items) || items.length > 100) throw new BusinessRuleError('invalid', 'Review the skill report.', 'usage-report-invalid')
    const counts = new Map<string, number>()
    let total = 0
    for (const item of items) {
      if (!item || typeof item !== 'object' || typeof item.name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(item.name) || item.name.length > USAGE_REPORT_MAX_BYTES
        || !Number.isSafeInteger(item.count) || item.count < 1 || item.count > 1000) throw new BusinessRuleError('invalid', 'Review the skill report.', 'usage-report-invalid')
      const count = (counts.get(item.name) ?? 0) + item.count
      total += item.count
      if (count > 1000 || total > 10000) throw new BusinessRuleError('invalid', 'Review the skill report.', 'usage-report-invalid')
      counts.set(item.name, count)
    }
    const held = new Set(this.skills?.accessible(current.username).map(skill => skill.name) ?? [])
    this.prune()
    this.store.appendReported([...counts].filter(([name]) => held.has(name)).map(([skill, count]) => ({ username: current.username, groupId: current.groupId, day: Math.floor(now / 86400000) * 86400000, skill, count })))
  }
  reported(actor: CommunityAccountActor, query: UsageReportedQuery) {
    this.assertAdmin(actor)
    if (Object.values(query).some(value => typeof value === 'string' && value.length > 256)
      || [query.from, query.until].some(value => value !== undefined && (!Number.isSafeInteger(value) || value < 0 || value % 86400000 !== 0))
      || query.from !== undefined && query.until !== undefined && query.from >= query.until) throw new BusinessRuleError('invalid', 'Choose a UTC day range.', 'usage-query-invalid')
    this.prune(); return this.store.reported(query)
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
  models(actor: CommunityAccountActor, query: UsageModelQuery) {
    this.assertAdmin(actor)
    if (Object.values(query).some(value => typeof value === 'string' && value.length > 256)
      || [query.from, query.until].some(value => value !== undefined && (!Number.isSafeInteger(value) || value < 0 || value % 3600000 !== 0))
      || query.from !== undefined && query.until !== undefined && query.from >= query.until) throw new BusinessRuleError('invalid', 'Choose a UTC hour range.', 'usage-query-invalid')
    this.prune(); return this.store.models(query)
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
