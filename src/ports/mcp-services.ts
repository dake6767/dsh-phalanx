import type { McpState, McpService } from '../domain/mcp-service.js'
export interface McpStorePort { read(): McpState, write(state: McpState): void }
export interface McpProjectionMember {
  readonly username: string
  readonly spaceId: string
  readonly services: readonly McpService[]
}
export interface McpProjectionPort { synchronize(members: readonly McpProjectionMember[]): Promise<void> }
export interface MemberMcpPort { prepare(username: string): Promise<void> }
export interface McpAuditRecord {
  readonly username: string
  readonly service: string
  readonly method: string
  readonly tool?: string
  readonly status: 'success' | 'denied' | 'failed'
  readonly startedAt: number
  readonly durationMs: number
}
export interface McpAuditPort { append(record: McpAuditRecord): void }

export interface McpProbePort { probe(username: string, spaceId: string, name: string): Promise<readonly import('../domain/admin-contract.js').CommunityMcpTool[]> }
