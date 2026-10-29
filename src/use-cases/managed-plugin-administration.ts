import { pluginGroupRevision } from '../domain/plugin-group-revision.js'
import type { CommunityManagedGroupView } from '../domain/admin-contract.js'
import { BusinessRuleError } from '../domain/business-error.js'
import type { CommunityAccountActor } from '../domain/community-account.js'
import { CommunityAuthenticationError } from '../domain/community-account.js'
import { assertOrdinaryGroup, requiredCommunityGroup } from '../domain/community-group.js'
import { sameContributionReceipt, type ContributionReceipt } from '../domain/contribution-receipt.js'
import { samePluginAccessSnapshot } from '../domain/plugin-access.js'
import { assertPluginGroupConfiguration } from '../domain/plugin-group-configuration.js'
import { usesSharedPluginCredential } from '../domain/plugin-upstream.js'
import type { CommunityAccountStorePort } from '../ports/community-accounts.js'
import type { CommunityRuntimePort, CommunityUserInstance } from '../ports/community-runtime.js'
import type { MemberManagedPluginsPort, PluginGroupConfigurationPort } from '../ports/managed-plugins.js'
import type { MemberPluginAccessPort } from '../ports/plugin-access.js'
import type { PluginLibraryStorePort } from '../ports/plugin-library.js'
import type { PluginUpstreamsPort } from '../ports/plugin-upstreams.js'
import type { CommunityInstanceActions } from './community-instance-actions.js'
import type { MemberPluginPreinstalls } from './member-plugin-preinstalls.js'

