import { BusinessRuleError } from '../domain/business-error.js'
import { CommunityAuthenticationError, type CommunityAccountActor } from '../domain/community-account.js'
import type { CommunityNativePluginJob } from '../domain/admin-contract.js'
import type { CommunityAccountReaderPort } from '../ports/community-accounts.js'
import { CommunityRuntimeUnavailableError, type CommunityRuntimePort, type CommunityUserInstance } from '../ports/community-runtime.js'
import type { PluginInstallation, PluginInstallationsPort } from '../ports/plugin-installations.js'
import type { MemberNativeServiceSettings } from './member-native-service-settings.js'
import type { NativePluginServiceAccess } from './native-plugin-service-access.js'
import type { MemberNativePlugins } from './member-native-plugins.js'
import type { InstalledMarketPlugin } from '../ports/plugin-market.js'
import type { NativePluginApplication, NativePluginReplacement } from '../ports/member-native-plugins.js'
import type { PreparedPlugin } from '../domain/plugin-library.js'
import { PluginPreinstallCancelled } from '../domain/plugin-preinstall.js'

type Update = {
  readonly target: string
  readonly source: PluginInstallation['source']
  readonly replacement: NativePluginReplacement
  readonly instance: CommunityUserInstance
  readonly assertCurrent: () => Promise<() => boolean>
}
type PreinstallOutcome = 'succeeded' | 'skipped' | 'failed' | 'cancelled' | 'restart-required'
type InstallReceipt = {
  readonly record: PluginInstallation
  readonly application: NativePluginApplication
  readonly artifact: string
  readonly preparationId: string | undefined
  readonly epoch: number
}
type ReceiptRetry = {
  readonly instance: CommunityUserInstance
  readonly plugin: PreparedPlugin
  readonly current: () => Promise<boolean>
}
type Job = {
  readonly spaceId: string
  readonly packageName: string
  readonly abort: AbortController
  readonly source: 'selected' | 'preinstall'
  readonly update?: Update
  view: CommunityNativePluginJob
  instance?: Pick<CommunityUserInstance, 'processId' | 'containerName'>
  work: Promise<void>
  outcome?: PreinstallOutcome
}

