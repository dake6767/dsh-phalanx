import type { CommunityApplication } from '../ports/community-application.js'
import type { CommunitySupervisionPort } from '../ports/community-supervision.js'

/** A failed graph is fully drained before a fresh graph can claim the saved database again. */
export class CommunitySupervisor implements CommunityApplication {
  private graph: CommunityApplication | undefined
  private attempt: Promise<void> | undefined
  private recovery: Promise<void> | undefined
  private cancel: (() => void) | undefined
  private stopping: Promise<void> | undefined
  private stopped = false
  private started = false
  constructor(private readonly deps: CommunitySupervisionPort) {}
  async start(): Promise<string> {
    if (this.started || this.stopped) throw Error('Community supervisor cannot start twice')
    this.started = true
    const origin = await this.deps.entry.start()
    await this.rebuild()
    return origin
  }
  private rebuild(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    return (this.attempt ??= this.construct().finally(() => {
      this.attempt = undefined
    }))
  }
  private async construct(): Promise<void> {
    let graph: CommunityApplication | undefined
    try {
      graph = await this.deps.create()
      this.graph = graph
      if (this.stopped) {
        await graph.stop()
        this.graph = undefined
        return
      }
      const current = graph
      graph.onFailure?.(() => {
        this.failed(current)
      })
      await graph.start()
    } catch (error) {
      const retryable = this.deps.retryable(error)
      this.deps.entry.suspend(retryable ? undefined : 'configuration')
      try {
        await graph?.stop()
      } catch (cleanup) {
        this.deps.report(cleanup)
        return
      }
      if (this.graph === graph) this.graph = undefined
      this.deps.report(error)
      if (retryable) this.schedule()
    }
  }
  private failed(graph: CommunityApplication): void {
    if (this.stopped || this.graph !== graph || this.recovery) return
    this.deps.entry.suspend()
    this.recovery = (async () => {
      try {
        await graph.stop()
        if (this.graph === graph) this.graph = undefined
        this.schedule()
      } catch (error) {
        this.deps.report(error)
      }
    })().finally(() => {
      this.recovery = undefined
    })
  }
  private schedule(): void {
    if (this.stopped || this.cancel) return
    this.cancel = this.deps.schedule(async () => {
      this.cancel = undefined
      await this.rebuild()
    })
  }
  stop(): Promise<void> {
    return (this.stopping ??= this.close())
  }
  private async close(): Promise<void> {
    this.stopped = true
    this.cancel?.()
    this.cancel = undefined
    this.deps.entry.suspend()
    const failures = new Set<unknown>()
    const settle = async (operation: () => Promise<unknown> | undefined) => {
      try {
        await operation()
      } catch (error) {
        failures.add(error)
      }
    }
    await settle(() => this.graph?.stop())
    await settle(() => this.attempt)
    await settle(() => this.recovery)
    await settle(() => this.graph?.stop())
    await settle(() => this.deps.entry.stop())
    if (failures.size) throw new AggregateError([...failures], 'Platform shutdown could not release every resource')
  }
}
