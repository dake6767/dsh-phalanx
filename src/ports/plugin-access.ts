import type { PluginAccessSettings, PluginEntryConfig } from '../domain/plugin-access.js'
import type { PreparedPlugin } from '../domain/plugin-library.js'
import type { CommunityModelGatewayAccess } from './community-runtime.js'
export interface PluginAccessStorePort {
  get(packageName: string): PluginAccessSettings | undefined
  list(): Readonly<Record<string, PluginAccessSettings>>
  save(packageName: string, settings: Omit<PluginAccessSettings, 'revision'>): void
  remove(packageName: string): void
}
export interface PluginAccessSyntaxPort {
  parse(source: string): Readonly<Record<string, PluginEntryConfig>>
  entryIds(plugin: PreparedPlugin): readonly string[]
}
export interface MemberPluginAccessPort {
  snapshot(username: string): readonly string[]
  resolve(plugins: readonly PreparedPlugin[], access: CommunityModelGatewayAccess): {
    readonly environment: Readonly<Record<string, string>>
    readonly entries: Readonly<Record<string, Readonly<Record<string, PluginEntryConfig>>>>
    readonly snapshot: readonly string[]
  }
}
