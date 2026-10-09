import type { PreparedPlugin } from '../domain/plugin-library.js'

/** The single selection seam consulted at member-instance startup. */
export interface SelfInstalledPlugin { readonly packageName: string, readonly entries: readonly { readonly id: string, readonly name: string }[] }
export interface PluginYieldEntry { readonly id: string, readonly name: string, readonly disabled: true }
export interface MemberManagedPluginsPort {
  effective(username: string): readonly PreparedPlugin[]
  yielding(selected: readonly PreparedPlugin[], installed: readonly SelfInstalledPlugin[]): readonly PluginYieldEntry[]
}
export interface PluginGrantsPort {
  get(groupId: string): readonly string[]
  set(groupId: string, packages: readonly string[]): void
  remove(groupId: string): void
  retainGroups(groupIds: readonly string[]): void
}
