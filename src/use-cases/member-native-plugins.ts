import { BusinessRuleError } from '../domain/business-error.js'
import { CommunityAuthenticationError, type CommunityAccountActor } from '../domain/community-account.js'
import type { DownloadSourceValues } from '../domain/download-source.js'
import type { CommunityAccountReaderPort } from '../ports/community-accounts.js'
import type { CommunityUserInstance } from '../ports/community-runtime.js'
import type { MemberNativePluginManagerPort } from '../ports/member-native-plugins.js'
import type { NativePluginDownloads } from './native-plugin-downloads.js'

/** Native copies belong to members; installation never replaces an existing same-name copy. */
export class MemberNativePlugins {
  constructor(private readonly accounts: Pick<CommunityAccountReaderPort, 'get'>, private readonly downloads: NativePluginDownloads,
    private readonly manager: MemberNativePluginManagerPort, private readonly sources: { current(): Pick<DownloadSourceValues, 'npm'> }) {}
  async install(actor: CommunityAccountActor, packageName: string, instance: CommunityUserInstance, origin: URL, signal: AbortSignal, requestId: string) {
    this.current(actor, instance); signal.throwIfAborted()
    const before = this.downloads.issue(actor, packageName).plugin
    const installed = await this.manager.list(instance, origin, signal)
    this.current(actor, instance); signal.throwIfAborted()
    if (installed.some(row => row.packageName === packageName)) throw this.unavailable()
    const archive = this.downloads.issue(actor, packageName)
    if (archive.plugin.integrity !== before.integrity || archive.plugin.artifact !== before.artifact) throw this.unavailable()
    const application = await this.manager.install(instance, origin, { url: archive.url, integrity: archive.plugin.integrity }, { registry: this.sources.current().npm, requestId }, signal)
    this.current(actor, instance)
    return { application, version: archive.plugin.version }
  }
  async remove(actor: CommunityAccountActor, packageName: string, instance: CommunityUserInstance, origin: URL, signal: AbortSignal) {
    this.current(actor, instance); signal.throwIfAborted()
    const application = await this.manager.remove(instance, origin, packageName, signal)
    this.current(actor, instance)
    return application
  }
  private current(actor: CommunityAccountActor, instance: CommunityUserInstance) {
    const account = this.accounts.get(actor.username)
    if (!account || account.disabled || account.spaceId !== actor.spaceId || account.sessionEpoch !== actor.sessionEpoch || instance.userId !== actor.username)
      throw new CommunityAuthenticationError('Sign in is required', 'sign-in-required')
  }
  private unavailable() { return new BusinessRuleError('conflict', 'The plugin cannot replace an existing native copy or a changed library artifact.', 'plugin-market-unavailable') }
}
