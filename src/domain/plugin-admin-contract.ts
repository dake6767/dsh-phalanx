/** Management wire types owned by this domain; exported through admin-contract. */
import type { CommunityApiErrorBody, CommunityErrorCode } from './admin-error-contract.js'
export type CommunityPluginStage = 'resolving' | 'downloading' | 'installing' | 'prechecking' | 'available' | 'failed'
export type CommunityPluginChangeResult = CommunityPluginView | { readonly removed: string }
export interface CommunityPluginImpact {
  readonly experts: readonly { readonly id: string; readonly name: string }[]
  readonly groups: number
  readonly members: number
  readonly selectedMembers?: number
  readonly revision: string
}
export type CommunityPluginChangeAction =
  | { readonly action: 'runtime-dependencies'; readonly packageName: string; readonly names: readonly string[] }
  | { readonly action: 'prepare'; readonly packageName: string; readonly version: string }
  | { readonly action: 'select' | 'remove'; readonly packageName: string; readonly revision: string; readonly confirmed: true }
export interface CommunityPluginView {
  readonly runtimeDependencies?: readonly string[]
  readonly provenance?: import('./library-contribution.js').LibraryProvenance
  readonly maintenanceRevision?: string
  /** Owning catalog origin while the plugin belongs to a catalog entry. */
  readonly suiteOrigin?: string
  readonly accessConfigured?: boolean
  readonly invalidAccessEntries?: readonly string[]
  readonly hasPlatformCredential?: boolean
  readonly selectedMembers?: number
  readonly incompatible?: boolean
  readonly publicationPaused?: boolean
  readonly removing?: boolean
  readonly replacement?: { readonly version: string; readonly stage: CommunityPluginStage; readonly failureCode?: CommunityErrorCode }
  readonly failures?: readonly { username: string; code: 'plugin-managed-load-failed' }[]
  readonly checking?: readonly string[]
  readonly source: 'npm' | 'upload'
  readonly packageName: string
  readonly version: string
  readonly currentVersion: string | null
  readonly title: string
  readonly description: string
  readonly stage: CommunityPluginStage
  readonly published: boolean
  readonly integrity?: string
  readonly failureCode?: CommunityErrorCode
}
export interface CommunityPluginAction {
  readonly action: 'add' | 'retry'
  readonly packageName: string
  readonly version: string
}

export type { CommunityManagedGroupView, CommunityPluginGrantAction } from './plugin-group-contract.js'

export interface CommunityNativePluginJob {
  readonly requestId: string
  readonly action: 'install' | 'uninstall'
  readonly status: 'running' | 'succeeded' | 'failed'
  readonly phase: 'preparing' | 'downloading' | 'installing' | 'removing' | 'complete'
  readonly application?: 'applied' | 'restart-required'
  readonly failure?: CommunityApiErrorBody
}
export interface CommunityMarketPluginView {
  readonly contribution?: { readonly name?: string; readonly anonymous: boolean }
  readonly packageName: string
  readonly title: string
  readonly description: string
  readonly version: string
  readonly status: 'install' | 'selected' | 'managed' | 'native' | 'installed'
  readonly sharedCredential?: true
  readonly job?: CommunityNativePluginJob
}
export interface CommunityMarketPageData {
  readonly plugins: readonly CommunityMarketPluginView[]
  readonly pending: boolean
}
export interface CommunityPluginPublishAction {
  readonly confirmed?: true
  readonly selectedMembers?: number
  readonly action: 'publish'
  readonly packageName: string
  readonly published: boolean
}
export interface CommunityMarketInstallAction {
  readonly packageName: string
  readonly action?: 'install' | 'uninstall'
  readonly requestId?: string
}
export type CommunityMarketInstallResult = { readonly application: 'applied' | 'restart-required' } | { readonly job: CommunityNativePluginJob }

export interface CommunityPluginPublishResult {
  readonly published: boolean
}

export type {
  CommunityPluginAccessInput,
  CommunityPluginAccessView,
  CommunityPluginUpstreamAction,
  CommunityPluginUpstreamInput,
  CommunityPluginUpstreamTestRequest,
  CommunityPluginUpstreamTestResult,
  CommunityPluginUpstreamView,
} from './plugin-access-contract.js'
