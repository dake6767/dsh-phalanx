import type { McpService, McpState } from '../domain/mcp-service.js'
import type { ExpertReferenceMutationsPort, ExpertReferencesPort } from './experts.js'
export interface McpRowVersions {
  readonly services: Readonly<Record<string, string>>
  readonly groups: Readonly<Record<string, string>>
  readonly members: Readonly<Record<string, string>>
}
export interface McpSnapshot extends McpState {
  readonly versions: McpRowVersions
  readonly protectedRevision: string
}
export interface McpPolicyView {
  read(): McpSnapshot
  version(): string
}
export interface McpServiceRowsPort {
  get(name: string): Promise<McpService | undefined>
  list(): Promise<readonly McpService[]>
  save(service: McpService, protection: import('../domain/mcp-protected-values.js').McpSecretContext, expectedRevision?: string): Promise<void>
  remove(name: string, expectedRevision: string): Promise<void>
  lock(name: string, expectedRevision: string): Promise<void>
}
export interface McpGroupPolicy {
  readonly groupId: string
  readonly revision: string
  readonly names: readonly string[]
}
export interface McpMemberPolicy {
  readonly spaceId: string
  readonly revision: string
  readonly selections?: readonly string[]
  readonly preferences?: Readonly<Record<string, boolean>>
}
export interface McpPolicyRowsPort {
  groups(): Promise<readonly McpGroupPolicy[]>
  members(): Promise<readonly McpMemberPolicy[]>
  saveGroup(group: string, names: readonly string[], expectedRevision: string): Promise<void>
  removeGroup(group: string, expectedRevision: string): Promise<void>
  saveMember(
    space: string,
    selections: readonly string[] | undefined,
    preferences: Readonly<Record<string, boolean>> | undefined,
    expectedRevision: string,
  ): Promise<void>
  removeMember(space: string, expectedRevision: string): Promise<void>
}
export interface McpMetadataRowsPort {
  generation(): Promise<number>
  advance(previous: number, next: number, exclusive?: boolean): Promise<void>
  requests(): Promise<readonly string[]>
  appendRequests(names: readonly string[]): Promise<void>
}
export interface McpRepositories {
  readonly services: McpServiceRowsPort
  readonly policies: McpPolicyRowsPort
  readonly metadata: McpMetadataRowsPort
  readonly runtime: import('./runtime-dependencies.js').RuntimeDependencyStorePort
  readonly expertReferences?: ExpertReferenceMutationsPort
}
export interface McpMutationOptions {
  readonly expertReferenceRevision?: string
}
export interface McpStateQueryPort {
  read(): Promise<McpSnapshot>
}
export interface McpStatePort extends McpStateQueryPort {
  readonly view: McpPolicyView
  readonly expertReferences?: ExpertReferencesPort
  update(previous: McpSnapshot, next: McpState, options?: McpMutationOptions): Promise<void>
  reconcile(runtime?: McpRuntimePort): Promise<void>
}
export interface McpRuntimeWriteScope {
  configure(service: McpService): Promise<McpService>
  committed(): void
}
export interface McpProjectionMember {
  readonly username: string
  readonly spaceId: string
  readonly services: readonly McpService[]
}
export interface McpProjectionPort {
  synchronize(members: readonly McpProjectionMember[]): Promise<void>
}
export interface MemberMcpPort {
  prepare(username: string): Promise<void>
  expertProjection?(username: string): Promise<{ readonly services: readonly McpService[]; readonly global: readonly string[] }>
}

export interface McpProbePort {
  probe(username: string, spaceId: string, name: string): Promise<readonly import('../domain/admin-contract.js').CommunityMcpTool[]>
}

export interface McpPreparedRuntime {
  readonly directory: string
  readonly dependencies?: readonly import('../domain/runtime-dependency.js').RuntimeDependencyVersion[]
}
export interface McpRuntimePort {
  transaction?(rows: import('./runtime-dependencies.js').RuntimeDependencyStorePort): McpRuntimeWriteScope
  /** Stable preparation inputs, distinct from authorization invalidation during collection. */
  preparationSnapshot?(): string | undefined
  version?(): string | number | undefined
  validateReferences?(service: McpService['run'], previous?: McpService['run']): Promise<void>
  configure?(service: McpService): Promise<McpService>
  promote?(candidate: McpService, previous: McpService): McpService
  ready(service: McpService): McpPreparedRuntime | undefined
  /** Ordinary management reads use current rows; synchronous view is reserved for fences. */
  readView?(service: McpService): Promise<ReturnType<McpRuntimePort['view']>>
  view(service: McpService):
    | {
        readonly isolated?: boolean
        readonly stage: 'preparing' | 'ready' | 'failed'
        readonly updatedAt: number
        readonly log: string
      }
    | undefined
  changed(): Promise<void>
  restart(name: string): void
}
