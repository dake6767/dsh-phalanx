import type { McpService } from '../domain/mcp-service.js'
import { ExecutionFailure } from '../domain/platform-execution.js'
import type { PluginUpstream } from '../domain/plugin-upstream.js'
import type { Clock } from '../ports/clock.js'
import type { ExecutionMaintenancePort } from '../ports/execution-control.js'
import type { McpSharedProcessPort, McpSharedRuntimePort } from '../ports/mcp-shared-runtime.js'
import { ExecutionControl } from './execution-control.js'

type Deadline = ReturnType<ExecutionControl['deadline']>
interface Running {
  readonly username: string
  readonly service: McpService
  readonly diagnostic: boolean
  readonly abort: AbortController
  readonly target: Promise<PluginUpstream>
  readonly done: Promise<unknown>
  readonly pending: Map<number, Deadline>
  ready: boolean
  activity: number
}
/** Owns shared MCP sessions; the existing execution owner admits their entire process lifetime. */
export class McpSharedRuntime implements McpSharedRuntimePort {
  private readonly running = new Map<string, Running>()
  private readonly retiring = new Set<Running>()
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
      if (this.canDrain(previous, service)) { this.running.delete(key); this.retiring.add(previous) }
      else { previous.abort.abort(); await previous.done.catch(() => {}) }
      return this.connect(username, service, diagnostic)
    }
    const abort = new AbortController()
    let ready!: (value: PluginUpstream) => void, failed!: (error: unknown) => void
    const target = new Promise<PluginUpstream>((resolve, reject) => { ready = resolve; failed = reject })
    const request = { username, owner: `mcp:${service.name}`, command: service.run.command, argv: [], cwd: '', stdin: new Uint8Array() }
    const pending = new Map<number, Deadline>()
    const deadline = () => {
      const timer = this.control.deadline()
      const expired = () => abort.abort(new ExecutionFailure('timeout'))
      timer.signal.addEventListener('abort', expired, { once: true })
      if (timer.signal.aborted) expired()
      return { signal: timer.signal, dispose: () => { timer.dispose(); timer.signal.removeEventListener('abort', expired) } }
    }
    const done = this.control.hold(request, abort.signal, async signal => {
      const startup = deadline()
      let handle
      try {
        handle = await this.process.start(service, event => {
          if (signal.aborted) return
          const row = this.running.get(key); if (row?.abort === abort) row.activity = this.clock.now()
          if (event.type === 'started' && !pending.has(event.id)) pending.set(event.id, deadline())
          if (event.type === 'completed' || event.type === 'cancelled') {
            pending.get(event.id)?.dispose(); pending.delete(event.id)
            if (!pending.size && [...this.retiring].some(row => row.abort === abort)) abort.abort()
            if (event.type === 'cancelled') abort.abort()
            else if (event.type === 'completed' && event.failed) this.control.observe(request, 'upstream-error')
          }
        }, signal)
      } finally { startup.dispose() }
      try {
        signal.throwIfAborted()
        const current = this.current(username, service.name, diagnostic)
        if (!current || !this.same(service, current)) throw new ExecutionFailure('not-ready')
        const row = this.running.get(key); if (row?.abort === abort) row.ready = true
        ready(handle.target)
        await handle.closed
        signal.throwIfAborted()
        throw new ExecutionFailure('process-exited')
      } catch (error) { abort.abort(error instanceof ExecutionFailure ? error : undefined); throw error }
      finally { await handle.closed.catch(() => {}) }
    }).catch(error => { failed(error); throw error }).finally(() => { for (const timer of pending.values()) timer.dispose(); if (this.running.get(key)?.abort === abort) this.running.delete(key); for (const row of this.retiring) if (row.abort === abort) this.retiring.delete(row) })
    this.running.set(key, { username, service, diagnostic, abort, target, done, pending, ready: false, activity: this.clock.now() })
    void done.catch(() => {})
    return target
  }
  async reconcile(): Promise<void> {
    const stopped: Promise<unknown>[] = []
    for (const row of [...this.running.values(), ...this.retiring]) {
      let current: McpService | undefined
      try { current = this.current(row.username, row.service.name, row.diagnostic) } catch { current = undefined }
      if (current && !row.abort.signal.aborted && !this.same(row.service, current) && this.canDrain(row, current)) {
        const key = JSON.stringify([row.username, row.service.name])
        if (this.running.get(key) === row) this.running.delete(key)
        this.retiring.add(row); continue
      }
      const idle = row.ready && !row.pending.size && this.clock.now() - row.activity >= this.idleSeconds * 1000
      if (row.abort.signal.aborted || !current || !this.same(row.service, current) || idle) {
        row.abort.abort(idle && current && this.same(row.service, current) ? new ExecutionFailure('idle-reclaimed') : undefined); stopped.push(row.done)
      }
    }
    await Promise.allSettled(stopped)
  }
  async stop(): Promise<void> {
    this.stopped = true; this.cancelMaintenance?.(); this.cancelMaintenance = undefined
    const rows = [...this.running.values(), ...this.retiring]; for (const row of rows) row.abort.abort()
    await Promise.allSettled(rows.map(row => row.done)); await this.process.recover()
  }
  private canDrain(row: Running, next: McpService): boolean {
    const previous = row.service
    const credentials = (service: McpService) => JSON.stringify([service.credential, service.credentials, service.disabledTools])
    return row.ready && row.pending.size > 0 && next.run?.location === 'shared' && !!next.prepared && credentials(previous) === credentials(next)
      && (previous.generation === next.generation || !!previous.catalog && previous.catalog.id === next.catalog?.id && previous.catalog.version !== next.catalog.version)
  }
  private same(left: McpService, right: McpService): boolean {
    return right.run?.location === 'shared' && left.generation === right.generation && left.prepared?.directory === right.prepared?.directory && JSON.stringify(left.prepared?.dependencies?.map(row => row.id)) === JSON.stringify(right.prepared?.dependencies?.map(row => row.id))
  }
}
