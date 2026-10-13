import type { McpService } from '../domain/mcp-service.js'
import { ExecutionFailure } from '../domain/platform-execution.js'
import type { PluginUpstream } from '../domain/plugin-upstream.js'
import type { Clock } from '../ports/clock.js'
import type { ExecutionMaintenancePort } from '../ports/execution-control.js'
import type { McpSharedProcessPort, McpSharedRuntimePort } from '../ports/mcp-shared-runtime.js'
import { ExecutionControl } from './execution-control.js'

interface Running {
  readonly username: string
  readonly service: McpService
  readonly diagnostic: boolean
  readonly abort: AbortController
  readonly target: Promise<PluginUpstream>
  readonly done: Promise<unknown>
  activity: number
}
/** Owns shared MCP sessions; the existing execution owner admits their entire process lifetime. */
export class McpSharedRuntime implements McpSharedRuntimePort {
  private readonly running = new Map<string, Running>()
  private stopped = false
  private cancelMaintenance: (() => void) | undefined
  constructor(private readonly process: McpSharedProcessPort, private readonly control: ExecutionControl,
    private readonly clock: Clock, private readonly maintenance: ExecutionMaintenancePort,
    private readonly current: (username: string, name: string, diagnostic: boolean) => McpService | undefined,
    private readonly idleSeconds = 60) {}
  recover(): Promise<void> { return this.process.recover() }
  start(): void { this.cancelMaintenance ??= this.maintenance.start(() => { void this.reconcile().catch(() => {}) }) }
  async connect(username: string, service: McpService, diagnostic: boolean): Promise<PluginUpstream> {
    if (this.stopped || service.run?.location !== 'shared' || !service.prepared) throw new ExecutionFailure('not-ready')
    const current = this.current(username, service.name, diagnostic)
    if (!current || !this.same(service, current)) throw new ExecutionFailure('not-ready')
    const key = JSON.stringify([username, service.name])
    const previous = this.running.get(key)
    if (previous) {
      if (!previous.abort.signal.aborted && this.same(previous.service, service)) { previous.activity = this.clock.now(); return previous.target }
      previous.abort.abort(); await previous.done
      return this.connect(username, service, diagnostic)
    }
    const abort = new AbortController()
    let ready!: (value: PluginUpstream) => void, failed!: (error: unknown) => void
    const target = new Promise<PluginUpstream>((resolve, reject) => { ready = resolve; failed = reject })
    const request = { username, owner: `mcp:${service.name}`, command: service.run.command, argv: [], cwd: '', stdin: new Uint8Array() }
    const done = this.control.run(request, abort.signal, async signal => {
      const handle = await this.process.start(service, () => { const row = this.running.get(key); if (row?.abort === abort) row.activity = this.clock.now() }, signal)
      try {
        signal.throwIfAborted()
        const current = this.current(username, service.name, diagnostic)
        if (!current || !this.same(service, current)) throw new ExecutionFailure('not-ready')
        ready(handle.target)
        return await handle.closed
      } finally { abort.abort(); await handle.closed.catch(() => {}) }
    }).catch(error => { failed(error); throw error }).finally(() => { if (this.running.get(key)?.abort === abort) this.running.delete(key) })
    this.running.set(key, { username, service, diagnostic, abort, target, done, activity: this.clock.now() })
    void done.catch(() => {})
    return target
  }
  async reconcile(): Promise<void> {
    const stopped: Promise<unknown>[] = []
    for (const row of this.running.values()) {
      let current: McpService | undefined
      try { current = this.current(row.username, row.service.name, row.diagnostic) } catch { current = undefined }
      if (row.abort.signal.aborted || !current || !this.same(row.service, current) || this.clock.now() - row.activity >= this.idleSeconds * 1000) {
        row.abort.abort(); stopped.push(row.done)
      }
    }
    await Promise.allSettled(stopped)
  }
  async stop(): Promise<void> {
    this.stopped = true; this.cancelMaintenance?.(); this.cancelMaintenance = undefined
    const rows = [...this.running.values()]; for (const row of rows) row.abort.abort()
    await Promise.allSettled(rows.map(row => row.done)); await this.process.recover()
  }
  private same(left: McpService, right: McpService): boolean {
    return right.run?.location === 'shared' && left.generation === right.generation && left.prepared?.directory === right.prepared?.directory
  }
}
