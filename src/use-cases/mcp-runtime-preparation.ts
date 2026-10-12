import type { Clock } from '../ports/clock.js'
import type { ExecutionPreparationStorePort } from '../ports/execution-preparation.js'
import type { McpMemberPreparerPort, McpRuntimePort, McpStorePort } from '../ports/mcp-services.js'
import type { McpService } from '../domain/mcp-service.js'
import { memberMcpExecution } from '../domain/mcp-execution.js'
import { ExecutionPreparation } from './execution-preparation.js'

/** MCP is the second preparation owner; member-ready state requires the exact current inputs. */
export class McpRuntimePreparation implements McpRuntimePort {
  private readonly preparation: ExecutionPreparation
  private stopped = false
  private synchronizationFailed = false
  private readonly notifications = new Set<Promise<void>>()
  constructor(store: Pick<McpStorePort, 'read'>, records: ExecutionPreparationStorePort,
    private readonly preparer: McpMemberPreparerPort, clock: Clock, completed: () => Promise<void>) {
    const rows = () => store.read().services.flatMap(service => { const row = memberMcpExecution(service); return row ? [row] : [] })
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
  ready(service: McpService) {
    const row = memberMcpExecution(service), record = this.preparation.view(`mcp:${service.name}`)
    if (this.synchronizationFailed || !row || record?.stage !== 'ready' || !record.artifact || record.identity !== this.preparer.identity(row.owner, row.configuration)) return undefined
    return { directory: this.preparer.directory(record.artifact.id) }
  }
  view(service: McpService) {
    if (!memberMcpExecution(service)) return undefined
    const record = this.preparation.view(`mcp:${service.name}`)
    return record ? { stage: this.synchronizationFailed ? 'failed' as const : record.stage, updatedAt: record.updatedAt, log: this.synchronizationFailed ? 'MCP synchronization failed. Check platform storage and prepare again.' : record.log } : undefined
  }
  async recover(): Promise<void> { await this.preparation.recover() }
  start(): void { this.preparation.start() }
  changed(): Promise<void> { return this.preparation.changed() }
  restart(name: string): void { this.preparation.restart(`mcp:${name}`) }
  async stop(): Promise<void> { this.stopped = true; await this.preparation.stop(); await Promise.allSettled(this.notifications) }
}
