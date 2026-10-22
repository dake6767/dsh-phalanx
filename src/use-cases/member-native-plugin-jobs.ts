import { BusinessRuleError } from '../domain/business-error.js'
import { CommunityAuthenticationError, type CommunityAccountActor } from '../domain/community-account.js'
import type { CommunityNativePluginJob } from '../domain/admin-contract.js'
import type { CommunityAccountReaderPort } from '../ports/community-accounts.js'
import type { CommunityRuntimePort, CommunityUserInstance } from '../ports/community-runtime.js'
import type { PluginInstallationsPort } from '../ports/plugin-installations.js'
import type { MemberNativePlugins } from './member-native-plugins.js'

type Job = { readonly spaceId: string, readonly packageName: string, view: CommunityNativePluginJob, instance?: Pick<CommunityUserInstance, 'processId' | 'containerName'>, work: Promise<void> }

/** Owns accepted member operations; a browser connection never owns their lifetime. */
export class MemberNativePluginJobs {
  private readonly shutdown = new AbortController()
  private readonly jobs = new Map<string, Job>()
  constructor(private readonly accounts: Pick<CommunityAccountReaderPort, 'get'>, private readonly runtime: Pick<CommunityRuntimePort, 'ensure'>,
    private readonly native: MemberNativePlugins, private readonly records: PluginInstallationsPort) {}
  install(actor: CommunityAccountActor, packageName: string, origin: URL, requestId: string): CommunityNativePluginJob {
    return this.start(actor, packageName, origin, requestId, 'install')
  }
  remove(actor: CommunityAccountActor, packageName: string, origin: URL, requestId: string): CommunityNativePluginJob {
    return this.start(actor, packageName, origin, requestId, 'uninstall')
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
    if ([...this.jobs.values()].some(job => job.spaceId === actor.spaceId && job.packageName === packageName && job.view.status === 'running')) throw this.conflict()
    const job: Job = { spaceId: actor.spaceId, packageName, view: { requestId, action, status: 'running', phase: action === 'install' ? 'preparing' : 'removing' }, work: Promise.resolve() }
    this.jobs.set(key, job)
    job.work = this.run(job, actor, origin).finally(() => this.prune())
    return job.view
  }
  private async run(job: Job, actor: CommunityAccountActor, origin: URL): Promise<void> {
    try {
      const instance = await this.runtime.ensure(actor.username, origin.href)
      job.instance = { processId: instance.processId, ...(instance.containerName ? { containerName: instance.containerName } : {}) }
      const application = job.view.action === 'install'
        ? await this.native.install(actor, job.packageName, instance, origin, this.shutdown.signal, job.view.requestId, phase => { job.view = { ...job.view, phase } })
        : { application: await this.native.remove(actor, job.packageName, instance, origin, this.shutdown.signal) }
      this.current(actor)
      if ('version' in application) this.records.save(actor.spaceId, { packageName: job.packageName, source: 'selected', version: application.version })
      job.view = { ...job.view, status: 'succeeded', phase: 'complete', application: application.application }
    } catch (error) {
      const failure = error instanceof BusinessRuleError || error instanceof CommunityAuthenticationError
        ? { error: error.message, code: error.code, ...(error instanceof BusinessRuleError && error.params ? { params: error.params } : {}) }
        : { error: 'The native plugin operation could not finish.', code: 'internal-error' as const }
      job.view = { ...job.view, status: 'failed', phase: 'complete', failure }
    }
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
