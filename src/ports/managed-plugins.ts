import type { PreparedPlugin } from '../domain/plugin-library.js'

/** The single selection seam consulted at member-instance startup. */
export interface MemberManagedPluginsPort { effective(username: string): readonly PreparedPlugin[] }
export interface PluginGrantsPort {
  get(groupId: string): readonly string[]
  set(groupId: string, packages: readonly string[]): void
  remove(groupId: string): void
  retainGroups(groupIds: readonly string[]): void
}
