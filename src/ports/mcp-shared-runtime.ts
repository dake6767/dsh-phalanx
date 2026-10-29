import type { McpService } from '../domain/mcp-service.js'
import type { PluginUpstream } from '../domain/plugin-upstream.js'

export type McpSharedActivity =
  | { readonly type: 'activity' }
  | { readonly type: 'started' | 'cancelled'; readonly id: number }
  | { readonly type: 'completed'; readonly id: number; readonly failed: boolean }
export interface McpSharedProcessPort {
  readonly isolated: boolean
  recover(): Promise<void>
  start(
    service: McpService,
    activity: (event: McpSharedActivity) => void,
    signal: AbortSignal,
  ): Promise<{
    readonly target: PluginUpstream
    readonly closed: Promise<number>
  }>
}
export interface McpSharedRuntimePort {
  connect(username: string, service: McpService, diagnostic: boolean): Promise<import('../domain/plugin-upstream.js').PluginUpstream>
}
