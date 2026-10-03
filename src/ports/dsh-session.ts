import type { CommunityUserInstance } from './community-runtime.js'

/** Official DSH authentication and activity facts needed by community lifecycle. */
export interface DshSessionPort {
  exchangeLaunchToken(instance: CommunityUserInstance, publicOrigin: URL): Promise<string[]>
  hasRunningAgent(instance: CommunityUserInstance, cookie: string, publicOrigin: URL): Promise<boolean>
}
