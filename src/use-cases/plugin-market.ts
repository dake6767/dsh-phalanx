import type { CommunityMarketPageData, CommunityPluginContributionInfo } from '../domain/admin-contract.js'
import { nativeUpdateChoice } from '../domain/member-plugin-update.js'
import type { InstalledMarketPlugin } from '../ports/plugin-market.js'
import type { PreparedPlugin } from '../domain/plugin-library.js'
import { BusinessRuleError } from '../domain/business-error.js'
import type { CommunityAccountActor } from '../domain/community-account.js'
import { CommunityAuthenticationError } from '../domain/community-account.js'
import { redactContributionContent } from '../domain/contribution-checks.js'
import { sameContributionReceipt, type ContributionReceipt } from '../domain/contribution-receipt.js'
import { libraryContributionCredit, sameMaintainer } from '../domain/library-contribution.js'
import { samePluginAccessSnapshot } from '../domain/plugin-access.js'
import { usesSharedPluginCredential } from '../domain/plugin-upstream.js'
import type { CommunityAccountStorePort } from '../ports/community-accounts.js'
import type { CommunityRuntimePort, CommunityUserInstance } from '../ports/community-runtime.js'
import type { MemberPluginAccessPort } from '../ports/plugin-access.js'
import type { PluginAuthorizationViewPort, PluginLibraryStorePort } from '../ports/plugin-library.js'
import type { MemberPluginManagerPort } from '../ports/plugin-market.js'
import type { PluginSelectionsPort } from '../ports/plugin-selections.js'
import type { PluginUpstreamsPort } from '../ports/plugin-upstreams.js'
import type { MemberManagedPlugins } from './member-managed-plugins.js'
import type { MemberNativePluginJobs } from './member-native-plugin-jobs.js'
import type { PluginLocalCopies } from './plugin-local-copies.js'
import { KeyedOperations } from './support/keyed-operations.js'

/** Market eligibility, readonly choices and actual native inventory share one member view. */
export class PluginMarket {
  private readonly operations = new KeyedOperations()

