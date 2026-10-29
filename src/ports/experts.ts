import type { Expert, ExpertState } from '../domain/expert.js'
import type { LibrarySkill } from '../domain/skill-library.js'
import type { PreparedPlugin } from '../domain/plugin-library.js'
import type { ExpertReferenceTarget, ExpertReferenceImpact } from '../domain/expert-reference.js'

export interface ExpertReferencesPort {
  impact(targets: readonly ExpertReferenceTarget[]): Promise<ExpertReferenceImpact>
}
export interface ExpertReferenceMutationsPort {
  touch(targets: readonly ExpertReferenceTarget[]): Promise<void>
  detach(targets: readonly ExpertReferenceTarget[], expectedRevision?: string): Promise<void>
}

export interface ExpertRowsPort {
  get(id: string): Promise<Expert | undefined>
  list(): Promise<readonly Expert[]>
  lockReferences(experts: readonly Expert[]): Promise<void>
  lock(id: string, expectedRevision: string): Promise<void>
  save(expert: Expert, expectedRevision?: string): Promise<void>
  remove(id: string, expectedRevision: string): Promise<void>
}
export interface ExpertAssignment {
  readonly ownerId: string
  readonly revision: string
  readonly names: readonly string[]
}
export interface ExpertAssignmentsPort {
  lockOwner(ownerId: string, required?: boolean): Promise<void>
  list(): Promise<readonly ExpertAssignment[]>
  save(ownerId: string, names: readonly string[], expectedRevision: string): Promise<void>
  remove(ownerId: string, expectedRevision: string): Promise<void>
}
export interface ExpertRepositories {
  readonly experts: ExpertRowsPort
  readonly grants: ExpertAssignmentsPort
  readonly selections: ExpertAssignmentsPort
  readonly metadata: {
    generation(): Promise<number>
    advance(): Promise<void>
  }
}
export interface ExpertSnapshot extends ExpertState {
  readonly publicRevision: string
  readonly parentRevision: string
  readonly versions: {
    readonly experts: Readonly<Record<string, string>>
    readonly groups: Readonly<Record<string, string>>
    readonly members: Readonly<Record<string, string>>
  }
}
export interface ExpertPolicyView {
  read(): ExpertSnapshot
  version(): string
}
export interface ExpertStorePort {
  read(): Promise<ExpertSnapshot>
  readonly view: ExpertPolicyView
  update(previous: ExpertSnapshot, next: ExpertState): Promise<void>
}
export interface ExpertSkillsPort {
  skills(username: string): Promise<readonly LibrarySkill[]>
}
export interface ExpertPluginsPort {
  authorizationSnapshot?(): unknown
  version?(): string | number | undefined
  plugins(username: string): Promise<readonly PreparedPlugin[]>
}
export interface ExpertMcpPort {
  authorizationSnapshot?(): unknown
  version?(): string | number | undefined
  mcp(username: string): Promise<readonly string[]>
}
export interface ExpertMemberPlan {
  readonly expert: Expert
  readonly skills: readonly LibrarySkill[]
  readonly requestedSkills: readonly string[]
  readonly globalSkills: readonly string[]
  readonly failures: readonly string[]
}
export interface MemberExpertsPort {
  plans(username: string): Promise<readonly ExpertMemberPlan[]>
}

/** Reuses the protected execution forwarding for scripts in expert-only skill trees. */
export interface ExpertSkillProjectionPort {
  identity?(spaceId: string): Promise<unknown>
  apply(spaceId: string, directory: string): Promise<void>
}
