import type { RuntimeDependencyVersion } from '../domain/runtime-dependency.js'

/** One observed plugin inventory supplies environment bindings and the retained member generation. */
export interface MemberRuntimeDependencyPlan {
  readonly versions: readonly RuntimeDependencyVersion[]
  readonly bindings: Readonly<Record<string, RuntimeDependencyVersion>>
}
export interface MemberRuntimeDependenciesPort {
  plan(spaceId: string, installed: readonly string[]): Promise<MemberRuntimeDependencyPlan>
  prepare(spaceId: string, plan: MemberRuntimeDependencyPlan, prepareMember?: () => Promise<void>): Promise<void>
}
