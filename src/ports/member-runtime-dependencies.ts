import type { NativePluginArchiveFacts, NativePluginDependencyPlans, PluginPreinstallPlan } from '../domain/plugin-preinstall.js'
import type { RuntimeDependencyVersion } from '../domain/runtime-dependency.js'

/** One observed plugin inventory supplies environment bindings and the retained member generation. */
export interface MemberRuntimeDependencyPlan {
  readonly versions: readonly RuntimeDependencyVersion[]
  readonly nativeResources?: NativePluginDependencyPlans
  readonly blockedPreinstalls?: readonly string[]
  readonly bindings: Readonly<Record<string, RuntimeDependencyVersion>>
}
export interface MemberRuntimeDependenciesPort {
  plan(
    spaceId: string,
    installed: readonly string[],
    preinstalls?: PluginPreinstallPlan['dependencies'],
    archives?: NativePluginArchiveFacts,
  ): Promise<MemberRuntimeDependencyPlan>
  prepare(spaceId: string, plan: MemberRuntimeDependencyPlan, prepareMember?: () => Promise<void>): Promise<void>
}
