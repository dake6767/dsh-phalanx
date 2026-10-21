import type { CommunityUserInstance } from '../ports/community-runtime.js'

type InspectionResult = Required<Pick<CommunityUserInstance, 'managedFailures' | 'expertFailures'>>
/** Background work belongs to an exact carrier; cancellation drains before its files are retired. */
export class InstanceInspection {
  private readonly started = new WeakSet<CommunityUserInstance>()
  private readonly pending = new Map<CommunityUserInstance, { abort: AbortController, completed: Promise<void> }>()
  start(instance: CommunityUserInstance, inspect: (signal: AbortSignal) => Promise<InspectionResult>, fallback: InspectionResult): Promise<void> {
    const existing = this.pending.get(instance)
    if (existing) return existing.completed
    if (this.started.has(instance)) return Promise.resolve()
    this.started.add(instance)
    const abort = new AbortController()
    Object.assign(instance, { inspection: 'checking' })
    const completed = Promise.resolve().then(async () => {
      let result: InspectionResult
      try { abort.signal.throwIfAborted(); result = await inspect(abort.signal) }
      catch { if (abort.signal.aborted) return; result = fallback }
      if (!abort.signal.aborted) Object.assign(instance, result, { inspection: 'complete' })
    })
    this.pending.set(instance, { abort, completed })
    void completed.finally(() => { if (this.pending.get(instance)?.completed === completed) this.pending.delete(instance) })
    return completed
  }
  async stop(instance: CommunityUserInstance): Promise<void> {
    const task = this.pending.get(instance)
    if (!task) return
    task.abort.abort(); await task.completed
  }
}

/** Both native capability inventories belong to the same cancellation/drain boundary. */
export async function inspectCapabilities(managed: Promise<readonly string[]>, experts: Promise<NonNullable<CommunityUserInstance['expertFailures']>>): Promise<InspectionResult> {
  const [managedResult, expertResult] = await Promise.allSettled([managed, experts])
  if (managedResult.status === 'rejected') throw managedResult.reason
  if (expertResult.status === 'rejected') throw expertResult.reason
  return { managedFailures: managedResult.value, expertFailures: expertResult.value }
}
