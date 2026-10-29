import type { PluginSelectionsPort } from '../ports/plugin-selections.js'
import type { CommunityAccountStorePort } from '../ports/community-accounts.js'
import type { PluginGroupConfigurationPort } from '../ports/managed-plugins.js'
import type { PluginLibraryMembershipPort } from '../ports/plugin-library.js'

/** Group impact and removal policy for explicit grants and member selections. */
export class PluginLibraryMembership implements PluginLibraryMembershipPort {
  constructor(
    private readonly accounts: Pick<CommunityAccountStorePort, 'list' | 'listGroups'>,
    private readonly grants: PluginGroupConfigurationPort,
    private readonly selections?: PluginSelectionsPort,
  ) {}
  async impact(packageName: string) {
    const groups = new Set((await this.impactGroups(packageName)).map(group => group.id))
    const selected = new Set((await this.selections?.members(packageName)) ?? [])
    return {
      groups: groups.size,
      members: (await this.accounts.list()).filter(account => groups.has(account.groupId) || selected.has(account.spaceId)).length,
      selectedMembers: (await this.accounts.list()).filter(account => selected.has(account.spaceId)).length,
    }
  }
  /** The same impact with the affected groups named, for catalog uninstall previews. */
  async impactGroups(packageName: string): Promise<readonly { id: string; name: string }[]> {
    const affected: { id: string; name: string }[] = []
    for (const group of await this.accounts.listGroups())
      if ((await this.grants.get(group.id)).includes(packageName) || (await this.grants.preinstalls(group.id)).includes(packageName))
        affected.push({ id: group.id, name: group.name })
    return affected
  }
  async revoke(packageName: string): Promise<void> {
    await this.selections?.removePackage(packageName)
    for (const group of await this.accounts.listGroups()) {
      const before = await this.grants.get(group.id)
      const preinstalled = await this.grants.preinstalls(group.id)
      if (before.includes(packageName) || preinstalled.includes(packageName))
        await this.grants.configure(
          group.id,
          before.filter(name => name !== packageName),
          preinstalled.filter(name => name !== packageName),
        )
    }
  }
}
