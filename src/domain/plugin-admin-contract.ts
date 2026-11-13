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
  | { readonly action: 'update'; readonly packageName: string }
  | { readonly action: 'select' | 'remove'; readonly packageName: string; readonly revision: string; readonly confirmed: true }
/** The result of an administrator's on-demand update check: npm latest for registry sources, commits for GitHub sources. */
export interface CommunityPluginUpdateCheck {
  readonly packageName: string
  readonly currentVersion: string
  /** npm: the registry latest version. GitHub: unknown before packing, so the check reports commits instead. */
  readonly latestVersion: string | null
  readonly hasUpdate: boolean
  /** GitHub: the commit recorded in the library. */
  readonly currentCommit?: string
  /** GitHub: the default-branch head found by this check. */
  readonly latestCommit?: string
}
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
  readonly source: 'npm' | 'upload' | 'github'
  /** GitHub sources: owner/repo recorded when the plugin was added. */
  readonly repository?: string
  /** GitHub sources: the full commit of the current version. */
  readonly sourceCommit?: string
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
  readonly action: 'retry'
  readonly input: string
}

export type { CommunityManagedGroupView, CommunityPluginGrantAction } from './plugin-group-contract.js'

export interface CommunityNativePluginJob {
  readonly requestId: string
  readonly action: 'install' | 'uninstall' | 'update'
  readonly status: 'running' | 'succeeded' | 'failed'
  readonly phase: 'preparing' | 'downloading' | 'installing' | 'removing' | 'complete'
  readonly application?: 'applied' | 'restart-required'
  readonly failure?: CommunityApiErrorBody
}
export interface CommunityPluginUpdateChoice {
  readonly kind: 'version' | 'content'
  readonly version: string
  readonly target: string
}
export interface CommunityMarketPluginView {
  readonly contribution?: { readonly name?: string; readonly anonymous: boolean }
  readonly packageName: string
  readonly title: string
  readonly description: string
  readonly version: string
  readonly status: 'install' | 'selected' | 'managed' | 'native' | 'installed' | 'unknown'
  readonly sharedCredential?: true
  readonly installedVersion?: string
  readonly retryReceipt?: true
  readonly update?: CommunityPluginUpdateChoice
  readonly job?: CommunityNativePluginJob
}
export interface CommunityNativeServiceBindingView {
  readonly slot: string
  readonly status: 'applied' | 'inactive' | 'failed' | 'conflict' | 'unsupported' | 'pending'
  readonly refresh?: true
}
export interface CommunityMarketNativeServiceView {
  readonly packageName: string
  readonly bindings: readonly CommunityNativeServiceBindingView[]
}
export interface CommunityMarketPreinstallFailure {
  readonly packageName: string
  readonly restartRequired: boolean
}
export interface CommunityMarketPageData {
  readonly plugins: readonly CommunityMarketPluginView[]
  readonly pending: boolean
  readonly nativeServices?: readonly CommunityMarketNativeServiceView[]
  readonly preinstallFailures?: readonly CommunityMarketPreinstallFailure[]
  readonly unlistedUpdates?: readonly { readonly packageName: string; readonly job: CommunityNativePluginJob }[]
}
export interface CommunityPluginPublishAction {
  readonly expected?: import('./plugin-group-contract.js').CatalogPluginDistributionIdentity
  readonly confirmed?: true
  readonly selectedMembers?: number
  readonly action: 'publish'
  readonly packageName: string
  readonly published: boolean
}
export interface CommunityMarketInstallAction {
  readonly packageName: string
  readonly action?: 'install' | 'uninstall' | 'update' | 'retry-receipt'
  readonly target?: string
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

export interface CommunityPluginPreview {
  readonly dependencies?: Readonly<Record<string, string>>
  readonly token: string
  readonly input: string
  readonly source: 'npm' | 'github'
  readonly repository?: string
  /** GitHub sources: the default-branch commit pinned by this precheck. */
  readonly sourceCommit?: string
  readonly stage: Exclude<CommunityPluginStage, 'available'> | 'ready'
  readonly packageName?: string
  readonly version?: string
  readonly title?: string
  readonly description?: string
  readonly integrity?: string
  readonly failureCode?: CommunityErrorCode
}
