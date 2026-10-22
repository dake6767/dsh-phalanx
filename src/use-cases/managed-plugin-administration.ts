import { assertPluginGroupConfiguration } from '../domain/plugin-group-configuration.js'
import { usesSharedPluginCredential } from '../domain/plugin-upstream.js'
import type { PluginUpstreamsPort } from '../ports/plugin-upstreams.js'
import { sameContributionReceipt, type ContributionReceipt } from '../domain/contribution-receipt.js'
import { samePluginAccessSnapshot } from '../domain/plugin-access.js'
import type { MemberPluginAccessPort } from '../ports/plugin-access.js'
import type { CommunityAccountActor } from '../domain/community-account.js'
import { CommunityAuthenticationError } from '../domain/community-account.js'
import { BusinessRuleError } from '../domain/business-error.js'
import { assertOrdinaryGroup, requiredCommunityGroup } from '../domain/community-group.js'
import type { CommunityManagedGroupView } from '../domain/admin-contract.js'
import type { CommunityAccountStorePort } from '../ports/community-accounts.js'
import type { PluginLibraryStorePort } from '../ports/plugin-library.js'
import type { MemberManagedPluginsPort, PluginGroupConfigurationPort } from '../ports/managed-plugins.js'
import type { CommunityRuntimePort, CommunityUserInstance } from '../ports/community-runtime.js'
import type { CommunityInstanceActions } from './community-instance-actions.js'

