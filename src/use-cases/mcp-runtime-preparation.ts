import type { Clock } from '../ports/clock.js'
import type { ExecutionPreparationStorePort } from '../ports/execution-preparation.js'
import type { McpMemberPreparerPort, McpRuntimePort, McpStorePort } from '../ports/mcp-services.js'
import type { McpService } from '../domain/mcp-service.js'
import { memberMcpExecution, sharedMcpExecution } from '../domain/mcp-execution.js'
import { ExecutionPreparation } from './execution-preparation.js'

/** MCP is the second preparation owner; member-ready state requires the exact current inputs. */
export class McpRuntimePreparation implements McpRuntimePort {
  private readonly preparation: ExecutionPreparation
  private stopped = false
  private synchronizationFailed = false
  private readonly notifications = new Set<Promise<void>>()
  constructor(private readonly store: Pick<McpStorePort, 'read'>, records: ExecutionPreparationStorePort,
    private readonly preparer: McpMemberPreparerPort, clock: Clock, completed: () => Promise<void>, private readonly location: 'member' | 'shared' = 'member') {
    const rows = () => store.read().services.flatMap(service => { const row = this.execution(service); return row ? [row] : [] })
    this.preparation = new ExecutionPreparation({ identities: () => rows().map(row => row.owner.id), get: id => rows().find(row => row.owner.id === id)?.owner, owns: () => false },
      { get: id => rows().find(row => row.owner.id === id)?.configuration, list: () => rows().map(row => ({ owner: row.owner.id, configuration: row.configuration })), retain: () => {} }, records, preparer, clock,
      async () => {
        if (this.stopped) return
        this.synchronizationFailed = false
        const notification = completed().catch(() => { this.synchronizationFailed = true })
        this.notifications.add(notification)
        void notification.finally(() => this.notifications.delete(notification))
      })
  }
  private execution(service: McpService) { return this.location === 'member' ? memberMcpExecution(service) : sharedMcpExecution(service) }
  ready(service: McpService) {
    const row = this.execution(service), record = this.preparation.view(`mcp:${service.name}`)
    if (this.synchronizationFailed || !row || record?.stage !== 'ready' || !record.artifact || record.identity !== this.preparer.identity(row.owner, row.configuration)) return undefined
    return { directory: this.preparer.directory(record.artifact.id) }
  }
  view(service: McpService) {
    if (!this.execution(service)) return undefined
    const record = this.preparation.view(`mcp:${service.name}`)
    return record ? { stage: this.synchronizationFailed ? 'failed' as const : record.stage, updatedAt: record.updatedAt, log: this.synchronizationFailed ? 'MCP synchronization failed. Check platform storage and prepare again.' : record.log } : undefined
  }
  async recover(): Promise<void> { await this.preparation.recover() }
  start(): void { this.preparation.start() }
  collect(): Promise<void> { return this.preparation.collect() }
  changed(): Promise<void> { return this.preparation.changed() }
  restart(name: string): void { if (this.store.read().services.some(row => row.name === name && this.execution(row))) this.preparation.restart(`mcp:${name}`) }
  async stop(): Promise<void> { this.stopped = true; await this.preparation.stop(); await Promise.allSettled(this.notifications) }
}

/** Routes the two preparation roots and reconciles shared carriers before projecting new settings. */
export class McpRuntimeCoordination implements McpRuntimePort {
  constructor(private readonly member: McpRuntimePreparation, private readonly shared: McpRuntimePreparation,
    private readonly running: import('./mcp-shared-runtime.js').McpSharedRuntime, private readonly isolated: () => boolean) {}
  private owner(service: McpService) { return service.run?.location === 'shared' ? this.shared : this.member }
  ready(service: McpService) { return this.owner(service).ready(service) }
  view(service: McpService) {
    const view = this.owner(service).view(service)
    return view && service.run?.location === 'shared' ? { ...view, isolated: this.isolated() } : view
  }
  async changed(): Promise<void> { await Promise.all([this.member.changed(), this.shared.changed()]); await this.running.reconcile(); await this.shared.collect() }
  restart(name: string): void { this.member.restart(name); this.shared.restart(name) }
  async recover(): Promise<void> { await this.member.recover(); await this.running.recover(); await this.shared.recover() }
  start(): void { this.member.start(); this.shared.start(); this.running.start() }
  async stop(): Promise<void> { await this.running.stop(); await Promise.all([this.member.stop(), this.shared.stop()]); await this.shared.collect() }
}
