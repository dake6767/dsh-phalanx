import type { CommunityUserInstance } from './community-runtime.js'
import type { NativeFeatureMember } from './native-features.js'
import type { PluginInstallationsPort } from './plugin-installations.js'
import type { PlatformUnitOfWorkPort } from './platform-unit-of-work.js'
import type { SpaceMembers } from './space-actors.js'

/** Official optional bundle facts observed by the platform, never member-submitted names. */
export interface NativeOptionalBundle {
  readonly name: string
  readonly enabled: boolean
  readonly installed: boolean
  readonly failed?: boolean
}
export interface NativePluginHistoryRows {
  read(spaceId: string): Promise<readonly string[] | undefined>
  remember(spaceId: string, names: readonly string[]): Promise<readonly string[]>
}
export interface NativePluginHistoryPersistence {
  readonly work: PlatformUnitOfWorkPort<{
    readonly actors: SpaceMembers
    readonly history: NativePluginHistoryRows
    readonly deliveries: Pick<PluginInstallationsPort, 'get'>
  }>
}
export interface NativePluginHistoryRuntime {
  current(username: string): CommunityUserInstance | undefined
  inspect(instance: CommunityUserInstance, signal: AbortSignal): Promise<readonly NativeOptionalBundle[]>
}
export interface MemberNativePluginHistory {
  initialize(member: NativeFeatureMember, instance: CommunityUserInstance, signal: AbortSignal): Promise<readonly string[]>
  request(member: NativeFeatureMember, generation: string, mode: 'read' | 'refresh', signal: AbortSignal): Promise<readonly string[]>
  archiveReserved(member: NativeFeatureMember, generation: string, integrity: string, signal: AbortSignal): Promise<boolean>
}