/** Grant policy and pending-state projection; instance lifecycle remains the startup-state owner. */
export class ManagedPluginAdministration {
  constructor(private readonly accounts: Pick<CommunityAccountStorePort, 'get' | 'list' | 'listGroups'>,
    private readonly library: PluginLibraryStorePort, private readonly grants: PluginGroupConfigurationPort,
    private readonly managed: Pick<MemberManagedPluginsPort, 'effective'>, private readonly runtime: Pick<CommunityRuntimePort, 'status'>,
    private readonly actions: Pick<CommunityInstanceActions, 'restart'>, private readonly runtimeRevision: string, private readonly pluginAccess?: Pick<MemberPluginAccessPort, 'snapshot'>, private readonly upstreams?: Pick<PluginUpstreamsPort, 'list'>) {}
  grantCount(id: string): number {
    return this.grants.get(id).length + this.grants.preinstalls(id).length
  }
  group(actor: CommunityAccountActor, id: string): CommunityManagedGroupView {
    this.assertAdmin(actor)
    const group = requiredCommunityGroup(this.accounts.listGroups(), id)
    const grants = new Set(this.grants.get(id)), preinstalls = new Set(this.grants.preinstalls(id))
    return { group, revision: this.configurationRevision(id), preinstallIncompleteMembers: 0, plugins: this.library.list().map(row => ({ packageName: row.packageName, title: row.current?.title ?? row.packageName,
      version: row.current?.version ?? null, ...(row.incompatible ? { incompatible: true } : {}), granted: grants.has(row.packageName), preinstalled: preinstalls.has(row.packageName), hasPlatformCredential: this.sharedCredential(row.packageName), available: !row.removing && !row.incompatible && row.stage === 'available' && row.current?.runtimeRevision === this.runtimeRevision,
      ...this.inspection(row.packageName, id), failures: this.failures(row.packageName, id) })), pendingMembers: this.pending(id).map(account => account.username) }
  }
  save(actor: CommunityAccountActor, id: string, packages: readonly string[], preinstalls: readonly string[], revision: string): CommunityManagedGroupView {
    this.assertAdmin(actor); requiredCommunityGroup(this.accounts.listGroups(), id)
    if (revision !== this.configurationRevision(id)) throw new BusinessRuleError('conflict', 'Review the group configuration again.', 'plugin-impact-changed')
    assertPluginGroupConfiguration(packages, preinstalls)
    const existing = new Set(this.grants.get(id)), previousPreinstalls = new Set(this.grants.preinstalls(id))
    const rows = new Map(this.library.list().map(row => [row.packageName, row]))
    const invalid = (names: readonly string[], previous: ReadonlySet<string>) => names.some(name => {
      const row = rows.get(name)
      return !row || row.removing || (!previous.has(name) && (row.incompatible || row.stage !== 'available' || row.current?.runtimeRevision !== this.runtimeRevision))
    })
    if (invalid(packages, existing) || invalid(preinstalls, previousPreinstalls)) throw new BusinessRuleError('invalid', 'Select plugins from the library.', 'plugin-grant-invalid')
    this.grants.configure(id, packages, preinstalls)
    return this.group(actor, id)
  }
  private sharedCredential(packageName: string): boolean { return usesSharedPluginCredential(this.upstreams?.list(packageName) ?? []) }
  private configurationRevision(id: string): string {
    return JSON.stringify([this.accounts.listGroups().find(group => group.id === id), [...this.grants.get(id)].sort(), [...this.grants.preinstalls(id)].sort(),
      this.library.list().map(row => [row.packageName, row.version, row.current?.version, row.current?.integrity, row.current?.runtimeRevision, row.stage, row.removing, row.incompatible, this.sharedCredential(row.packageName)]).sort()])
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
  inspection(packageName: string, groupId?: string): { checking?: readonly string[] } {
    const checking = this.accounts.list().filter(account => {
      if (groupId !== undefined && account.groupId !== groupId) return false
      const state = this.runtime.status(account.username)
      return (state.state === 'ready' || state.state === 'draining') && state.instance.inspection === 'checking' && state.instance.managedSnapshot?.some(row => row.startsWith(`${packageName}@`))
    }).map(account => account.username)
    return checking.length ? { checking } : {}
  }
  contributionGroups(actor: CommunityAccountActor, packageName: string) {
    this.assertAdmin(actor)
    return this.accounts.listGroups().filter(group => group.kind === 'ordinary').map(group => ({ group, members: this.accounts.list().filter(account => account.groupId === group.id).length, granted: this.grants.get(group.id).includes(packageName), ...(this.grants.preinstalls(group.id).includes(packageName) ? { preinstalled: true as const } : {}), revision: this.contributionRevision(group.id) }))
  }
  validateContributionGroups(actor: CommunityAccountActor, choices: readonly { readonly id: string, readonly revision: string }[], packageName: string): void {
    this.assertAdmin(actor)
    for (const choice of choices) {
      assertOrdinaryGroup(requiredCommunityGroup(this.accounts.listGroups(), choice.id))
      if (choice.revision !== this.contributionRevision(choice.id)) throw new BusinessRuleError('conflict', 'Review the affected group again.', 'plugin-impact-changed')
      assertPluginGroupConfiguration([packageName], this.grants.preinstalls(choice.id))
    }
  }
  /** Replay group choices already authorized by a contribution confirmation. */
  adoptContribution(packageName: string, choices: readonly { readonly id: string }[], receipt?: ContributionReceipt): readonly string[] {
    const warnings: string[] = []
    for (const choice of choices) {
      if (receipt && sameContributionReceipt(this.grants.contributionReceipt?.(choice.id, packageName), receipt)) continue
      const group = this.accounts.listGroups().find(group => group.id === choice.id && group.kind === 'ordinary')
      if (!group) { warnings.push('A selected group was removed; its plugin grant was not applied.'); continue }
      if (this.grants.preinstalls(group.id).includes(packageName)) { warnings.push('A selected group now preinstalls this plugin; its controlled grant was not applied.'); continue }
      const row = this.library.list().find(row => row.packageName === packageName)
      if (!row || row.removing || row.stage !== 'available' || row.current?.runtimeRevision !== this.runtimeRevision) throw new BusinessRuleError('invalid', 'Select plugins from the library.', 'plugin-grant-invalid')
      if (receipt && this.grants.grantContribution) this.grants.grantContribution(group.id, packageName, receipt)
      else this.grants.set(group.id, [...new Set([...this.grants.get(group.id), packageName])])
    }
    return warnings
  }
  private contributionRevision(id: string): string {
    return JSON.stringify([this.accounts.listGroups().find(group => group.id === id), [...this.grants.get(id)].sort(), [...this.grants.preinstalls(id)].sort(), this.library.list().map(row => [row.packageName, row.version, row.current?.integrity, row.stage, row.removing]), this.accounts.list().map(account => [account.spaceId, account.groupId, account.disabled]).sort()])
  }
  private pending(id: string) {
    return this.accounts.list().filter(account => {
      if (account.disabled || account.groupId !== id) return false
      const status = this.runtime.status(account.username)
      if (status.state !== 'ready') return false
      const expected = this.managed.effective(account.username).map(plugin => `${plugin.packageName}@${plugin.version}:${plugin.integrity}`).sort()
      return !samePluginAccessSnapshot(this.pluginAccess?.snapshot(account.username, status.instance.nativePluginSnapshot) ?? [], status.instance.pluginAccessSnapshot) || JSON.stringify(expected) !== JSON.stringify(this.snapshot(status.instance))
    })
  }
  private snapshot(instance: CommunityUserInstance) { return [...(instance.managedSnapshot ?? [])].sort() }
  private assertAdmin(actor: CommunityAccountActor): void {
    const account = this.accounts.get(actor.username)
    if (!account || account.disabled || account.spaceId !== actor.spaceId || account.sessionEpoch !== actor.sessionEpoch) throw new CommunityAuthenticationError('Sign in is required', 'sign-in-required')
    if (!account.admin) throw new BusinessRuleError('forbidden', 'Administrator access is required', 'admin-required')
  }
}
