import { ExecutionFailure, type ExecutionRequest } from '../domain/platform-execution.js'
import type { ExecutionRecord } from '../domain/execution-control.js'
import type { ExecutionAuditPort, ExecutionDeadlinePort, ExecutionLimitsPort, ExecutionMaintenancePort } from '../ports/execution-control.js'
import type { Clock } from '../ports/clock.js'

/** One admission and audit owner covers member calls and administrator trials, including blocked commands. */
export class ExecutionControl {
  private readonly members = new Map<string, number>()
  private active = 0
  private stopMaintenance: (() => void) | undefined
  constructor(readonly limits: ExecutionLimitsPort, private readonly audit: ExecutionAuditPort, private readonly clock: Clock, private readonly deadlines: ExecutionDeadlinePort, private readonly maintenance?: ExecutionMaintenancePort) {}
  start(): void { this.prune(); this.stopMaintenance ??= this.maintenance?.start(() => this.prune()) }
  stop(): void { this.stopMaintenance?.(); this.stopMaintenance = undefined }
  prune(): void { this.audit.prune(this.clock.now() - 30 * 24 * 60 * 60 * 1000) }
  records(username?: string, owner?: string): readonly ExecutionRecord[] {
    this.prune(); return this.audit.list().filter(row => (!username || row.username === username) && (!owner || row.owner === owner)).slice().reverse()
  }
  deadline(): ReturnType<ExecutionDeadlinePort['start']> { return this.deadlines.start(this.limits.get().timeoutSeconds * 1000) }
  observe(request: ExecutionRequest, reason: NonNullable<ExecutionRecord['reason']>): void {
    this.prune(); this.audit.append({ username: request.username, owner: request.owner, command: request.command, startedAt: this.clock.now(), durationMs: 0, reason })
  }
  /** Persistent carriers retain admission; their owner bounds startup and each protocol request. */
  hold(request: ExecutionRequest, signal: AbortSignal, action: (signal: AbortSignal) => Promise<number>): Promise<number> { return this.execute(request, signal, action, false) }
  run(request: ExecutionRequest, signal: AbortSignal, action: (signal: AbortSignal) => Promise<number>): Promise<number> { return this.execute(request, signal, action, true) }
  private async execute(request: ExecutionRequest, signal: AbortSignal, action: (signal: AbortSignal) => Promise<number>, timed: boolean): Promise<number> {
    const startedAt = this.clock.now(), limits = this.limits.get()
    let entered = false, deadline: ReturnType<ExecutionDeadlinePort['start']> | undefined, exitCode: number | undefined, reason: ExecutionRecord['reason']
    try {
      if (this.active >= limits.platformConcurrency || (this.members.get(request.username) ?? 0) >= limits.memberConcurrency) throw new ExecutionFailure('concurrency')
      signal.throwIfAborted()
      this.active++; this.members.set(request.username, (this.members.get(request.username) ?? 0) + 1); entered = true
      if (timed) deadline = this.deadlines.start(limits.timeoutSeconds * 1000)
      exitCode = await action(deadline ? AbortSignal.any([signal, deadline.signal]) : signal)
      if (deadline?.signal.aborted) throw new ExecutionFailure('timeout')
      return exitCode
    } catch (error) {
      const failure = deadline?.signal.aborted ? new ExecutionFailure('timeout') : error
      reason = signal.aborted ? (signal.reason instanceof ExecutionFailure ? signal.reason.code : 'cancelled') : failure instanceof ExecutionFailure ? failure.code : 'internal'
      throw failure
    } finally {
      deadline?.dispose()
      if (entered) { this.active--; const remaining = this.members.get(request.username)! - 1; if (remaining) this.members.set(request.username, remaining); else this.members.delete(request.username) }
      this.prune()
      this.audit.append({ username: request.username, owner: request.owner, command: request.command, startedAt, durationMs: Math.max(0, this.clock.now() - startedAt), ...(reason ? { reason } : { exitCode: exitCode! }) })
    }
  }
}
