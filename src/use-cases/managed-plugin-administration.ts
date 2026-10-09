import { samePluginAccessSnapshot } from '../domain/plugin-access.js'
import type { MemberPluginAccessPort } from '../ports/plugin-access.js'
import type { CommunityAccountActor } from '../domain/community-account.js'
import { CommunityAuthenticationError } from '../domain/community-account.js'
import { BusinessRuleError } from '../domain/business-error.js'
import { assertOrdinaryGroup, requiredCommunityGroup } from '../domain/community-group.js'
import type { CommunityManagedGroupView } from '../domain/admin-contract.js'
import type { CommunityAccountStorePort } from '../ports/community-accounts.js'
import type { PluginLibraryStorePort } from '../ports/plugin-library.js'
import type { MemberManagedPluginsPort, PluginGrantsPort } from '../ports/managed-plugins.js'
import type { CommunityRuntimePort, CommunityUserInstance } from '../ports/community-runtime.js'
import type { CommunityInstanceActions } from './community-instance-actions.js'

/** Grant policy and pending-state projection; instance lifecycle remains the startup-state owner. */
export class ManagedPluginAdministration {
  constructor(private readonly accounts: Pick<CommunityAccountStorePort, 'get' | 'list' | 'listGroups'>,
    private readonly library: PluginLibraryStorePort, private readonly grants: PluginGrantsPort,
    private readonly managed: Pick<MemberManagedPluginsPort, 'effective'>, private readonly runtime: Pick<CommunityRuntimePort, 'status'>,
    private readonly actions: Pick<CommunityInstanceActions, 'restart'>, private readonly runtimeRevision: string, private readonly pluginAccess?: Pick<MemberPluginAccessPort, 'snapshot'>) {}
  grantCount(id: string): number {
    return this.accounts.listGroups().find(group => group.id === id)?.kind === 'admin' ? this.library.list().filter(row => !row.removing).length : this.grants.get(id).length
  }
  group(actor: CommunityAccountActor, id: string): CommunityManagedGroupView {
    this.assertAdmin(actor)
    const group = requiredCommunityGroup(this.accounts.listGroups(), id)
    const grants = new Set(this.grants.get(id))
    return { group, plugins: this.library.list().map(row => ({ packageName: row.packageName, title: row.current?.title ?? row.packageName,
      version: row.current?.version ?? null, ...(row.incompatible ? { incompatible: true } : {}), granted: group.kind === 'admin' || grants.has(row.packageName), available: !row.removing && row.stage === 'available' && row.current?.runtimeRevision === this.runtimeRevision,
      failures: this.failures(row.packageName, id) })), pendingMembers: this.pending(id).map(account => account.username) }
  }
  save(actor: CommunityAccountActor, id: string, packages: readonly string[]): CommunityManagedGroupView {
    this.assertAdmin(actor); assertOrdinaryGroup(requiredCommunityGroup(this.accounts.listGroups(), id))
    const existing = new Set(this.grants.get(id))
    const rows = new Map(this.library.list().map(row => [row.packageName, row]))
    if (packages.some(name => { const row = rows.get(name); return !row || row.removing || (!existing.has(name) && (row.stage !== 'available' || row.current?.runtimeRevision !== this.runtimeRevision)) })) throw new BusinessRuleError('invalid', 'Select plugins from the library.', 'plugin-grant-invalid')
    this.grants.set(id, packages)
    return this.group(actor, id)
  }
  async restartAffected(actor: CommunityAccountActor, id: string, origin: URL): Promise<CommunityManagedGroupView> {
    this.assertAdmin(actor); requiredCommunityGroup(this.accounts.listGroups(), id)
    for (const account of this.pending(id)) {
      this.assertAdmin(actor)
      if (this.pending(id).some(current => current.spaceId === account.spaceId)) await this.actions.restart(account, origin)
    }
    return this.group(actor, id)
  }
  failures(packageName: string, groupId?: string): readonly { username: string, code: 'plugin-managed-load-failed' }[] {
    return this.accounts.list().flatMap(account => {
      if (groupId !== undefined && account.groupId !== groupId) return []
      const state = this.runtime.status(account.username)
      return state.state === 'ready' && state.instance.managedFailures?.includes(packageName) ? [{ username: account.username, code: 'plugin-managed-load-failed' as const }] : []
    })
  }
  private pending(id: string) {
    return this.accounts.list().filter(account => {
      if (account.disabled || account.groupId !== id) return false
      const status = this.runtime.status(account.username)
      if (status.state !== 'ready') return false
      const expected = this.managed.effective(account.username).map(plugin => `${plugin.packageName}@${plugin.version}:${plugin.integrity}`).sort()
      return !samePluginAccessSnapshot(this.pluginAccess?.snapshot(account.username) ?? [], status.instance.pluginAccessSnapshot) || JSON.stringify(expected) !== JSON.stringify(this.snapshot(status.instance))
    })
  }
  private snapshot(instance: CommunityUserInstance) { return [...(instance.managedSnapshot ?? [])].sort() }
  private assertAdmin(actor: CommunityAccountActor): void {
    const account = this.accounts.get(actor.username)
    if (!account || account.disabled || account.spaceId !== actor.spaceId || account.sessionEpoch !== actor.sessionEpoch) throw new CommunityAuthenticationError('Sign in is required', 'sign-in-required')
    if (!account.admin) throw new BusinessRuleError('forbidden', 'Administrator access is required', 'admin-required')
  }
}
