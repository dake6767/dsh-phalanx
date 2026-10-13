import type { McpService } from '../domain/mcp-service.js'
import type { PluginUpstream } from '../domain/plugin-upstream.js'

export interface McpSharedProcessPort {
  readonly isolated: boolean
  recover(): Promise<void>
  start(service: McpService, activity: () => void, signal: AbortSignal): Promise<{
    readonly target: PluginUpstream
    readonly closed: Promise<number>
  }>
}
export interface McpSharedRuntimePort {
  connect(username: string, service: McpService, diagnostic: boolean): Promise<import('../domain/plugin-upstream.js').PluginUpstream>
}
