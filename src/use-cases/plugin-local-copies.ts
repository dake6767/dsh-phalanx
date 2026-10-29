import { BusinessRuleError } from '../domain/business-error.js'
import { CommunityAuthenticationError, type CommunityAccountActor } from '../domain/community-account.js'
import { sameMaintainer } from '../domain/library-contribution.js'
import { usesSharedPluginCredential } from '../domain/plugin-upstream.js'
import type { CommunityAccountStorePort } from '../ports/community-accounts.js'
import type { ExpertPluginsPort } from '../ports/experts.js'
import type { PluginGrantsPort } from '../ports/managed-plugins.js'
import type { PluginAuthorizationViewPort, PluginLibraryStorePort } from '../ports/plugin-library.js'
import type { PluginSelectionsPort } from '../ports/plugin-selections.js'
import type { PluginUpstreamsPort } from '../ports/plugin-upstreams.js'
import { KeyedOperations } from './support/keyed-operations.js'

/** Member preference never changes grants; current immutable maintainer identity gates its effect. */
export class PluginLocalCopies {
  private readonly operations = new KeyedOperations()

  constructor(
    private readonly accounts: Pick<CommunityAccountStorePort, 'get' | 'listGroups'>,
    private readonly library: Pick<PluginLibraryStorePort, 'list'> & PluginAuthorizationViewPort,
    private readonly grants: Pick<PluginGrantsPort, 'get'> & PluginAuthorizationViewPort,
    private readonly selections: Pick<PluginSelectionsPort, 'get'> & PluginAuthorizationViewPort,
    private readonly preferences: Pick<PluginSelectionsPort, 'get' | 'set'> & PluginAuthorizationViewPort,
    private readonly runtimeRevision: string,
    private readonly experts?: ExpertPluginsPort,
    private readonly upstreams?: Pick<PluginUpstreamsPort, 'list'>,
  ) {}
  revision(): string {
    return JSON.stringify([
      this.preferences.authorizationRevision(),
      this.selections.authorizationRevision(),
      this.grants.authorizationRevision(),
      this.library.authorizationRevision(),
    ])
  }
  async enabled(username: string, packageName: string): Promise<boolean> {
    const account = await this.accounts.get(username)
    return account && !account.disabled ? ((await this.view(account, packageName))?.enabled ?? false) : false
  }
  async view(actor: CommunityAccountActor, packageName: string): Promise<{ readonly enabled: boolean } | undefined> {
    const account = await this.current(actor),
      row = (await this.library.list()).find(row => row.packageName === packageName)
    const group = (await this.accounts.listGroups()).find(row => row.id === account.groupId)
    if (
      !row ||
      row.removing ||
      row.incompatible ||
      row.stage !== 'available' ||
      row.current?.runtimeRevision !== this.runtimeRevision ||
      !row.provenance?.maintainer ||
      !sameMaintainer(row.provenance.maintainer, account) ||
      !group ||
      !(
        (await this.grants.get(group.id)).includes(packageName) ||
        (row.published &&
          usesSharedPluginCredential((await this.upstreams?.list(packageName)) ?? []) &&
          (await this.selections.get(account.spaceId)).includes(packageName)) ||
        (await this.experts?.plugins(account.username))?.some(plugin => plugin.packageName === packageName)
      )
    )
      return undefined
    return { enabled: (await this.preferences.get(account.spaceId)).includes(packageName) }
  }
  async set(actor: CommunityAccountActor, packageName: string, enabled: boolean): Promise<void> {
    return await this.operations.run(actor.spaceId, async () => {
      if (typeof enabled !== 'boolean' || !(await this.view(actor, packageName)))
        throw new BusinessRuleError('forbidden', 'Only the authorized maintainer can choose a local copy.', 'plugin-local-copy-unavailable')
      const values = (await this.preferences.get(actor.spaceId)).filter(name => name !== packageName)
      await this.preferences.set(actor.spaceId, enabled ? [...values, packageName] : values)
    })
  }
  private async current(actor: CommunityAccountActor) {
    const account = await this.accounts.get(actor.username)
    if (!account || account.disabled || account.spaceId !== actor.spaceId || account.sessionEpoch !== actor.sessionEpoch)
      throw new CommunityAuthenticationError('Sign in is required', 'sign-in-required')
    return account
  }
}