  constructor(
    private readonly accounts: Pick<CommunityAccountStorePort, 'get' | 'list'>,
    private readonly library: PluginLibraryStorePort & Partial<PluginAuthorizationViewPort>,
    private readonly manager: MemberPluginManagerPort,
    private readonly runtime: Pick<CommunityRuntimePort, 'ensure'> & Partial<Pick<CommunityRuntimePort, 'status'>>,
    private readonly selections: PluginSelectionsPort,
    private readonly managed: Pick<MemberManagedPlugins, 'effective' | 'granted'>,
    private readonly runtimeRevision: string,
    private readonly pluginAccess?: Pick<MemberPluginAccessPort, 'snapshot'>,
    private readonly upstreams?: Pick<PluginUpstreamsPort, 'list' | 'authorizationRevision'>,
    private readonly localCopies?: Pick<PluginLocalCopies, 'view' | 'set'> & Partial<Pick<PluginLocalCopies, 'revision'>>,
    private readonly native?: MemberNativePluginJobs,
    private readonly libraryOperations = new KeyedOperations(),
  ) {}
  async selectedCount(packageName: string): Promise<number> {
    const selected = new Set(await this.selections.members(packageName))
    return (await this.accounts.list()).filter(account => selected.has(account.spaceId)).length
  }
  async publish(
    actor: CommunityAccountActor,
    packageName: string,
    published: boolean,
    confirmation?: { readonly confirmed?: true; readonly selectedMembers?: number },
  ): Promise<void> {
    return await this.libraryOperations.run(packageName, async () => {
      const account = await this.current(actor)
      if (!account.admin) throw new BusinessRuleError('forbidden', 'Administrator access is required', 'admin-required')
      await this.commitPublication(packageName, published, confirmation)
    })
  }
  /** Publish only a contribution whose confirmation already authorized credential sharing. */
  async publishContribution(packageName: string, confirmed: boolean, receipt: ContributionReceipt): Promise<readonly string[]> {
    return await this.libraryOperations.run(packageName, async () => {
      const row = (await this.library.list()).find(row => row.packageName === packageName)
      if (sameContributionReceipt(row?.contributionPublicationReceipt, receipt)) return row?.contributionPublicationReceipt?.warnings ?? []
      try {
        await this.commitPublication(packageName, true, confirmed ? { confirmed: true } : undefined, receipt)
      } catch (error) {
        if (!(error instanceof BusinessRuleError) || error.code !== 'plugin-publication-credential-confirmation' || !row) throw error
        const warnings = ['Platform credentials changed during adoption. Confirm credential sharing before publishing this plugin.']
        await this.library.save({ ...row, contributionPublicationReceipt: { ...receipt, warnings } })
        return warnings
      }
      return []
    })
  }
  private async commitPublication(
    packageName: string,
    published: boolean,
    confirmation?: { readonly confirmed?: true; readonly selectedMembers?: number },
    receipt?: ContributionReceipt,
  ): Promise<void> {
    const row = (await this.library.list()).find(row => row.packageName === packageName)
    if (!row || row.removing || (published && (row.incompatible || row.stage !== 'available' || row.current?.runtimeRevision !== this.runtimeRevision)))
      throw this.unavailable()
    if (published && (await this.upstreams?.list(packageName))?.some(row => row.credential.length > 0) && confirmation?.confirmed !== true)
      throw new BusinessRuleError('conflict', 'Confirm platform credential sharing', 'plugin-publication-credential-confirmation')
    if (!published && (confirmation?.confirmed !== true || confirmation.selectedMembers !== (await this.selectedCount(packageName))))
      throw new BusinessRuleError('conflict', 'Review the affected selections before unpublishing.', 'plugin-impact-changed')
    // An interrupted unpublish must finish clearing choices before publication can resume.
    if (published && !row.published && !row.restorePublication) await this.selections.removePackage(packageName)
    await this.library.save({ ...row, published, restorePublication: false, ...(receipt ? { contributionPublicationReceipt: receipt } : {}) })
    if (!published) await this.selections.removePackage(packageName)
  }
  async list(actor: CommunityAccountActor, origin: URL, signal: AbortSignal): Promise<CommunityMarketPageData> {
    await this.current(actor)
    const instance = await this.runtime.ensure(actor.username, origin.href)
    const installed = await this.manager.list(instance, origin, signal)
    const account = await this.current(actor)
    const granted = new Set(await this.managed.granted(actor.username)),
      selected = new Set(await this.selections.get(account.spaceId))
    const plugins = await Promise.all(
      (await this.available(actor.username)).map(async plugin => {
        const actual = installed.find(row => row.packageName === plugin.packageName),
          shared = await this.shared(plugin.packageName)
        const status = granted.has(plugin.packageName)
          ? ('managed' as const)
          : shared && selected.has(plugin.packageName)
            ? ('selected' as const)
            : actual
              ? !actual.version
                ? ('unknown' as const)
                : actual.retainedArchive
                  ? ('installed' as const)
                  : ('native' as const)
              : ('install' as const)
        const contribution = libraryContributionCredit((await this.library.list()).find(row => row.packageName === plugin.packageName)?.provenance)
        const candidate = await this.native?.get(actor, plugin.packageName, instance, actual)
        const choice = status === 'installed' && actual ? await this.updateChoice(actor, actual, plugin) : undefined
        const update = choice && actual && (await this.verifyArchive(instance, actual, signal)) ? choice : undefined
        const job =
          candidate?.status === 'running' ||
          status === 'installed' ||
          (status === 'install' && !shared) ||
          (candidate?.action === 'update' && candidate.status === 'failed')
            ? candidate
            : undefined
        return {
          packageName: plugin.packageName,
          title: plugin.title,
          description: plugin.description,
          version: plugin.version,
          status,
          ...(actual?.version && (status === 'installed' || status === 'native') ? { installedVersion: actual.version } : {}),
          ...(update ? { update } : {}),
          ...(contribution ? { contribution } : {}),
          ...(shared && status !== 'native' && status !== 'installed' ? { sharedCredential: true as const } : {}),
          ...(job ? { job } : {}),
        }
      }),
    )
    const unlistedUpdates = await this.native?.unlistedUpdates(actor, new Set(plugins.map(plugin => plugin.packageName)), instance, installed)
    return {
      ...(unlistedUpdates?.length ? { unlistedUpdates } : {}),
      pending:
        (await this.pending(
          actor.username,
          instance,
          installed.map(row => row.packageName),
        )) || plugins.some(row => row.job?.status === 'succeeded' && row.job.application === 'restart-required'),
      plugins,
    }
  }
  async install(actor: CommunityAccountActor, packageName: string, origin: URL, signal: AbortSignal, requestId?: string) {
    return await this.operations.run(actor.spaceId, async () => {
      await this.current(actor)
      const previous = await this.native?.get(actor, packageName)
      if (requestId && previous?.requestId === requestId) return { job: await this.native!.install(actor, packageName, origin, requestId) }
      const instance = await this.runtime.ensure(actor.username, origin.href)
      const installed = await this.manager.list(instance, origin, signal)
      signal.throwIfAborted()
      const account = await this.current(actor)
      if (
        !(await this.available(actor.username)).some(row => row.packageName === packageName) ||
        (await this.managed.granted(actor.username)).includes(packageName)
      )
        throw this.unavailable()
      const selected = await this.selections.get(account.spaceId),
        shared = await this.shared(packageName)
      if (installed.some(row => row.packageName === packageName) && !(shared && selected.includes(packageName))) throw this.unavailable()
      if (!shared) {
        if (!this.native) throw this.unavailable()
        return { job: await this.native.install(actor, packageName, origin, requestId ?? '') }
      }
      await this.selections.set(account.spaceId, [...selected, packageName])
      return { application: (await this.pending(actor.username, instance)) ? ('restart-required' as const) : ('applied' as const) }
    })
  }
  async update(actor: CommunityAccountActor, packageName: string, origin: URL, signal: AbortSignal, requestId: string, target: string) {
    return await this.operations.run(actor.spaceId, async () => {
      const jobs = this.native
      if (!jobs) throw this.updateChanged()
      const previous = await jobs.previousUpdate(actor, packageName, requestId, target)
      if (previous) return { job: previous }
      const instance = await this.runtime.ensure(actor.username, origin.href)
      const instanceCurrent = () => {
        const status = this.runtime.status?.(actor.username)
        return !status || (status.state === 'ready' && status.instance === instance)
      }
      const policyRevision = () =>
        JSON.stringify([this.library.authorizationRevision?.(), this.localCopies?.revision?.(), this.upstreams?.authorizationRevision?.(packageName)])
      const resolve = async (checkSignal: AbortSignal, verify: boolean) => {
        const revision = policyRevision()
        const current = () => instanceCurrent() && policyRevision() === revision
        await this.current(actor)
        if (!current()) throw this.updateChanged()
        const installed = await this.manager.list(instance, origin, checkSignal)
        const actual = installed.find(row => row.packageName === packageName)
        if (
          !actual?.version ||
          !actual.archiveIntegrity ||
          actual.enabled === undefined ||
          (verify && !(await this.verifyArchive(instance, actual, checkSignal)))
        )
          throw this.updateChanged()
        const plugin = (await this.available(actor.username)).find(entry => entry.packageName === packageName)
        const delivery = await jobs.delivery(actor, packageName)
        if (
          !plugin ||
          !delivery ||
          (await this.managed.granted(actor.username)).includes(packageName) ||
          ((await this.shared(packageName)) && (await this.selections.get(actor.spaceId)).includes(packageName)) ||
          (await this.updateChoice(actor, actual, plugin))?.target !== target
        )
          throw this.updateChanged()
        checkSignal.throwIfAborted()
        if (!current()) throw this.updateChanged()
        return {
          current,
          source: delivery.source,
          replacement: {
            packageName,
            previous: { version: actual.version, integrity: actual.archiveIntegrity, enabled: actual.enabled },
            next: { version: plugin.version, integrity: plugin.integrity },
          },
        }
      }
      const admitted = await resolve(signal, true)
      if (!admitted.current()) throw this.updateChanged()
      return {
        job: await jobs.update(actor, packageName, origin, requestId, {
          source: admitted.source,
          replacement: admitted.replacement,
          instance,
          target,
          assertCurrent: async () => {
            const fresh = await resolve(AbortSignal.timeout(15000), false)
            if (fresh.source !== admitted.source || fresh.replacement.previous.enabled !== admitted.replacement.previous.enabled) throw this.updateChanged()
            return fresh.current
          },
        }),
      }
    })
  }
  async uninstall(actor: CommunityAccountActor, packageName: string, origin: URL, signal: AbortSignal, requestId?: string) {
    return await this.operations.run(actor.spaceId, async () => {
      await this.current(actor)
      const previous = await this.native?.get(actor, packageName)
      if (requestId && previous?.requestId === requestId) return { job: await this.native!.remove(actor, packageName, origin, requestId) }
      const instance = await this.runtime.ensure(actor.username, origin.href)
      const installed = await this.manager.list(instance, origin, signal)
      signal.throwIfAborted()
      const account = await this.current(actor)
      if ((await this.managed.granted(actor.username)).includes(packageName)) throw this.unavailable()
      if ((await this.shared(packageName)) && (await this.selections.get(account.spaceId)).includes(packageName)) {
        await this.selections.set(
          account.spaceId,
          (await this.selections.get(account.spaceId)).filter(name => name !== packageName),
        )
        return { application: (await this.pending(actor.username, instance)) ? ('restart-required' as const) : ('applied' as const) }
      }
      const actual = installed.find(row => row.packageName === packageName)
      if (actual?.retainedArchive) {
        if (!this.native) throw this.unavailable()
        return { job: await this.native.remove(actor, packageName, origin, requestId ?? '') }
      }
      throw this.unavailable()
    })
  }
  async contributionDetails(actor: CommunityAccountActor, packageName: string): Promise<CommunityPluginContributionInfo> {
    await this.current(actor)
    const row = (await this.library.list()).find(row => row.packageName === packageName && !row.removing)
    const canMaintain = !!row?.provenance?.maintainer && sameMaintainer(row.provenance.maintainer, actor)
    if (!row || (!canMaintain && !(await this.available(actor.username)).some(plugin => plugin.packageName === packageName))) return { canMaintain: false }
    const contribution = libraryContributionCredit(row.provenance)
    const localCopy = await this.localCopies?.view(actor, packageName)
    return { canMaintain, ...(contribution ? { contribution } : {}), ...(localCopy ? { localCopy } : {}) }
  }
  async contributionDetailsFor(actor: CommunityAccountActor, packageName: string, origin: URL): Promise<CommunityPluginContributionInfo> {
    const info = await this.contributionDetails(actor, packageName)
    if (!info.localCopy) return info
    const instance = await this.runtime.ensure(actor.username, origin.href),
      fresh = await this.contributionDetails(actor, packageName)
    return {
      ...fresh,
      ...(fresh.localCopy
        ? { localCopy: { ...fresh.localCopy, application: (await this.pending(actor.username, instance)) ? 'restart-required' : 'applied' } }
        : {}),
    }
  }
  async useLocalCopy(actor: CommunityAccountActor, packageName: string, enabled: boolean, origin: URL) {
    await this.current(actor)
    if (!this.localCopies) throw this.unavailable()
    const instance = await this.runtime.ensure(actor.username, origin.href)
    await this.localCopies.set(actor, packageName, enabled)
    return { application: (await this.pending(actor.username, instance)) ? ('restart-required' as const) : ('applied' as const) }
  }
  private async pending(
    username: string,
    instance: CommunityUserInstance,
    installed: readonly string[] = instance.nativePluginSnapshot ?? [],
  ): Promise<boolean> {
    const expected = (await this.managed.effective(username, instance.nativePluginSnapshot))
      .map(plugin => `${plugin.packageName}@${plugin.version}:${plugin.integrity}`)
      .sort()
    return (
      !samePluginAccessSnapshot((await this.pluginAccess?.snapshot(username, installed)) ?? [], instance.pluginAccessSnapshot) ||
      JSON.stringify(expected) !== JSON.stringify([...(instance.managedSnapshot ?? [])].sort())
    )
  }
  private async available(username: string) {
    const granted = new Set(await this.managed.granted(username))
    return (await this.library.list()).flatMap(row =>
      !row.removing &&
      !row.incompatible &&
      (row.published || granted.has(row.packageName)) &&
      row.stage === 'available' &&
      row.current?.runtimeRevision === this.runtimeRevision
        ? [
            row.contributionReceipt
              ? { ...row.current, title: redactContributionContent(row.current.title), description: redactContributionContent(row.current.description) }
              : row.current,
          ]
        : [],
    )
  }
  private async verifyArchive(instance: CommunityUserInstance, actual: InstalledMarketPlugin, signal: AbortSignal) {
    return actual.archiveIntegrity && (await this.manager.verifyArchive?.(instance, actual.packageName, actual.archiveIntegrity, signal))
  }
  private async updateChoice(actor: CommunityAccountActor, actual: InstalledMarketPlugin, plugin: PreparedPlugin) {
    const row = (await this.library.list()).find(row => row.packageName === actual.packageName)
    const delivery = await this.native?.delivery(actor, actual.packageName)
    return row &&
      !row.removing &&
      !row.incompatible &&
      row.stage === 'available' &&
      row.current?.runtimeRevision === this.runtimeRevision &&
      row.current.version === plugin.version &&
      row.current.integrity === plugin.integrity &&
      row.current.artifact === plugin.artifact &&
      row.current.preparationId === plugin.preparationId &&
      row.current.sourceCommit === plugin.sourceCommit
      ? nativeUpdateChoice(actual, plugin, row, delivery)
      : undefined
  }
  private async shared(packageName: string) {
    return usesSharedPluginCredential((await this.upstreams?.list(packageName)) ?? [])
  }
  private updateChanged() {
    return new BusinessRuleError('conflict', 'The installed copy or available update changed.', 'plugin-update-changed')
  }
  private unavailable() {
    return new BusinessRuleError('conflict', 'This plugin is not available in the marketplace.', 'plugin-market-unavailable')
  }
  private async current(actor: CommunityAccountActor) {
    const account = await this.accounts.get(actor.username)
    if (!account || account.disabled || account.spaceId !== actor.spaceId || account.sessionEpoch !== actor.sessionEpoch)
      throw new CommunityAuthenticationError('Sign in is required', 'sign-in-required')
    return account
  }
}
