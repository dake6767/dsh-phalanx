import type { McpState, McpService } from '../domain/mcp-service.js'
export interface McpStorePort { read(): McpState, write(state: McpState): void }
export interface McpProjectionMember {
  readonly username: string
  readonly spaceId: string
  readonly services: readonly McpService[]
}
export interface McpProjectionPort { synchronize(members: readonly McpProjectionMember[]): Promise<void> }
export interface MemberMcpPort { prepare(username: string): Promise<void> }
