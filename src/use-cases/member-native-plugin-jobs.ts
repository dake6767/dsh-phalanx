import { BusinessRuleError } from '../domain/business-error.js'
import { CommunityAuthenticationError, type CommunityAccountActor } from '../domain/community-account.js'
import type { CommunityNativePluginJob } from '../domain/admin-contract.js'
import type { CommunityAccountReaderPort } from '../ports/community-accounts.js'
import type { CommunityRuntimePort, CommunityUserInstance } from '../ports/community-runtime.js'
import type { PluginInstallationsPort } from '../ports/plugin-installations.js'
import type { MemberNativePlugins } from './member-native-plugins.js'
import type { PreparedPlugin } from '../domain/plugin-library.js'
import { PluginPreinstallCancelled } from '../domain/plugin-preinstall.js'

type PreinstallOutcome = 'succeeded' | 'skipped' | 'failed' | 'cancelled'
type Job = { readonly spaceId: string, readonly packageName: string, readonly abort: AbortController, readonly source: 'selected' | 'preinstall',
  view: CommunityNativePluginJob, instance?: Pick<CommunityUserInstance, 'processId' | 'containerName'>, work: Promise<void>, outcome?: PreinstallOutcome }

/** Owns accepted member operations; a browser connection never owns their lifetime. */
export class MemberNativePluginJobs {
  private readonly shutdown = new AbortController()
  private readonly jobs = new Map<string, Job>()
  private preinstallSequence = 0
  constructor(private readonly accounts: Pick<CommunityAccountReaderPort, 'get'>, private readonly runtime: Pick<CommunityRuntimePort, 'ensure'>,
    private readonly native: MemberNativePlugins, private readonly records: Pick<PluginInstallationsPort, 'get' | 'save'>) {}
  install(actor: CommunityAccountActor, packageName: string, origin: URL, requestId: string): CommunityNativePluginJob {
    return this.start(actor, packageName, origin, requestId, 'install')
  }
  remove(actor: CommunityAccountActor, packageName: string, origin: URL, requestId: string): CommunityNativePluginJob {
    return this.start(actor, packageName, origin, requestId, 'uninstall')
  }
  async preinstall(actor: CommunityAccountActor, plugin: PreparedPlugin, instance: CommunityUserInstance, origin: URL, current: () => boolean): Promise<PreinstallOutcome> {
    this.current(actor)
    if (!current() || this.shutdown.signal.aborted) return 'cancelled'
    if (this.busy(actor.spaceId, plugin.packageName)) return 'skipped'
    const job = this.create(actor, plugin.packageName, `preinstall-${++this.preinstallSequence}`, 'install', 'preinstall')
    job.work = this.run(job, actor, origin, { plugin, instance, current }).finally(() => this.prune())
    await job.work
    return job.outcome!
  }
  get(actor: CommunityAccountActor, packageName: string, instance?: CommunityUserInstance): CommunityNativePluginJob | undefined {
    this.current(actor)
    const job = [...this.jobs.values()].findLast(job => job.spaceId === actor.spaceId && job.packageName === packageName)
    if (job?.view.status === 'succeeded' && job.view.application === 'restart-required' && instance && job.instance
      && (job.instance.processId !== instance.processId || job.instance.containerName !== instance.containerName)) return { ...job.view, application: 'applied' }
    return job?.view
  }
  private start(actor: CommunityAccountActor, packageName: string, origin: URL, requestId: string, action: 'install' | 'uninstall') {
    this.current(actor)
    if (this.shutdown.signal.aborted || !/^[a-zA-Z0-9_-]{1,128}$/u.test(requestId)) throw this.conflict()
    const key = actor.spaceId + '\0' + requestId, previous = this.jobs.get(key)
    if (previous) {
      if (previous.packageName !== packageName || previous.view.action !== action) throw this.conflict()
      return previous.view
    }
    if (this.busy(actor.spaceId, packageName)) throw this.conflict()
    const job = this.create(actor, packageName, requestId, action, 'selected')
    job.work = this.run(job, actor, origin).finally(() => this.prune())
    return job.view
  }
  private busy(spaceId: string, packageName: string) { return [...this.jobs.values()].some(job => job.spaceId === spaceId && job.packageName === packageName && job.view.status === 'running') }
  private create(actor: CommunityAccountActor, packageName: string, requestId: string, action: 'install' | 'uninstall', source: Job['source']): Job {
    const job: Job = { spaceId: actor.spaceId, packageName, abort: new AbortController(), source,
      view: { requestId, action, status: 'running', phase: action === 'install' ? 'preparing' : 'removing' }, work: Promise.resolve() }
    this.jobs.set(actor.spaceId + (source === 'preinstall' ? '\0preinstall\0' : '\0') + requestId, job)
    return job
  }
  private async run(job: Job, actor: CommunityAccountActor, origin: URL, preinstall?: { readonly plugin: PreparedPlugin, readonly instance: CommunityUserInstance, readonly current: () => boolean }): Promise<void> {
    const signal = AbortSignal.any([this.shutdown.signal, job.abort.signal])
    try {
      const instance = preinstall?.instance ?? await this.runtime.ensure(actor.username, origin.href)
      signal.throwIfAborted()
      job.instance = { processId: instance.processId, ...(instance.containerName ? { containerName: instance.containerName } : {}) }
      const progress = (phase: 'downloading' | 'installing') => { job.view = { ...job.view, phase } }
      const application = preinstall ? await this.native.preinstall(actor, preinstall.plugin, instance, origin, signal, job.view.requestId, preinstall.current, progress)
        : job.view.action === 'install' ? await this.native.install(actor, job.packageName, instance, origin, signal, job.view.requestId, progress)
          : { application: await this.native.remove(actor, job.packageName, instance, origin, signal) }
      signal.throwIfAborted(); this.current(actor)
      if (preinstall && !preinstall.current()) throw new PluginPreinstallCancelled()
      if (!application) { job.outcome = 'skipped'; job.view = { ...job.view, status: 'succeeded', phase: 'complete', application: 'applied' }; return }
      if ('version' in application) this.records.save(actor.spaceId, { packageName: job.packageName, source: job.source, version: application.version })
      job.outcome = 'succeeded'
      job.view = { ...job.view, status: 'succeeded', phase: 'complete', application: application.application }
    } catch (error) {
      job.outcome = signal.aborted || error instanceof PluginPreinstallCancelled ? 'cancelled' : 'failed'
      const failure = error instanceof BusinessRuleError || error instanceof CommunityAuthenticationError
        ? { error: error.message, code: error.code, ...(error instanceof BusinessRuleError && error.params ? { params: error.params } : {}) }
        : { error: 'The native plugin operation could not finish.', code: 'internal-error' as const }
      job.view = { ...job.view, status: 'failed', phase: 'complete', failure }
    }
  }
  async cancelSpace(spaceId: string): Promise<void> {
    const running = [...this.jobs.values()].filter(job => job.spaceId === spaceId && job.view.status === 'running')
    for (const job of running) job.abort.abort()
    await Promise.allSettled(running.map(job => job.work))
  }
  private prune(): void {
    const completed = [...this.jobs.entries()].filter(([, job]) => job.view.status !== 'running')
    for (const [key] of completed.slice(0, Math.max(0, completed.length - 200))) this.jobs.delete(key)
  }
  async drain(): Promise<void> { await Promise.allSettled([...this.jobs.values()].map(job => job.work)) }
  async stop(): Promise<void> { this.shutdown.abort(); await this.drain() }
  private current(actor: CommunityAccountActor) {
    const account = this.accounts.get(actor.username)
    if (!account || account.disabled || account.spaceId !== actor.spaceId || account.sessionEpoch !== actor.sessionEpoch) throw new CommunityAuthenticationError('Sign in is required', 'sign-in-required')
  }
  private conflict() { return new BusinessRuleError('conflict', 'This plugin operation cannot be started. Refresh its status before retrying.', 'plugin-market-unavailable') }
}
