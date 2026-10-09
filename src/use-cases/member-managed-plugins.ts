import type { PreparedPlugin } from '../domain/plugin-library.js'
import type { CommunityAccountStorePort } from '../ports/community-accounts.js'
import type { PluginLibraryStorePort } from '../ports/plugin-library.js'
import type { MemberManagedPluginsPort, PluginGrantsPort, SelfInstalledPlugin } from '../ports/managed-plugins.js'

/** Eligibility policy only; running instances retain their startup selection. */
export class MemberManagedPlugins implements MemberManagedPluginsPort {
  constructor(private readonly accounts: Pick<CommunityAccountStorePort, 'get' | 'listGroups'>,
    private readonly library: PluginLibraryStorePort, private readonly grants: PluginGrantsPort, private readonly runtimeRevision: string) {}
  effective(username: string) {
    const account = this.accounts.get(username)
    if (!account || account.disabled) return []
    const group = this.accounts.listGroups().find(group => group.id === account.groupId)
    if (!group) return []
    const granted = new Set(this.grants.get(group.id))
    return this.library.list().flatMap(row => row.stage === 'available' && row.current?.runtimeRevision === this.runtimeRevision
      && (group.kind === 'admin' || granted.has(row.packageName)) ? [row.current] : []).sort((a, b) => a.packageName.localeCompare(b.packageName))
  }
  yielding(selected: readonly PreparedPlugin[], installed: readonly SelfInstalledPlugin[]) {
    const names = new Set(selected.map(plugin => plugin.packageName))
    return installed.filter(plugin => names.has(plugin.packageName)).flatMap(plugin => plugin.entries.map(entry => ({ ...entry, disabled: true as const })))
  }
  recover(): void { this.grants.retainGroups(this.accounts.listGroups().map(group => group.id)) }
}
