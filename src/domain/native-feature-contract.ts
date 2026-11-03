import type { NativeFeatureView } from './native-features.js'

export interface CommunityNativeFeatureGroup {
  readonly groupId: string
  readonly revision: string
  readonly features: readonly NativeFeatureView[]
}
export interface CommunityNativeFeatureInput {
  readonly revision: string
  readonly disabledIds: readonly string[]
}
