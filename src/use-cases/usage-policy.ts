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
  constructor(
    private readonly store: UsageRecordsPort,
    private readonly clock: Clock,
    private readonly accounts: Pick<CommunityAccountStorePort, 'get'>,
    private readonly decision?: UsageDecisionPort,
    private readonly maintenance?: ExecutionMaintenancePort,
    private readonly skills?: { accessible(username: string): Promise<readonly { readonly name: string }[]> },
  ) {}
  private readonly writes = new Set<Promise<unknown>>()
  private readonly pending = new Set<Promise<unknown>>()
  async start(): Promise<void> {
    await this.prune()
    this.stopMaintenance ??= this.maintenance?.start(() => {
      void this.track(this.prune()).catch(() => {
        console.warn('Usage retention cleanup failed')
      })
    })
  }
  async stop(): Promise<void> {
    this.stopMaintenance?.()
    this.stopMaintenance = undefined
    this.reportWindows.clear()
    while (this.pending.size) await Promise.allSettled([...this.pending])
  }
  async prune(): Promise<void> {
    await this.store.prune(this.clock.now() - (await this.store.retentionDays()) * 86400000)
  }
  private track<T>(operation: Promise<T>): Promise<T> {
    this.pending.add(operation)
    void operation.then(
      () => this.pending.delete(operation),
      () => this.pending.delete(operation),
    )
    return operation
  }
  private write<T>(operation: Promise<T>): Promise<T> {
    this.writes.add(operation)
    void operation.then(
      () => this.writes.delete(operation),
      () => this.writes.delete(operation),
    )
    return this.track(operation)
  }
  begin(member: UsageMember, capability: UsageCapability) {
    const startedAt = this.clock.now(),
      identity = { username: member.username, groupId: member.groupId },
      target = {
        kind: capability.kind,
        id: capability.id,
        operation: capability.operation,
        ...(capability.kind === 'execution' && capability.firstArgument !== undefined ? { firstArgument: capability.firstArgument } : {}),
      }
    const allowed = this.decision?.allow(identity, target) ?? true
    let finished: Promise<void> | undefined
    let complete!: () => void
    this.track(
      new Promise<void>(resolve => {
        complete = resolve
      }),
    )
    return {
      allowed,
      finish: (result: UsageResult): Promise<void> => {
        if (finished) return finished
        const durationMs = Math.max(0, this.clock.now() - startedAt)
        finished = this.write(
          (async () => {
            await this.prune()
            if (target.kind === 'model') {
              const denied = !allowed || result.outcome === 'denied',
                tokens = result.tokens ?? { input: null, output: null, cacheRead: null, cacheWrite: null }
              await this.store.appendModel({
                ...identity,
                modelId: target.id,
                hour: Math.floor(startedAt / 3600000) * 3600000,
                tokens,
                requests: 1,
                unknownRequests: denied ? 0 : result.usageUnknown || Object.values(tokens).some(value => value === null) ? 1 : 0,
                deniedRequests: denied ? 1 : 0,
              })
              return
            }
            await this.store.append({
              ...identity,
              capability: target,
              startedAt,
              durationMs,
              outcome: allowed ? result.outcome : 'denied',
              ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
              ...(result.isError === undefined ? {} : { isError: result.isError }),
              ...(result.httpStatus === undefined ? {} : { httpStatus: result.httpStatus }),
              ...(!allowed ? { reason: 'policy' as const } : result.reason === undefined ? {} : { reason: result.reason }),
            })
          })().finally(complete),
        )
        return finished
      },
    }
  }
  async receive(member: UsageMember, input: unknown): Promise<void> {
    const current = await this.accounts.get(member.username)
    if (!current || current.disabled) throw new CommunityAuthenticationError('Sign in is required', 'sign-in-required')
    const now = this.clock.now()
    for (const [username, window] of this.reportWindows) if (window.until <= now) this.reportWindows.delete(username)
    let window = this.reportWindows.get(current.username)
    if (!window) {
      if (this.reportWindows.size >= 4096) throw new BusinessRuleError('invalid', 'Too many skill reports.', 'usage-report-rate')
      window = { until: now + 60000, count: 0 }
      this.reportWindows.set(current.username, window)
    }
    if (++window.count > 10) throw new BusinessRuleError('invalid', 'Too many skill reports.', 'usage-report-rate')
    const items = (input as { items?: unknown } | null)?.items
    if (!Array.isArray(items) || items.length > 100) throw new BusinessRuleError('invalid', 'Review the skill report.', 'usage-report-invalid')
    const counts = new Map<string, number>()
    let total = 0
    for (const item of items) {
      if (
        !item ||
        typeof item !== 'object' ||
        typeof item.name !== 'string' ||
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(item.name) ||
        item.name.length > USAGE_REPORT_MAX_BYTES ||
        !Number.isSafeInteger(item.count) ||
        item.count < 1 ||
        item.count > 1000
      )
        throw new BusinessRuleError('invalid', 'Review the skill report.', 'usage-report-invalid')
      const count = (counts.get(item.name) ?? 0) + item.count
      total += item.count
      if (count > 1000 || total > 10000) throw new BusinessRuleError('invalid', 'Review the skill report.', 'usage-report-invalid')
      counts.set(item.name, count)
    }
    const held = new Set((await this.skills?.accessible(current.username))?.map(skill => skill.name) ?? [])
    const entries = [...counts]
      .filter(([name]) => held.has(name))
      .map(([skill, count]) => ({ username: current.username, groupId: current.groupId, day: Math.floor(now / 86400000) * 86400000, skill, count }))
    await this.write(
      (async () => {
        await this.prune()
        await this.store.appendReported(entries)
      })(),
    )
  }
  async reported(actor: CommunityAccountActor, query: UsageReportedQuery) {
    await this.assertAdmin(actor)
    if (
      Object.values(query).some(value => typeof value === 'string' && value.length > 256) ||
      [query.from, query.until].some(value => value !== undefined && (!Number.isSafeInteger(value) || value < 0 || value % 86400000 !== 0)) ||
      (query.from !== undefined && query.until !== undefined && query.from >= query.until)
    )
      throw new BusinessRuleError('invalid', 'Choose a UTC day range.', 'usage-query-invalid')
    await Promise.allSettled([...this.writes])
    await this.prune()
    return this.store.reported(query)
  }
  async view(actor: CommunityAccountActor, query: UsageQuery) {
    await this.assertAdmin(actor)
    if (
      Object.values(query).some(value => typeof value === 'string' && value.length > 256) ||
      [query.from, query.until].some(value => value !== undefined && (!Number.isSafeInteger(value) || value < 0)) ||
      (query.from !== undefined && query.until !== undefined && query.from >= query.until) ||
      (query.outcome !== undefined && !['succeeded', 'failed', 'denied'].includes(query.outcome)) ||
      (query.page !== undefined && (!Number.isSafeInteger(query.page) || query.page < 1))
    )
      throw new BusinessRuleError('invalid', 'Review the usage filters.', 'usage-query-invalid')
    await Promise.allSettled([...this.writes])
    await this.prune()
    return this.store.view(query)
  }
  async models(actor: CommunityAccountActor, query: UsageModelQuery) {
    await this.assertAdmin(actor)
    if (
      Object.values(query).some(value => typeof value === 'string' && value.length > 256) ||
      [query.from, query.until].some(value => value !== undefined && (!Number.isSafeInteger(value) || value < 0 || value % 3600000 !== 0)) ||
      (query.from !== undefined && query.until !== undefined && query.from >= query.until)
    )
      throw new BusinessRuleError('invalid', 'Choose a UTC hour range.', 'usage-query-invalid')
    await Promise.allSettled([...this.writes])
    await this.prune()
    return this.store.models(query)
  }
  async settings(actor: CommunityAccountActor) {
    await this.assertAdmin(actor)
    return { retentionDays: await this.store.retentionDays() }
  }
  async saveRetention(actor: CommunityAccountActor, input: unknown) {
    await this.assertAdmin(actor)
    const days = (input as { retentionDays?: unknown } | null)?.retentionDays
    if (
      !Number.isSafeInteger(days) ||
      (days as number) < 1 ||
      (days as number) > 3650 ||
      !input ||
      typeof input !== 'object' ||
      Object.keys(input).length !== 1
    )
      throw new BusinessRuleError('invalid', 'Choose a retention period from 1 to 3650 days.', 'usage-retention-invalid')
    await this.store.saveRetention(days as number)
    await this.prune()
    return this.settings(actor)
  }
  private async assertAdmin(actor: CommunityAccountActor): Promise<void> {
    const current = await this.accounts.get(actor.username)
    if (!current || current.disabled || current.spaceId !== actor.spaceId || current.sessionEpoch !== actor.sessionEpoch)
      throw new CommunityAuthenticationError('Sign in is required', 'sign-in-required')
    if (!current.admin) throw new BusinessRuleError('forbidden', 'Administrator access is required', 'admin-required')
  }
}
