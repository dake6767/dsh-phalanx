import type { CommunityUserInstance } from './community-runtime.js'

/** Official DSH authentication and activity facts needed by community lifecycle. */
export interface DshSessionPort {
  exchangeLaunchToken(instance: CommunityUserInstance, publicOrigin: URL): Promise<string[]>
  forgetSession?(instance: CommunityUserInstance): void
  hasSession?(instance: CommunityUserInstance, cookie: string | undefined): boolean
  hasRunningAgent(instance: CommunityUserInstance, cookie: string, publicOrigin: URL): Promise<boolean>
}
