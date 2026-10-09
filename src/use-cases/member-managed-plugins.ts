import type { PluginSelectionsPort } from '../ports/plugin-selections.js'
import type { PreparedPlugin } from '../domain/plugin-library.js'
import type { CommunityAccountStorePort } from '../ports/community-accounts.js'
import type { PluginLibraryStorePort } from '../ports/plugin-library.js'
import type { MemberManagedPluginsPort, PluginGrantsPort, SelfInstalledPlugin } from '../ports/managed-plugins.js'

/** Eligibility policy only; running instances retain their startup selection. */
export class MemberManagedPlugins implements MemberManagedPluginsPort {
  constructor(private readonly accounts: Pick<CommunityAccountStorePort, 'get' | 'listGroups'>,
    private readonly library: PluginLibraryStorePort, private readonly grants: PluginGrantsPort, private readonly runtimeRevision: string, private readonly selections?: Pick<PluginSelectionsPort, 'get' | 'retainPackages'>) {}
  effective(username: string) {
    const account = this.accounts.get(username)
    if (!account || account.disabled) return []
    if (!this.accounts.listGroups().some(group => group.id === account.groupId)) return []
    const granted = new Set(this.granted(username))
    const selected = new Set(this.selections?.get(account.spaceId) ?? [])
    return this.library.list().flatMap(row => !row.removing && !row.incompatible && row.stage === 'available' && row.current?.runtimeRevision === this.runtimeRevision
      && (granted.has(row.packageName) || row.published && selected.has(row.packageName)) ? [row.current] : []).sort((a, b) => a.packageName.localeCompare(b.packageName))
  }
  granted(username: string): readonly string[] {
    const account = this.accounts.get(username)
    if (!account || account.disabled) return []
    const group = this.accounts.listGroups().find(group => group.id === account.groupId)
    if (!group) return []
    return group.kind === 'admin' ? this.library.list().filter(row => !row.removing).map(row => row.packageName) : this.grants.get(group.id)
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
