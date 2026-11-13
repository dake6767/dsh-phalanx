import { BusinessRuleError } from '../domain/business-error.js'
import { CommunityAuthenticationError, type CommunityAccountActor } from '../domain/community-account.js'
import type { DownloadSourceValues } from '../domain/download-source.js'
import type { CommunityAccountReaderPort } from '../ports/community-accounts.js'
import type { CommunityUserInstance } from '../ports/community-runtime.js'
import type { MemberNativePluginManagerPort, NativePluginInstallPhase, NativePluginReplacement } from '../ports/member-native-plugins.js'
import type { NativePluginDownloads } from './native-plugin-downloads.js'
import type { PreparedPlugin } from '../domain/plugin-library.js'
import { PluginPreinstallCancelled } from '../domain/plugin-preinstall.js'

/** Native copies belong to members; installation never replaces an existing same-name copy. */
export class MemberNativePlugins {
  constructor(
    private readonly accounts: Pick<CommunityAccountReaderPort, 'get'>,
    private readonly downloads: NativePluginDownloads,
    private readonly manager: MemberNativePluginManagerPort,
    private readonly sources: { current(): Pick<DownloadSourceValues, 'npm'> },
  ) {}
  async install(
    actor: CommunityAccountActor,
    packageName: string,
    instance: CommunityUserInstance,
    origin: URL,
    signal: AbortSignal,
    requestId: string,
    progress?: (phase: NativePluginInstallPhase) => void,
  ) {
    return (await this.deliver(actor, packageName, instance, origin, signal, requestId, progress))!
  }
  async preinstall(
    actor: CommunityAccountActor,
    plugin: PreparedPlugin,
    instance: CommunityUserInstance,
    origin: URL,
    signal: AbortSignal,
    requestId: string,
    current: () => Promise<boolean>,
    progress?: (phase: NativePluginInstallPhase) => void,
  ) {
    return await this.deliver(actor, plugin.packageName, instance, origin, signal, requestId, progress, { plugin, current })
  }
  async hasDelivery(plugin: PreparedPlugin, instance: CommunityUserInstance, origin: URL, signal: AbortSignal): Promise<boolean> {
    const row = (await this.manager.list(instance, origin, signal)).find(row => row.packageName === plugin.packageName)
    return (
      row?.version === plugin.version &&
      row.archiveIntegrity === plugin.integrity &&
      row.retainedArchive === true &&
      (await this.manager.verifyArchive?.(instance, plugin.packageName, plugin.integrity, signal)) === true
    )
  }
  private async deliver(
    actor: CommunityAccountActor,
    packageName: string,
    instance: CommunityUserInstance,
    origin: URL,
    signal: AbortSignal,
    requestId: string,
    progress?: (phase: NativePluginInstallPhase) => void,
    preinstall?: { readonly plugin: PreparedPlugin; readonly current: () => Promise<boolean> },
  ) {
    const assertCurrent = async () => {
      signal.throwIfAborted()
      await this.current(actor, instance)
      if (preinstall && !(await preinstall.current())) throw new PluginPreinstallCancelled()
    }
    await assertCurrent()
    const before = (await this.downloads.issue(actor, packageName)).plugin
    if (
      preinstall &&
      (before.integrity !== preinstall.plugin.integrity ||
        before.artifact !== preinstall.plugin.artifact ||
        before.preparationId !== preinstall.plugin.preparationId)
    )
      throw new PluginPreinstallCancelled()
    const installed = await this.manager.list(instance, origin, signal)
    await assertCurrent()
    if (installed.some(row => row.packageName === packageName)) {
      if (preinstall) return undefined
      throw this.unavailable()
    }
    const archive = await this.downloads.issue(actor, packageName)
    if (archive.plugin.integrity !== before.integrity || archive.plugin.artifact !== before.artifact) throw this.unavailable()
    const application = await this.manager.install(
      instance,
      origin,
      { url: archive.url, integrity: archive.plugin.integrity },
      {
        registry: (await this.sources.current()).npm,
        requestId,
        identity: { packageName, version: archive.plugin.version },
        ...(progress ? { progress } : {}),
      },
      signal,
    )
    // The preinstall job retains the signed result before rechecking admission and writing history.
    if (!preinstall) await assertCurrent()
    return { application, version: archive.plugin.version, integrity: archive.plugin.integrity, prepared: archive.plugin }
  }
  async update(
    actor: CommunityAccountActor,
    instance: CommunityUserInstance,
    origin: URL,
    replacement: NativePluginReplacement,
    signal: AbortSignal,
    requestId: string,
    assertCurrent: () => Promise<() => boolean>,
    progress: (phase: NativePluginInstallPhase) => void,
  ) {
    await this.current(actor, instance)
    if (!(await assertCurrent())()) throw new BusinessRuleError('conflict', 'The available plugin update changed.', 'plugin-update-changed')
    const archive = await this.downloads.issueUpdate(actor, replacement.packageName, async () => {
      signal.throwIfAborted()
      const current = await assertCurrent()
      return () => !signal.aborted && current()
    })
    try {
      if (!this.manager.replace || archive.plugin.version !== replacement.next.version || archive.plugin.integrity !== replacement.next.integrity)
        throw new BusinessRuleError('conflict', 'The available plugin update changed.', 'plugin-update-changed')
      return await this.manager.replace(
        instance,
        origin,
        { url: archive.url, integrity: archive.plugin.integrity, authorizationUrl: archive.authorizationUrl },
        replacement,
        { registry: (await this.sources.current()).npm, requestId, progress },
        signal,
      )
    } finally {
      archive.release()
    }
  }
  async remove(actor: CommunityAccountActor, packageName: string, instance: CommunityUserInstance, origin: URL, signal: AbortSignal) {
    await this.current(actor, instance)
    signal.throwIfAborted()
    const application = await this.manager.remove(instance, origin, packageName, signal)
    await this.current(actor, instance)
    return application
  }
  private async current(actor: CommunityAccountActor, instance: CommunityUserInstance) {
    const account = await this.accounts.get(actor.username)
    if (!account || account.disabled || account.spaceId !== actor.spaceId || account.sessionEpoch !== actor.sessionEpoch || instance.userId !== actor.username)
      throw new CommunityAuthenticationError('Sign in is required', 'sign-in-required')
  }
  private unavailable() {
    return new BusinessRuleError('conflict', 'The plugin cannot replace an existing native copy or a changed library artifact.', 'plugin-market-unavailable')
  }
}
