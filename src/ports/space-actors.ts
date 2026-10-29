import type { CommunityAccountActor, CommunityAccountRecord } from '../domain/community-account.js'

export interface SpaceAdministrators {
  lockAdministrator(actor: CommunityAccountActor, target?: Pick<CommunityAccountActor, 'username' | 'spaceId'>): Promise<void>
}
export interface SpaceResetActors {
  lockReset(actor: CommunityAccountActor, target: Pick<CommunityAccountActor, 'username' | 'spaceId'>): Promise<CommunityAccountRecord>
}
