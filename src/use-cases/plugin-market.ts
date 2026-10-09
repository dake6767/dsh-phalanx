import type { CommunityAccountActor } from '../domain/community-account.js'
import { CommunityAuthenticationError } from '../domain/community-account.js'
import { BusinessRuleError } from '../domain/business-error.js'
import type { CommunityMarketPageData } from '../domain/admin-contract.js'
import type { CommunityAccountStorePort } from '../ports/community-accounts.js'
import type { PluginLibraryStorePort } from '../ports/plugin-library.js'
import type { MemberPluginManagerPort } from '../ports/plugin-market.js'
import type { PluginSelectionsPort } from '../ports/plugin-selections.js'
import type { CommunityRuntimePort, CommunityUserInstance } from '../ports/community-runtime.js'
import type { MemberManagedPlugins } from './member-managed-plugins.js'

/** Platform-owned choices; native member installations are observed, never changed. */
export class PluginMarket {
  constructor(private readonly accounts: Pick<CommunityAccountStorePort, 'get' | 'list'>, private readonly library: PluginLibraryStorePort,
    private readonly manager: Pick<MemberPluginManagerPort, 'list'>, private readonly runtime: Pick<CommunityRuntimePort, 'ensure'>,
    private readonly selections: PluginSelectionsPort, private readonly managed: Pick<MemberManagedPlugins, 'effective' | 'granted'>, private readonly runtimeRevision: string) {}
  selectedCount(packageName: string): number {
    const selected = new Set(this.selections.members(packageName))
    return this.accounts.list().filter(account => selected.has(account.spaceId)).length
  }
  publish(actor: CommunityAccountActor, packageName: string, published: boolean, confirmation?: { readonly confirmed?: true, readonly selectedMembers?: number }): void {
    const account = this.current(actor)
    if (!account.admin) throw new BusinessRuleError('forbidden', 'Administrator access is required', 'admin-required')
    const row = this.library.list().find(row => row.packageName === packageName)
    if (!row || row.removing || (published && (row.incompatible || row.stage !== 'available' || row.current?.runtimeRevision !== this.runtimeRevision))) throw this.unavailable()
    if (!published && (confirmation?.confirmed !== true || confirmation.selectedMembers !== this.selectedCount(packageName))) throw new BusinessRuleError('conflict', 'Review the affected selections before unpublishing.', 'plugin-impact-changed')
    // An interrupted unpublish must finish clearing choices before publication can resume.
    if (published && !row.published && !row.restorePublication) this.selections.removePackage(packageName)
    this.library.save({ ...row, published, restorePublication: false })
    if (!published) this.selections.removePackage(packageName)
  }
  async list(actor: CommunityAccountActor, origin: URL, signal: AbortSignal): Promise<CommunityMarketPageData> {
    this.current(actor)
    const instance = await this.runtime.ensure(actor.username, origin.href)
    const installed = new Set((await this.manager.list(instance, origin, signal)).map(row => row.packageName))
    const account = this.current(actor)
    const granted = new Set(this.managed.granted(actor.username)), selected = new Set(this.selections.get(account.spaceId))
    return { pending: this.pending(actor.username, instance), plugins: this.available(actor.username).map(plugin => ({ packageName: plugin.packageName, title: plugin.title, description: plugin.description, version: plugin.version,
      status: granted.has(plugin.packageName) ? 'managed' : selected.has(plugin.packageName) ? 'selected' : installed.has(plugin.packageName) ? 'native' : 'install' })) }
  }
  async install(actor: CommunityAccountActor, packageName: string, origin: URL, signal: AbortSignal) {
    this.current(actor)
    const instance = await this.runtime.ensure(actor.username, origin.href)
    const installed = await this.manager.list(instance, origin, signal)
    const account = this.current(actor)
    if (!this.available(actor.username).some(row => row.packageName === packageName) || this.managed.granted(actor.username).includes(packageName)) throw this.unavailable()
    const selected = this.selections.get(account.spaceId)
    if (!selected.includes(packageName) && installed.some(row => row.packageName === packageName)) throw this.unavailable()
    this.selections.set(account.spaceId, [...selected, packageName])
    return { application: this.pending(actor.username, instance) ? 'restart-required' as const : 'applied' as const }
  }
  async uninstall(actor: CommunityAccountActor, packageName: string, origin: URL, signal: AbortSignal) {
    this.current(actor)
    const instance = await this.runtime.ensure(actor.username, origin.href)
    signal.throwIfAborted()
    const account = this.current(actor)
    if (this.managed.granted(actor.username).includes(packageName)) throw this.unavailable()
    this.selections.set(account.spaceId, this.selections.get(account.spaceId).filter(name => name !== packageName))
    return { application: this.pending(actor.username, instance) ? 'restart-required' as const : 'applied' as const }
  }
  private pending(username: string, instance: CommunityUserInstance): boolean {
    const expected = this.managed.effective(username).map(plugin => `${plugin.packageName}@${plugin.version}:${plugin.integrity}`).sort()
    return JSON.stringify(expected) !== JSON.stringify([...(instance.managedSnapshot ?? [])].sort())
  }
  private available(username: string) {
    const granted = new Set(this.managed.granted(username))
    return this.library.list().flatMap(row => !row.removing && !row.incompatible && (row.published || granted.has(row.packageName)) && row.stage === 'available' && row.current?.runtimeRevision === this.runtimeRevision ? [row.current] : [])
  }
  private unavailable() { return new BusinessRuleError('conflict', 'This plugin is not available in the marketplace.', 'plugin-market-unavailable') }
  private current(actor: CommunityAccountActor) {
    const account = this.accounts.get(actor.username)
    if (!account || account.disabled || account.spaceId !== actor.spaceId || account.sessionEpoch !== actor.sessionEpoch) throw new CommunityAuthenticationError('Sign in is required', 'sign-in-required')
    return account
  }
}
