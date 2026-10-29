import type { ExecutionDeadlinePort, ExecutionMaintenancePort } from '../ports/execution-control.js'

export class ExecutionDeadlines implements ExecutionDeadlinePort {
  start(milliseconds: number) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), milliseconds)
    timer.unref()
    return { signal: controller.signal, dispose: () => clearTimeout(timer) }
  }
}

export class ExecutionMaintenance implements ExecutionMaintenancePort {
  constructor(private readonly intervalMs = 60 * 60 * 1000) {}
  start(cleanup: () => void): () => void {
    const timer = setInterval(() => {
      try {
        cleanup()
      } catch {
        console.warn('Scheduled cleanup failed; retrying at the next interval')
      }
    }, this.intervalMs)
    timer.unref()
    return () => clearInterval(timer)
  }
}
