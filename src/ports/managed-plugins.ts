import type { ContributionReceipt } from '../domain/contribution-receipt.js'
import type { PreparedPlugin } from '../domain/plugin-library.js'

/** The single selection seam consulted at member-instance startup. */
export interface SelfInstalledPlugin {
  readonly packageName: string
  readonly entries: readonly { readonly id: string; readonly name: string }[]
}
export interface PluginYieldEntry {
  readonly id: string
  readonly name: string
  readonly disabled: true
}
export interface MemberManagedPluginsPort {
  localSelection?(username: string): Promise<readonly string[]>
  effective(username: string, installed?: readonly string[]): Promise<readonly PreparedPlugin[]>
  accessible?(username: string): Promise<readonly PreparedPlugin[]>
  yielding(selected: readonly PreparedPlugin[], installed: readonly SelfInstalledPlugin[]): readonly PluginYieldEntry[]
}
export interface PluginGrantsPort {
  contributionReceipt?(groupId: string, packageName: string): Promise<ContributionReceipt | undefined>
  grantContribution?(groupId: string, packageName: string, receipt: ContributionReceipt): Promise<void>
  get(groupId: string): Promise<readonly string[]>
  set(groupId: string, packages: readonly string[]): Promise<void>
  remove(groupId: string): Promise<void>
  retainGroups(groupIds: readonly string[]): Promise<void>
}

/** Both group lists are committed together; a package belongs to at most one list. */
export interface PluginGroupConfigurationPort extends PluginGrantsPort {
  preinstalls(groupId: string): Promise<readonly string[]>
  configure(groupId: string, controlled: readonly string[], preinstalled: readonly string[]): Promise<void>
}
