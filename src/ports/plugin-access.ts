import type { ContributionReceipt } from '../domain/contribution-receipt.js'
import type { PluginAccessSettings, PluginEntryConfig } from '../domain/plugin-access.js'
import type { PreparedPlugin } from '../domain/plugin-library.js'
import type { CommunityModelGatewayAccess } from './community-runtime.js'
export interface PluginAccessStorePort {
  get(packageName: string): PluginAccessSettings | undefined
  list(): Readonly<Record<string, PluginAccessSettings>>
  commitContribution?(packageName: string, settings: Omit<PluginAccessSettings, 'revision'> | undefined, contribution: ContributionReceipt): void
  receipt?(packageName: string): ContributionReceipt | undefined
  save(packageName: string, settings: Omit<PluginAccessSettings, 'revision'>, contribution?: ContributionReceipt): void
  remove(packageName: string): void
}
export interface PluginAccessSyntaxPort {
  parse(source: string): Readonly<Record<string, PluginEntryConfig>>
  entryIds(plugin: PreparedPlugin): readonly string[]
}
export interface MemberPluginAccessPort {
  snapshot(username: string, installed?: readonly string[]): readonly string[]
  resolve(plugins: readonly PreparedPlugin[], access: CommunityModelGatewayAccess, native?: { readonly username: string, readonly installed: readonly string[] }): {
    readonly environment: Readonly<Record<string, string>>
    readonly entries: Readonly<Record<string, Readonly<Record<string, PluginEntryConfig>>>>
    readonly snapshot: readonly string[]
  }
}