/** Grant policy and pending-state projection; instance lifecycle remains the startup-state owner. */
export class ManagedPluginAdministration {
  constructor(
    private readonly accounts: Pick<CommunityAccountStorePort, 'get' | 'list' | 'listGroups'>,
    private readonly library: PluginLibraryStorePort,
    private readonly grants: PluginGroupConfigurationPort,
    private readonly managed: Pick<MemberManagedPluginsPort, 'effective'>,
    private readonly runtime: Pick<CommunityRuntimePort, 'status'>,
    private readonly actions: Pick<CommunityInstanceActions, 'restart'>,
    private readonly runtimeRevision: string,
    private readonly pluginAccess?: Pick<MemberPluginAccessPort, 'snapshot'>,
    private readonly upstreams?: Pick<PluginUpstreamsPort, 'list'>,
    private readonly preinstalls?: Pick<MemberPluginPreinstalls, 'incompleteMembers'>,
  ) {}
  async grantCount(id: string): Promise<number> {
    return (await this.grants.get(id)).length + (await this.grants.preinstalls(id)).length
  }
  async group(actor: CommunityAccountActor, id: string): Promise<CommunityManagedGroupView> {
    await this.assertAdmin(actor)
    const group = requiredCommunityGroup(await this.accounts.listGroups(), id)
    const grants = new Set(await this.grants.get(id)),
      preinstalls = new Set(await this.grants.preinstalls(id))
    return {
      group,
      revision: await this.configurationRevision(id),
      preinstallIncompleteMembers: (await this.preinstalls?.incompleteMembers(id)) ?? 0,
      plugins: await Promise.all(
        (await this.library.list()).map(async row => ({
          packageName: row.packageName,
          title: row.current?.title ?? row.packageName,
          version: row.current?.version ?? null,
          ...(row.incompatible ? { incompatible: true } : {}),
          granted: grants.has(row.packageName),
          preinstalled: preinstalls.has(row.packageName),
          hasPlatformCredential: await this.sharedCredential(row.packageName),
          available: !row.removing && !row.incompatible && row.stage === 'available' && row.current?.runtimeRevision === this.runtimeRevision,
          ...(await this.inspection(row.packageName, id)),
          failures: await this.failures(row.packageName, id),
        })),
      ),
      pendingMembers: (await this.pending(id)).map(account => account.username),
    }
  }
  async save(
    actor: CommunityAccountActor,
    id: string,
    packages: readonly string[],
    preinstalls: readonly string[],
    revision: string,
  ): Promise<CommunityManagedGroupView> {
    await this.assertAdmin(actor)
    requiredCommunityGroup(await this.accounts.listGroups(), id)
    if (revision !== (await this.configurationRevision(id)))
      throw new BusinessRuleError('conflict', 'Review the group configuration again.', 'plugin-impact-changed')
    assertPluginGroupConfiguration(packages, preinstalls)
    const existing = new Set(await this.grants.get(id)),
      previousPreinstalls = new Set(await this.grants.preinstalls(id))
    const rows = new Map((await this.library.list()).map(row => [row.packageName, row]))
    const invalid = (names: readonly string[], previous: ReadonlySet<string>) =>
      names.some(name => {
        const row = rows.get(name)
        return (
          !row ||
          row.removing ||
          (!previous.has(name) && (row.incompatible || row.stage !== 'available' || row.current?.runtimeRevision !== this.runtimeRevision))
        )
      })
    if (invalid(packages, existing) || invalid(preinstalls, previousPreinstalls))
      throw new BusinessRuleError('invalid', 'Select plugins from the library.', 'plugin-grant-invalid')
    await this.grants.configure(id, packages, preinstalls)
    return await this.group(actor, id)
  }
  private async sharedCredential(packageName: string): Promise<boolean> {
    return usesSharedPluginCredential((await this.upstreams?.list(packageName)) ?? [])
  }
  private async configurationRevision(id: string): Promise<string> {
    return JSON.stringify([
      (await this.accounts.listGroups()).find(group => group.id === id),
      [...(await this.grants.get(id))].sort(),
      [...(await this.grants.preinstalls(id))].sort(),
      (
        await Promise.all(
          (await this.library.list()).map(async row => [
            row.packageName,
            row.version,
            row.current?.version,
            row.current?.integrity,
            row.current?.runtimeRevision,
            row.stage,
            row.removing,
            row.incompatible,
            await this.sharedCredential(row.packageName),
          ]),
        )
      ).sort(),
    ])
  }
  async restartAffected(actor: CommunityAccountActor, id: string, origin: URL): Promise<CommunityManagedGroupView> {
    await this.assertAdmin(actor)
    requiredCommunityGroup(await this.accounts.listGroups(), id)
    for (const account of await this.pending(id)) {
      await this.assertAdmin(actor)
      if ((await this.pending(id)).some(current => current.spaceId === account.spaceId)) await this.actions.restart(account, origin)
    }
    return await this.group(actor, id)
  }
  async failures(packageName: string, groupId?: string): Promise<readonly { username: string; code: 'plugin-managed-load-failed' }[]> {
    return (await this.accounts.list()).flatMap(account => {
      if (groupId !== undefined && account.groupId !== groupId) return []
      const state = this.runtime.status(account.username)
      return state.state === 'ready' && state.instance.managedFailures?.includes(packageName)
        ? [{ username: account.username, code: 'plugin-managed-load-failed' as const }]
        : []
    })
  }
  async inspection(packageName: string, groupId?: string): Promise<{ checking?: readonly string[] }> {
    const checking = (await this.accounts.list())
      .filter(account => {
        if (groupId !== undefined && account.groupId !== groupId) return false
        const state = this.runtime.status(account.username)
        return (
          (state.state === 'ready' || state.state === 'draining') &&
          state.instance.inspection === 'checking' &&
          state.instance.managedSnapshot?.some(row => row.startsWith(`${packageName}@`))
        )
      })
      .map(account => account.username)
    return checking.length ? { checking } : {}
  }
  async contributionGroups(actor: CommunityAccountActor, packageName: string) {
    await this.assertAdmin(actor)
    const accounts = await this.accounts.list()
    return Promise.all(
      (await this.accounts.listGroups())
        .filter(group => group.kind === 'ordinary')
        .map(async group => ({
          group,
          members: accounts.filter(account => account.groupId === group.id).length,
          granted: (await this.grants.get(group.id)).includes(packageName),
          ...((await this.grants.preinstalls(group.id)).includes(packageName) ? { preinstalled: true as const } : {}),
          revision: await this.contributionRevision(group.id),
        })),
    )
  }
  async validateContributionGroups(
    actor: CommunityAccountActor,
    choices: readonly { readonly id: string; readonly revision: string }[],
    packageName: string,
  ): Promise<void> {
    await this.assertAdmin(actor)
    for (const choice of choices) {
      assertOrdinaryGroup(requiredCommunityGroup(await this.accounts.listGroups(), choice.id))
      if (choice.revision !== (await this.contributionRevision(choice.id)))
        throw new BusinessRuleError('conflict', 'Review the affected group again.', 'plugin-impact-changed')
      assertPluginGroupConfiguration([packageName], await this.grants.preinstalls(choice.id))
    }
  }
  /** Replay group choices already authorized by a contribution confirmation. */
  async adoptContribution(packageName: string, choices: readonly { readonly id: string }[], receipt?: ContributionReceipt): Promise<readonly string[]> {
    const warnings: string[] = []
    for (const choice of choices) {
      if (receipt && sameContributionReceipt(await this.grants.contributionReceipt?.(choice.id, packageName), receipt)) continue
      const group = (await this.accounts.listGroups()).find(group => group.id === choice.id && group.kind === 'ordinary')
      if (!group) {
        warnings.push('A selected group was removed; its plugin grant was not applied.')
        continue
      }
      if ((await this.grants.preinstalls(group.id)).includes(packageName)) {
        warnings.push('A selected group now preinstalls this plugin; its controlled grant was not applied.')
        continue
      }
      const row = (await this.library.list()).find(row => row.packageName === packageName)
      if (!row || row.removing || row.stage !== 'available' || row.current?.runtimeRevision !== this.runtimeRevision)
        throw new BusinessRuleError('invalid', 'Select plugins from the library.', 'plugin-grant-invalid')
      if (receipt && this.grants.grantContribution) await this.grants.grantContribution(group.id, packageName, receipt)
      else await this.grants.set(group.id, [...new Set([...(await this.grants.get(group.id)), packageName])])
    }
    return warnings
  }
  private async contributionRevision(id: string): Promise<string> {
    return pluginGroupRevision(
      (await this.accounts.listGroups()).find(group => group.id === id),
      await this.grants.get(id),
      await this.grants.preinstalls(id),
      await this.library.list(),
      await this.accounts.list(),
    )
  }
  private async pending(id: string) {
    const accounts = (await this.accounts.list()).filter(account => !account.disabled && account.groupId === id)
    const pending = await Promise.all(
      accounts.map(async account => {
        const expected = (await this.managed.effective(account.username)).map(plugin => `${plugin.packageName}@${plugin.version}:${plugin.integrity}`).sort()
        const status = this.runtime.status(account.username)
        if (status.state !== 'ready') return false
        // Use the running carrier's native inventory when computing its effective access.
        const currentAccess = (await this.pluginAccess?.snapshot(account.username, status.instance.nativePluginSnapshot)) ?? []
        const current = this.runtime.status(account.username)
        if (current.state !== 'ready' || current.instance !== status.instance) return true
        return (
          !samePluginAccessSnapshot(currentAccess, status.instance.pluginAccessSnapshot) ||
          JSON.stringify(expected) !== JSON.stringify(this.snapshot(status.instance))
        )
      }),
    )
    return accounts.filter((_account, index) => pending[index])
  }

  private snapshot(instance: CommunityUserInstance) {
    return [...(instance.managedSnapshot ?? [])].sort()
  }
  private async assertAdmin(actor: CommunityAccountActor): Promise<void> {
    const account = await this.accounts.get(actor.username)
    if (!account || account.disabled || account.spaceId !== actor.spaceId || account.sessionEpoch !== actor.sessionEpoch)
      throw new CommunityAuthenticationError('Sign in is required', 'sign-in-required')
    if (!account.admin) throw new BusinessRuleError('forbidden', 'Administrator access is required', 'admin-required')
  }
}
