import { ExecutionFailure, type ExecutionRequest } from '../domain/platform-execution.js'
import type { ExecutionDeadlinePort, ExecutionLimitsPort } from '../ports/execution-control.js'

/** Shared admission covers disposable commands and persistent MCP carriers. */
export class ExecutionControl {
  private readonly members = new Map<string, number>()
  private active = 0
  constructor(readonly limits: ExecutionLimitsPort, private readonly deadlines: ExecutionDeadlinePort) {}
  deadline(): ReturnType<ExecutionDeadlinePort['start']> { return this.deadlines.start(this.limits.get().timeoutSeconds * 1000) }
  /** Persistent carriers retain admission; their owner bounds startup and each protocol request. */
  hold(request: ExecutionRequest, signal: AbortSignal, action: (signal: AbortSignal) => Promise<number>): Promise<number> { return this.execute(request, signal, action, false) }
  run(request: ExecutionRequest, signal: AbortSignal, action: (signal: AbortSignal) => Promise<number>): Promise<number> { return this.execute(request, signal, action, true) }
  private async execute(request: ExecutionRequest, signal: AbortSignal, action: (signal: AbortSignal) => Promise<number>, timed: boolean): Promise<number> {
    const limits = this.limits.get()
    let entered = false, deadline: ReturnType<ExecutionDeadlinePort['start']> | undefined
    try {
      if (this.active >= limits.platformConcurrency || (this.members.get(request.username) ?? 0) >= limits.memberConcurrency) throw new ExecutionFailure('concurrency')
      signal.throwIfAborted()
      this.active++; this.members.set(request.username, (this.members.get(request.username) ?? 0) + 1); entered = true
      if (timed) deadline = this.deadlines.start(limits.timeoutSeconds * 1000)
      const exitCode = await action(deadline ? AbortSignal.any([signal, deadline.signal]) : signal)
      if (deadline?.signal.aborted) throw new ExecutionFailure('timeout')
      return exitCode
    } catch (error) { throw deadline?.signal.aborted ? new ExecutionFailure('timeout') : error }
    finally {
      deadline?.dispose()
      if (entered) { this.active--; const remaining = this.members.get(request.username)! - 1; if (remaining) this.members.set(request.username, remaining); else this.members.delete(request.username) }
    }
  }
}
