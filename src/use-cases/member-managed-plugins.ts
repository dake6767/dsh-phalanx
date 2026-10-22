import { combineAcquisitionSources } from '../domain/acquisition-sources.js'
import type { PluginLocalCopies } from './plugin-local-copies.js'
import type { PluginSelectionsPort } from '../ports/plugin-selections.js'
import type { PreparedPlugin } from '../domain/plugin-library.js'
import type { CommunityAccountStorePort } from '../ports/community-accounts.js'
import type { PluginLibraryStorePort } from '../ports/plugin-library.js'
import type { MemberManagedPluginsPort, PluginGrantsPort, SelfInstalledPlugin } from '../ports/managed-plugins.js'
import type { ExpertPluginsPort } from '../ports/experts.js'

/** Eligibility policy only; running instances retain their startup selection. */
export class MemberManagedPlugins implements MemberManagedPluginsPort {
  constructor(private readonly accounts: Pick<CommunityAccountStorePort, 'get' | 'listGroups'>,
    private readonly library: PluginLibraryStorePort, private readonly grants: PluginGrantsPort, private readonly runtimeRevision: string, private readonly selections?: Pick<PluginSelectionsPort, 'get' | 'retainPackages'>, private readonly localCopies?: Pick<PluginLocalCopies, 'enabled'>, private readonly experts?: ExpertPluginsPort) {}
  effective(username: string, installed: readonly string[] = []) { return this.selected(username, this.experts?.plugins(username).filter(row => installed.includes(row.packageName)).map(row => row.packageName) ?? []) }
  accessible(username: string) { return this.selected(username, this.experts?.plugins(username).map(row => row.packageName) ?? []) }
  private selected(username: string, expertNames: readonly string[]) {
    const account = this.accounts.get(username)
    if (!account || account.disabled) return []
    if (!this.accounts.listGroups().some(group => group.id === account.groupId)) return []
    const selected = new Set(this.selections?.get(account.spaceId) ?? [])
    const acquired = combineAcquisitionSources([
      { source: 'managed', names: this.granted(username) },
      { source: 'selected', names: this.library.list().filter(row => row.published && selected.has(row.packageName)).map(row => row.packageName) },
      { source: 'managed', names: expertNames },
    ])
    return this.library.list().flatMap(row => !row.removing && !row.incompatible && row.stage === 'available' && row.current?.runtimeRevision === this.runtimeRevision
      && !this.localCopies?.enabled(username, row.packageName) && acquired.has(row.packageName) ? [row.current] : []).sort((a, b) => a.packageName.localeCompare(b.packageName))
  }
  localSelection(username: string): readonly string[] { return this.library.list().filter(row => this.localCopies?.enabled(username, row.packageName)).map(row => row.packageName).sort() }
  granted(username: string): readonly string[] {
    const account = this.accounts.get(username)
    if (!account || account.disabled) return []
    const group = this.accounts.listGroups().find(group => group.id === account.groupId)
    if (!group) return []
    return this.grants.get(group.id)
  }
  yielding(selected: readonly PreparedPlugin[], installed: readonly SelfInstalledPlugin[]) {
    const names = new Set(selected.map(plugin => plugin.packageName))
    return installed.filter(plugin => names.has(plugin.packageName)).flatMap(plugin => plugin.entries.map(entry => ({ ...entry, disabled: true as const })))
  }
  recover(): void {
    this.grants.retainGroups(this.accounts.listGroups().map(group => group.id))
    this.selections?.retainPackages(this.library.list().filter(row => !row.removing && (row.published || row.restorePublication)).map(row => row.packageName))
  }
}
