import { newerPluginVersion } from '../domain/plugin-version.js'
import type { CommunityAccountActor } from '../domain/community-account.js'
import { CommunityAuthenticationError } from '../domain/community-account.js'
import { BusinessRuleError } from '../domain/business-error.js'
import type { CommunityMarketPluginView } from '../domain/admin-contract.js'
import type { CommunityAccountStorePort } from '../ports/community-accounts.js'
import type { PluginLibraryStorePort } from '../ports/plugin-library.js'
import type { MemberPluginManagerPort, PluginDownloadTokensPort } from '../ports/plugin-market.js'
import type { CommunityRuntimePort, CommunityUserInstance } from '../ports/community-runtime.js'
import type { Clock } from '../ports/clock.js'

/** Publication and per-member distribution of the already checked original bytes. */
export class PluginMarket {
  constructor(private readonly accounts: Pick<CommunityAccountStorePort, 'get'>, private readonly library: PluginLibraryStorePort,
    private readonly manager: MemberPluginManagerPort, private readonly runtime: Pick<CommunityRuntimePort, 'ensure'>,
    private readonly tokens: PluginDownloadTokensPort, private readonly clock: Clock, private readonly runtimeRevision: string) {}
  publish(actor: CommunityAccountActor, packageName: string, published: boolean): void {
    const account = this.current(actor)
    if (!account.admin) throw new BusinessRuleError('forbidden', 'Administrator access is required', 'admin-required')
    const row = this.library.list().find(row => row.packageName === packageName)
    if (!row || row.removing || (published && (row.stage !== 'available' || row.current?.runtimeRevision !== this.runtimeRevision))) throw this.unavailable()
    this.library.save({ ...row, published, restorePublication: false })
  }
  async list(actor: CommunityAccountActor, origin: URL, signal: AbortSignal): Promise<readonly CommunityMarketPluginView[]> {
    this.current(actor)
    const instance = await this.runtime.ensure(actor.username, origin.href)
    const installed = new Map((await this.manager.list(instance, origin, signal)).map(row => [row.packageName, row.version]))
    this.current(actor)
    return this.available().map(plugin => ({ packageName: plugin.packageName, title: plugin.title, description: plugin.description, version: plugin.version,
      status: this.isManaged(instance, plugin.packageName) ? 'installed' : !installed.has(plugin.packageName) ? 'install' : newerPluginVersion(plugin.version, installed.get(plugin.packageName)!) ? 'update' : 'installed' }))
  }
  async install(actor: CommunityAccountActor, packageName: string, origin: URL, signal: AbortSignal) {
    this.current(actor)
    const plugin = this.available().find(row => row.packageName === packageName)
    if (!plugin) throw this.unavailable()
    const instance = await this.runtime.ensure(actor.username, origin.href)
    this.current(actor)
    if (this.isManaged(instance, packageName) || !this.available().some(row => row.integrity === plugin.integrity)) throw this.unavailable()
    const token = this.tokens.issue({ username: actor.username, spaceId: actor.spaceId, integrity: plugin.integrity, expiresAt: this.clock.now() + 120000 })
    return { application: await this.manager.install(instance, origin, `http://plugins.dsh-phalanx.invalid/plugin-archive/${token}.tgz`, plugin.integrity, signal) }
  }
  download(token: string, username: string) {
    const grant = this.tokens.read(token)
    const account = this.accounts.get(username)
    if (!grant || !account || account.disabled || grant.username !== username || grant.spaceId !== account.spaceId || grant.expiresAt <= this.clock.now())
      throw new BusinessRuleError('forbidden', 'This plugin download is unavailable.', 'plugin-download-denied')
    const plugin = this.available().find(row => row.integrity === grant.integrity)
    if (!plugin) throw this.unavailable()
    return plugin
  }
  private isManaged(instance: CommunityUserInstance, packageName: string) { return instance.managedSnapshot?.some(identity => identity.startsWith(packageName + '@')) ?? false }
  private available() { return this.library.list().flatMap(row => !row.removing && row.published && row.stage === 'available' && row.current?.runtimeRevision === this.runtimeRevision ? [row.current] : []) }
  private unavailable() { return new BusinessRuleError('conflict', 'This plugin is not available in the marketplace.', 'plugin-market-unavailable') }
  private current(actor: CommunityAccountActor) {
    const account = this.accounts.get(actor.username)
    if (!account || account.disabled || account.spaceId !== actor.spaceId || account.sessionEpoch !== actor.sessionEpoch) throw new CommunityAuthenticationError('Sign in is required', 'sign-in-required')
    return account
  }
}
