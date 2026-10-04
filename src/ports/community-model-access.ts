import type { CommunityAccountState } from '../domain/community-account.js'

export type CommunityModelIdentity = Pick<CommunityAccountState, 'username' | 'spaceId'>

/** Opaque access belongs to one durable space, including across username reuse. */
export interface CommunityModelAccessPort {
  forUser(username: string, spaceId: string): string
  resolve(token: string): CommunityModelIdentity | undefined
}
