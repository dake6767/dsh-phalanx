import type { ExecutionPreparerPort } from './execution-preparation.js'
import type { McpState, McpService } from '../domain/mcp-service.js'
export interface McpStorePort { version?(): number, read(): McpState, write(state: McpState): void }
export interface McpProjectionMember {
  readonly username: string
  readonly spaceId: string
  readonly services: readonly McpService[]
}
export interface McpProjectionPort { synchronize(members: readonly McpProjectionMember[]): Promise<void> }
export interface MemberMcpPort {
  prepare(username: string): Promise<void>
  expertProjection?(username: string): { readonly services: readonly McpService[], readonly global: readonly string[] }
}

export interface McpProbePort { probe(username: string, spaceId: string, name: string): Promise<readonly import('../domain/admin-contract.js').CommunityMcpTool[]> }

export interface McpPreparedRuntime { readonly directory: string, readonly dependencies?: readonly import('../domain/runtime-dependency.js').RuntimeDependencyVersion[], readonly legacy?: boolean }
export interface McpRuntimePort {
  version?(): string | number | undefined
  validateReferences?(service: McpService['run'], previous?: McpService['run']): void
  configure?(service: McpService): McpService
  promote?(candidate: McpService, previous: McpService): McpService
  ready(service: McpService): McpPreparedRuntime | undefined
  view(service: McpService): { readonly usingPrevious?: boolean, readonly isolated?: boolean, readonly stage: 'preparing' | 'ready' | 'failed', readonly updatedAt: number, readonly log: string } | undefined
  changed(): Promise<void>
  restart(name: string): void
}

export interface McpMemberPreparerPort extends ExecutionPreparerPort {
  directory(id: string): string
}
