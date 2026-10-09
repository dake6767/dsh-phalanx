import type { CommunityAccountStorePort } from '../ports/community-accounts.js'
import type { PluginGrantsPort } from '../ports/managed-plugins.js'
import type { PluginLibraryMembershipPort } from '../ports/plugin-library.js'

/** Group impact and removal policy, including implicit administrator membership. */
export class PluginLibraryMembership implements PluginLibraryMembershipPort {
  constructor(private readonly accounts: Pick<CommunityAccountStorePort, 'list' | 'listGroups'>, private readonly grants: PluginGrantsPort) {}
  impact(packageName: string) {
    const groups = new Set(this.accounts.listGroups().filter(group => group.kind === 'admin' || this.grants.get(group.id).includes(packageName)).map(group => group.id))
    return { groups: groups.size, members: this.accounts.list().filter(account => groups.has(account.groupId)).length }
  }
  revoke(packageName: string): void {
    for (const group of this.accounts.listGroups()) {
      const before = this.grants.get(group.id)
      if (before.includes(packageName)) this.grants.set(group.id, before.filter(name => name !== packageName))
    }
  }
}
