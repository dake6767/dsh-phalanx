import type { CommunityAccountActor } from '../domain/community-account.js'
import type { PlatformUnitOfWorkPort } from './platform-unit-of-work.js'
import type { SpaceAdministrators } from './space-actors.js'

export type NativeFeatureMember = Pick<CommunityAccountActor, 'username' | 'spaceId'>
export interface NativeFeatureGroupState {
  readonly groupId: string
  readonly revision: string
  readonly disabledIds: readonly string[]
  readonly showAppCenter: boolean
}
export interface NativeFeatureRows {
  readGroup(groupId: string): Promise<NativeFeatureGroupState | undefined>
  forMember(member: NativeFeatureMember): Promise<NativeFeatureGroupState | undefined>
  save(groupId: string, disabledIds: readonly string[], expectedRevision: string, showAppCenter?: boolean): Promise<NativeFeatureGroupState>
}
export interface NativeFeatureRepositories {
  readonly actors: SpaceAdministrators
  readonly features: NativeFeatureRows
}
export interface NativeFeaturePersistence {
  readonly rows: NativeFeatureRows
  readonly work: PlatformUnitOfWorkPort<NativeFeatureRepositories>
}
export interface MemberNativeFeaturesPort {
  resolve(member: NativeFeatureMember): Promise<{ readonly disabledIds: readonly string[] }>
}
