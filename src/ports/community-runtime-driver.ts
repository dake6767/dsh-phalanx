import type { CommunityStartupStage } from '../domain/admin-contract.js'
import type { CommunityModelGatewayAccess, CommunityUserInstance } from './community-runtime.js'

/** Host transport owns processes/containers; lifecycle policy owns public instance state. */
export interface CommunityRuntimeDriverPort {
  /** Remove only this data root's old containers before new admission, retaining all files. */
  rebuild(): Promise<readonly string[]>
  /** The complete browser origin URL, including its scheme. */
  /** Called only after lifecycle registration; inspection must not block entry. */
  inspect?(instance: CommunityUserInstance): void
  start(userId: string, publicOriginUrl: string, access: CommunityModelGatewayAccess, signal: AbortSignal, progress?: (stage: CommunityStartupStage) => void): Promise<CommunityUserInstance>
  /** One host listing for a set of registered carriers; omitted by simple process substitutes. */
  running?(instances: readonly CommunityUserInstance[]): Promise<readonly CommunityUserInstance[]>
  alive(instance: CommunityUserInstance): Promise<boolean>
  stop(instance: CommunityUserInstance): Promise<void>
  detach(instance: CommunityUserInstance): Promise<void>
}

/** Cleanup uncertainty must prevent a second carrier from mounting the same user space. */
export class CommunityRuntimeCleanupError extends Error {}