/** Owns accepted member operations; a browser connection never owns their lifetime. */
export class MemberNativePluginJobs {
  private readonly shutdown = new AbortController()
  private readonly jobs = new Map<string, Job>()
  // Only a live carrier with a verified signed completion can retry writing a missing receipt.
  private readonly receipts = new WeakMap<CommunityUserInstance, Map<string, InstallReceipt>>()
  private preinstallSequence = 0
  constructor(
    private readonly accounts: Pick<CommunityAccountReaderPort, 'get'>,
    private readonly runtime: Pick<CommunityRuntimePort, 'ensure' | 'withPluginReplacement'>,
    private readonly native: MemberNativePlugins,
    private readonly records: Pick<PluginInstallationsPort, 'get' | 'save'>,
    private readonly services?: Pick<NativePluginServiceAccess, 'describeDelivery'>,
    private readonly settings?: Pick<MemberNativeServiceSettings, 'apply' | 'cancelSpace'>,
  ) {}
  async adapted(packageName: string): Promise<boolean> {
    return Boolean(await this.services?.describeDelivery(packageName))
  }
  archiveReserved(instance: CommunityUserInstance, integrity: string): boolean {
    return [...(this.receipts.get(instance)?.values() ?? [])].some(
      ({ record }) => record.integrity === integrity && (record.serviceOrigin !== undefined || record.resourceOrigin !== undefined),
    )
  }
  canRetryReceipt(actor: CommunityAccountActor, instance: CommunityUserInstance, plugin: PreparedPlugin, actual: InstalledMarketPlugin): boolean {
    return (
      actual.retainedArchive === true &&
      actual.version === plugin.version &&
      actual.archiveIntegrity === plugin.integrity &&
      this.matchingReceipt(actor, instance, plugin, 'selected') !== undefined
    )
  }
  async delivery(actor: CommunityAccountActor, packageName: string) {
    await this.current(actor)
    return (await this.records.get(actor.spaceId)).find(row => row.packageName === packageName)
  }
  async install(actor: CommunityAccountActor, packageName: string, origin: URL, requestId: string, retry?: ReceiptRetry): Promise<CommunityNativePluginJob> {
    return await this.start(actor, packageName, origin, requestId, 'install', undefined, retry)
  }
  async remove(actor: CommunityAccountActor, packageName: string, origin: URL, requestId: string): Promise<CommunityNativePluginJob> {
    return await this.start(actor, packageName, origin, requestId, 'uninstall')
  }
  async previousUpdate(actor: CommunityAccountActor, packageName: string, requestId: string, target: string) {
    await this.current(actor)
    const previous = this.jobs.get(actor.spaceId + '\0' + requestId)
    if (!previous) return undefined
    if (previous.packageName !== packageName || previous.update?.target !== target) throw this.conflict()
    return previous.view
  }
  async update(actor: CommunityAccountActor, packageName: string, origin: URL, requestId: string, update: Update) {
    return await this.start(actor, packageName, origin, requestId, 'update', update)
  }
  async preinstall(
    actor: CommunityAccountActor,
    plugin: PreparedPlugin,
    instance: CommunityUserInstance,
    origin: URL,
    current: () => Promise<boolean>,
  ): Promise<PreinstallOutcome> {
    await this.current(actor)
    if (!(await current()) || this.shutdown.signal.aborted) return 'cancelled'
    if (this.busy(actor.spaceId, plugin.packageName)) return 'skipped'
    const job = this.create(actor, plugin.packageName, `preinstall-${++this.preinstallSequence}`, 'install', 'preinstall')
    job.work = this.run(job, actor, origin, { plugin, instance, current }).finally(() => this.prune())
    await job.work
    return job.outcome!
  }
  async get(
    actor: CommunityAccountActor,
    packageName: string,
    instance?: CommunityUserInstance,
    actual?: InstalledMarketPlugin,
  ): Promise<CommunityNativePluginJob | undefined> {
    await this.current(actor)
    const job = [...this.jobs.values()].findLast(job => job.spaceId === actor.spaceId && job.packageName === packageName)
    return job && this.view(job, instance, actual)
  }
  async unlistedUpdates(
    actor: CommunityAccountActor,
    listed: ReadonlySet<string>,
    instance: CommunityUserInstance,
    installed: readonly InstalledMarketPlugin[],
  ) {
    await this.current(actor)
    const latest = new Map<string, Job>()
    for (const job of this.jobs.values()) {
      if (job.spaceId === actor.spaceId && !listed.has(job.packageName)) latest.set(job.packageName, job)
    }
    return [...latest.values()].flatMap(job => {
      const view =
        job.view.action === 'update' &&
        this.view(
          job,
          instance,
          installed.find(actual => actual.packageName === job.packageName),
        )
      return view ? [{ packageName: job.packageName, job: view }] : []
    })
  }
  private view(job: Job, instance?: CommunityUserInstance, actual?: InstalledMarketPlugin): CommunityNativePluginJob | undefined {
    if (
      job.update &&
      instance &&
      job.update.instance.launchUrl !== instance.launchUrl &&
      job.view.status === 'failed' &&
      job.view.application === 'restart-required'
    ) {
      const view = { ...job.view }
      delete view.application
      return view
    }
    if (
      job.update &&
      instance &&
      job.view.status === 'succeeded' &&
      (job.update.instance.launchUrl !== instance.launchUrl ||
        actual?.version !== job.update.replacement.next.version ||
        actual.archiveIntegrity !== job.update.replacement.next.integrity)
    )
      return undefined
    if (
      job.view.status === 'succeeded' &&
      (job.view.application === 'restart-required' || job.view.action === 'update') &&
      instance &&
      job.instance &&
      (job.instance.processId !== instance.processId || job.instance.containerName !== instance.containerName)
    )
      return job.view.action === 'update' ? undefined : { ...job.view, application: 'applied' }
    return job.view
  }
  private async start(
    actor: CommunityAccountActor,
    packageName: string,
    origin: URL,
    requestId: string,
    action: CommunityNativePluginJob['action'],
    update?: Update,
    retry?: ReceiptRetry,
  ) {
    await this.current(actor)
    if (this.shutdown.signal.aborted || !/^[a-zA-Z0-9_-]{1,128}$/u.test(requestId)) throw this.conflict()
    const key = actor.spaceId + '\0' + requestId,
      previous = this.jobs.get(key)
    if (previous) {
      if (previous.packageName !== packageName || previous.view.action !== action || previous.update?.target !== update?.target) throw this.conflict()
      return previous.view
    }
    if (this.busy(actor.spaceId, packageName)) throw this.conflict()
    const job = this.create(actor, packageName, requestId, action, update?.source ?? 'selected', update)
    job.work = this.run(job, actor, origin, undefined, retry).finally(() => this.prune())
    return job.view
  }
  private busy(spaceId: string, packageName: string) {
    return [...this.jobs.values()].some(job => job.spaceId === spaceId && job.packageName === packageName && job.view.status === 'running')
  }
  private create(
    actor: CommunityAccountActor,
    packageName: string,
    requestId: string,
    action: CommunityNativePluginJob['action'],
    source: Job['source'],
    update?: Update,
  ): Job {
    const job: Job = {
      spaceId: actor.spaceId,
      packageName,
      abort: new AbortController(),
      source,
      ...(update ? { update } : {}),
      view: { requestId, action, status: 'running', phase: action === 'uninstall' ? 'removing' : 'preparing' },
      work: Promise.resolve(),
    }
    this.jobs.set(actor.spaceId + (source === 'preinstall' && !update ? '\0preinstall\0' : '\0') + requestId, job)
    return job
  }
  private async run(
    job: Job,
    actor: CommunityAccountActor,
    origin: URL,
    preinstall?: { readonly plugin: PreparedPlugin; readonly instance: CommunityUserInstance; readonly current: () => Promise<boolean> },
    retry?: ReceiptRetry,
  ): Promise<void> {
    const signal = AbortSignal.any([this.shutdown.signal, job.abort.signal])
    try {
      const instance = job.update?.instance ?? preinstall?.instance ?? (await this.runtime.ensure(actor.username, origin.href))
      signal.throwIfAborted()
      job.instance = { processId: instance.processId, ...(instance.containerName ? { containerName: instance.containerName } : {}) }
      const progress = (phase: 'downloading' | 'installing') => {
        job.view = { ...job.view, phase }
      }
      const update = job.update
      const previous =
        this.services && (update || job.view.action === 'uninstall')
          ? (await this.records.get(actor.spaceId)).find(row => row.packageName === job.packageName)
          : undefined
      const binding =
        job.view.action === 'install' || (update && (previous?.serviceOrigin || previous?.resourceOrigin))
          ? await this.services?.describeDelivery(job.packageName)
          : undefined
      const expected = retry ?? preinstall
      const retained = expected && this.matchingReceipt(actor, instance, expected.plugin, job.source)
      if (
        retry &&
        (retry.instance !== instance ||
          !retained ||
          (retained.record.serviceOrigin && retained.record.serviceOrigin !== binding?.serviceOrigin) ||
          (retained.record.resourceOrigin && retained.record.resourceOrigin !== binding?.resourceOrigin) ||
          !(await retry.current()))
      )
        throw this.conflict()
      const verified = retained && expected && (await this.native.hasDelivery(expected.plugin, instance, origin, signal)) ? retained : undefined
      if (retained && !verified) this.receipts.get(instance)?.delete(job.packageName)
      if (retry && !verified) throw this.conflict()
      const application = verified
        ? { application: verified.application, version: verified.record.version, integrity: verified.record.integrity }
        : update
          ? {
              application: await this.runUpdate(update, actor, origin, signal, job.view.requestId, progress),
              version: update.replacement.next.version,
              integrity: update.replacement.next.integrity,
            }
          : preinstall
            ? await this.native.preinstall(actor, preinstall.plugin, instance, origin, signal, job.view.requestId, preinstall.current, progress)
            : job.view.action === 'install'
              ? await this.native.install(actor, job.packageName, instance, origin, signal, job.view.requestId, progress)
              : { application: await this.native.remove(actor, job.packageName, instance, origin, signal) }
      let record: PluginInstallation | undefined
      if (application && 'version' in application && application.integrity !== undefined) {
        const checked = binding?.version === application.version && binding.integrity === application.integrity ? binding : undefined
        const serviceOrigin = checked?.serviceOrigin && (!update || previous?.serviceOrigin === checked.serviceOrigin) ? checked.serviceOrigin : undefined
        const resourceOrigin = checked?.resourceOrigin && (!update || previous?.resourceOrigin === checked.resourceOrigin) ? checked.resourceOrigin : undefined
        record = verified?.record ?? {
          packageName: job.packageName,
          source: job.source,
          version: application.version,
          integrity: application.integrity,
          ...(serviceOrigin ? { serviceOrigin } : {}),
          ...(resourceOrigin ? { resourceOrigin } : {}),
        }
        if ('prepared' in application && application.prepared) {
          let receipts = this.receipts.get(instance)
          if (!receipts) this.receipts.set(instance, (receipts = new Map()))
          receipts.set(job.packageName, {
            record,
            application: application.application,
            artifact: application.prepared.artifact,
            preparationId: application.prepared.preparationId,
            epoch: actor.sessionEpoch,
          })
        }
      }
      if (!update) signal.throwIfAborted()
      await this.current(actor)
      if (preinstall && !(await preinstall.current())) throw new PluginPreinstallCancelled()
      if (retry && !(await retry.current())) throw this.conflict()
      if (!application) {
        job.outcome = 'skipped'
        job.view = { ...job.view, status: 'succeeded', phase: 'complete', application: 'applied' }
        return
      }
      if (record) {
        await this.records.save(actor.spaceId, record)
        this.receipts.get(instance)?.delete(job.packageName)
        if (record.serviceOrigin && application.application === 'applied')
          await this.settings?.apply(actor, instance, job.packageName, origin).catch(() => undefined)
      } else if (job.view.action === 'uninstall' && previous && (previous.serviceOrigin || previous.resourceOrigin)) {
        await this.records.save(actor.spaceId, {
          packageName: previous.packageName,
          source: previous.source,
          version: previous.version,
          ...(previous.integrity ? { integrity: previous.integrity } : {}),
        })
      }
      if (job.view.action === 'uninstall') this.receipts.get(instance)?.delete(job.packageName)
      job.outcome =
        application.application === 'restart-required' && preinstall?.instance.preinstallPlan?.firstEntry?.includes(job.packageName)
          ? 'restart-required'
          : 'succeeded'
      job.view = { ...job.view, status: 'succeeded', phase: 'complete', application: application.application }
    } catch (error) {
      job.outcome = signal.aborted || error instanceof PluginPreinstallCancelled ? 'cancelled' : 'failed'
      const restartRequired = job.update && error instanceof BusinessRuleError && error.params?.restartRequired === true
      const params = error instanceof BusinessRuleError && error.params ? { ...error.params } : undefined
      if (restartRequired && params) delete params.restartRequired
      const failure =
        job.update && error instanceof CommunityRuntimeUnavailableError
          ? { error: 'The member instance changed. Reload plugins before retrying.', code: 'plugin-update-changed' as const }
          : error instanceof BusinessRuleError || error instanceof CommunityAuthenticationError
            ? { error: error.message, code: error.code, ...(params ? { params } : {}) }
            : { error: 'The native plugin operation could not finish.', code: 'internal-error' as const }
      job.view = { ...job.view, status: 'failed', phase: 'complete', failure, ...(restartRequired ? { application: 'restart-required' } : {}) }
    }
  }
  private matchingReceipt(
    actor: CommunityAccountActor,
    instance: CommunityUserInstance,
    plugin: PreparedPlugin,
    source: PluginInstallation['source'],
  ): InstallReceipt | undefined {
    const retained = this.receipts.get(instance)?.get(plugin.packageName)
    if (!retained) return undefined
    if (
      retained.epoch === actor.sessionEpoch &&
      retained.record.source === source &&
      retained.record.version === plugin.version &&
      retained.record.integrity === plugin.integrity &&
      retained.artifact === plugin.artifact &&
      retained.preparationId === plugin.preparationId
    )
      return retained
    return undefined
  }
  private async runUpdate(
    update: Update,
    actor: CommunityAccountActor,
    origin: URL,
    signal: AbortSignal,
    requestId: string,
    progress: (phase: 'downloading' | 'installing') => void,
  ) {
    const replace = () => this.native.update(actor, update.instance, origin, update.replacement, signal, requestId, update.assertCurrent, progress)
    return this.runtime.withPluginReplacement ? await this.runtime.withPluginReplacement(update.instance, replace) : await replace()
  }
  async cancelSpace(spaceId: string): Promise<void> {
    const running = [...this.jobs.values()].filter(job => job.spaceId === spaceId && job.view.status === 'running')
    for (const job of running) job.abort.abort()
    await this.settings?.cancelSpace(spaceId)
    await Promise.allSettled(running.map(job => job.work))
  }
  private prune(): void {
    const completed = [...this.jobs.entries()].filter(([, job]) => job.view.status !== 'running')
    for (const [key] of completed.slice(0, Math.max(0, completed.length - 200))) this.jobs.delete(key)
  }
  async drain(): Promise<void> {
    await Promise.allSettled([...this.jobs.values()].map(job => job.work))
  }
  async stop(): Promise<void> {
    this.shutdown.abort()
    await this.drain()
  }
  private async current(actor: CommunityAccountActor) {
    const account = await this.accounts.get(actor.username)
    if (!account || account.disabled || account.spaceId !== actor.spaceId || account.sessionEpoch !== actor.sessionEpoch)
      throw new CommunityAuthenticationError('Sign in is required', 'sign-in-required')
  }
  private conflict() {
    return new BusinessRuleError('conflict', 'This plugin operation cannot be started. Refresh its status before retrying.', 'plugin-market-unavailable')
  }
}
