import type { NativeFeatureView } from './native-features.js'

export interface CommunityPlatformFeatures {
  readonly showAppCenter: boolean
}

export interface CommunityNativeFeatureGroup extends CommunityPlatformFeatures {
  readonly groupId: string
  readonly revision: string
  readonly features: readonly NativeFeatureView[]
}
export type CommunityNativeFeatureInput = {
  readonly revision: string
} & ({ readonly disabledIds: readonly string[]; readonly showAppCenter?: boolean } | { readonly disabledIds?: never; readonly showAppCenter: boolean })
