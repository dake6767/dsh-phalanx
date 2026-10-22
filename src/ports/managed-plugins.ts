import type { ContributionReceipt } from '../domain/contribution-receipt.js'
import type { PreparedPlugin } from '../domain/plugin-library.js'

/** The single selection seam consulted at member-instance startup. */
export interface SelfInstalledPlugin { readonly packageName: string, readonly entries: readonly { readonly id: string, readonly name: string }[] }
export interface PluginYieldEntry { readonly id: string, readonly name: string, readonly disabled: true }
export interface MemberManagedPluginsPort {
  localSelection?(username: string): readonly string[]
  effective(username: string, installed?: readonly string[]): readonly PreparedPlugin[]
  accessible?(username: string): readonly PreparedPlugin[]
  yielding(selected: readonly PreparedPlugin[], installed: readonly SelfInstalledPlugin[]): readonly PluginYieldEntry[]
}
export interface PluginGrantsPort {
  contributionReceipt?(groupId: string, packageName: string): ContributionReceipt | undefined
  grantContribution?(groupId: string, packageName: string, receipt: ContributionReceipt): void
  get(groupId: string): readonly string[]
  set(groupId: string, packages: readonly string[]): void
  remove(groupId: string): void
  retainGroups(groupIds: readonly string[]): void
}

/** Both group lists are committed together; a package belongs to at most one list. */
export interface PluginGroupConfigurationPort extends PluginGrantsPort {
  preinstalls(groupId: string): readonly string[]
  configure(groupId: string, controlled: readonly string[], preinstalled: readonly string[]): void
}
