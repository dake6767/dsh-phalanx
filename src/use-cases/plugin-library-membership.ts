import type { PluginSelectionsPort } from '../ports/plugin-selections.js'
import type { CommunityAccountStorePort } from '../ports/community-accounts.js'
import type { PluginGroupConfigurationPort } from '../ports/managed-plugins.js'
import type { PluginLibraryMembershipPort } from '../ports/plugin-library.js'

/** Group impact and removal policy for explicit grants and member selections. */
export class PluginLibraryMembership implements PluginLibraryMembershipPort {
  constructor(private readonly accounts: Pick<CommunityAccountStorePort, 'list' | 'listGroups'>, private readonly grants: PluginGroupConfigurationPort, private readonly selections?: PluginSelectionsPort) {}
  impact(packageName: string) {
    const groups = new Set(this.accounts.listGroups().filter(group => (this.grants.get(group.id).includes(packageName) || this.grants.preinstalls(group.id).includes(packageName))).map(group => group.id))
    const selected = new Set(this.selections?.members(packageName) ?? [])
    return { groups: groups.size, members: this.accounts.list().filter(account => groups.has(account.groupId) || selected.has(account.spaceId)).length, selectedMembers: this.accounts.list().filter(account => selected.has(account.spaceId)).length }
  }
  revoke(packageName: string): void {
    this.selections?.removePackage(packageName)
    for (const group of this.accounts.listGroups()) {
      const before = this.grants.get(group.id)
      const preinstalled = this.grants.preinstalls(group.id)
      if (before.includes(packageName) || preinstalled.includes(packageName)) this.grants.configure(group.id, before.filter(name => name !== packageName), preinstalled.filter(name => name !== packageName))
    }
  }
}
