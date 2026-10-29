import { combineAcquisitionSources } from '../domain/acquisition-sources.js'
import type { PreparedPlugin } from '../domain/plugin-library.js'
import { usesSharedPluginCredential } from '../domain/plugin-upstream.js'
import type { CommunityAccountStorePort } from '../ports/community-accounts.js'
import type { ExpertPluginsPort } from '../ports/experts.js'
import type { MemberManagedPluginsPort, PluginGrantsPort, SelfInstalledPlugin } from '../ports/managed-plugins.js'
import type { PluginLibraryStorePort } from '../ports/plugin-library.js'
import type { PluginSelectionsPort } from '../ports/plugin-selections.js'
import type { PluginUpstreamsPort } from '../ports/plugin-upstreams.js'
import type { PluginLocalCopies } from './plugin-local-copies.js'

/** Eligibility policy only; running instances retain their startup selection. */
export class MemberManagedPlugins implements MemberManagedPluginsPort {
  constructor(
    private readonly accounts: Pick<CommunityAccountStorePort, 'get' | 'listGroups'>,
    private readonly library: PluginLibraryStorePort,
    private readonly grants: PluginGrantsPort,
    private readonly runtimeRevision: string,
    private readonly selections?: Pick<PluginSelectionsPort, 'get' | 'retainPackages'>,
    private readonly localCopies?: Pick<PluginLocalCopies, 'enabled'>,
    private readonly experts?: ExpertPluginsPort,
    private readonly upstreams?: Pick<PluginUpstreamsPort, 'list'>,
  ) {}
  async effective(username: string, installed: readonly string[] = []) {
    const experts = (await this.experts?.plugins(username)) ?? []
    return await this.selected(
      username,
      experts.filter(row => installed.includes(row.packageName)).map(row => row.packageName),
    )
  }
  async accessible(username: string) {
    return await this.selected(
      username,
      ((await this.experts?.plugins(username)) ?? []).map(row => row.packageName),
    )
  }
  private async selected(username: string, expertNames: readonly string[]) {
    const account = await this.accounts.get(username)
    if (!account || account.disabled) return []
    if (!(await this.accounts.listGroups()).some(group => group.id === account.groupId)) return []
    const selected = new Set((await this.selections?.get(account.spaceId)) ?? [])
    const publishedSelections: string[] = []
    for (const row of await this.library.list())
      if (row.published && selected.has(row.packageName) && usesSharedPluginCredential((await this.upstreams?.list(row.packageName)) ?? []))
        publishedSelections.push(row.packageName)
    const acquired = combineAcquisitionSources([
      { source: 'managed', names: await this.granted(username) },
      {
        source: 'selected',
        names: publishedSelections,
      },
      { source: 'managed', names: expertNames },
    ])
    const rows = await this.library.list()
    const local = await Promise.all(rows.map(async row => (await this.localCopies?.enabled(username, row.packageName)) ?? false))
    return rows
      .flatMap((row, index) =>
        !row.removing &&
        !row.incompatible &&
        row.stage === 'available' &&
        row.current?.runtimeRevision === this.runtimeRevision &&
        !local[index] &&
        acquired.has(row.packageName)
          ? [row.current]
          : [],
      )
      .sort((a, b) => a.packageName.localeCompare(b.packageName))
  }
  async localSelection(username: string): Promise<readonly string[]> {
    const rows = await this.library.list()
    const local = await Promise.all(rows.map(async row => (await this.localCopies?.enabled(username, row.packageName)) ?? false))
    return rows
      .filter((_, index) => local[index])
      .map(row => row.packageName)
      .sort()
  }
  async granted(username: string): Promise<readonly string[]> {
    const account = await this.accounts.get(username)
    if (!account || account.disabled) return []
    const group = (await this.accounts.listGroups()).find(group => group.id === account.groupId)
    if (!group) return []
    return await this.grants.get(group.id)
  }
  yielding(selected: readonly PreparedPlugin[], installed: readonly SelfInstalledPlugin[]) {
    const names = new Set(selected.map(plugin => plugin.packageName))
    return installed.filter(plugin => names.has(plugin.packageName)).flatMap(plugin => plugin.entries.map(entry => ({ ...entry, disabled: true as const })))
  }
  async recover(): Promise<void> {
    await this.grants.retainGroups((await this.accounts.listGroups()).map(group => group.id))
    await this.selections?.retainPackages(
      (await this.library.list()).filter(row => !row.removing && (row.published || row.restorePublication)).map(row => row.packageName),
    )
  }
}
