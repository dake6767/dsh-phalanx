import { CommunityAuthenticationError, type CommunityAccountActor } from '../domain/community-account.js'
import { BusinessRuleError } from '../domain/business-error.js'
import { sameMaintainer } from '../domain/library-contribution.js'
import type { CommunityAccountStorePort } from '../ports/community-accounts.js'
import type { PluginLibraryStorePort } from '../ports/plugin-library.js'
import type { PluginGrantsPort } from '../ports/managed-plugins.js'
import type { PluginSelectionsPort } from '../ports/plugin-selections.js'
import type { ExpertPluginsPort } from '../ports/experts.js'

/** Member preference never changes grants; current immutable maintainer identity gates its effect. */
export class PluginLocalCopies {
  constructor(private readonly accounts: Pick<CommunityAccountStorePort, 'get' | 'listGroups'>,
    private readonly library: Pick<PluginLibraryStorePort, 'list'>, private readonly grants: Pick<PluginGrantsPort, 'get'>,
    private readonly selections: Pick<PluginSelectionsPort, 'get'>, private readonly preferences: Pick<PluginSelectionsPort, 'get' | 'set'>,
    private readonly runtimeRevision: string, private readonly experts?: ExpertPluginsPort) {}
  enabled(username: string, packageName: string): boolean {
    const account = this.accounts.get(username), row = this.library.list().find(row => row.packageName === packageName && !row.removing)
    return !!account && !account.disabled && !!row?.provenance?.maintainer && sameMaintainer(row.provenance.maintainer, account)
      && this.preferences.get(account.spaceId).includes(packageName)
  }
  view(actor: CommunityAccountActor, packageName: string): { readonly enabled: boolean } | undefined {
    const account = this.current(actor), row = this.library.list().find(row => row.packageName === packageName)
    const group = this.accounts.listGroups().find(row => row.id === account.groupId)
    if (!row || row.removing || row.incompatible || row.stage !== 'available' || row.current?.runtimeRevision !== this.runtimeRevision
      || !row.provenance?.maintainer || !sameMaintainer(row.provenance.maintainer, account) || !group
      || !(group.kind === 'admin' || this.grants.get(group.id).includes(packageName) || row.published && this.selections.get(account.spaceId).includes(packageName)
        || this.experts?.plugins(account.username).some(plugin => plugin.packageName === packageName))) return undefined
    return { enabled: this.enabled(account.username, packageName) }
  }
  set(actor: CommunityAccountActor, packageName: string, enabled: boolean): void {
    if (typeof enabled !== 'boolean' || !this.view(actor, packageName)) throw new BusinessRuleError('forbidden', 'Only the authorized maintainer can choose a local copy.', 'plugin-local-copy-unavailable')
    const values = this.preferences.get(actor.spaceId).filter(name => name !== packageName)
    this.preferences.set(actor.spaceId, enabled ? [...values, packageName] : values)
  }
  private current(actor: CommunityAccountActor) {
    const account = this.accounts.get(actor.username)
    if (!account || account.disabled || account.spaceId !== actor.spaceId || account.sessionEpoch !== actor.sessionEpoch) throw new CommunityAuthenticationError('Sign in is required', 'sign-in-required')
    return account
  }
}
