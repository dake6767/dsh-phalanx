/** Single management wire contract for the server and browser. Types only. */
import type { CommunityGroupRecord } from './community-group.js'
import type { CommunityCreateAccountInput } from './community-account.js'

export type InstanceState = 'stopped' | 'starting' | 'ready' | 'draining'

export interface CommunitySessionInfo {
  readonly username: string
  readonly admin: boolean
}
/** Ordinary members may read only their own platform display identity. */
export interface CommunitySelfIdentity { readonly username: string }

export interface CommunityManagementSession extends CommunitySessionInfo {
  readonly modelState: 'unconfigured' | 'configured'
}

export interface CommunityAccountView extends CommunitySessionInfo {
  readonly groupId: string
  readonly spaceId: string
  readonly email: string
  readonly disabled: boolean
  readonly instance: { readonly state: InstanceState }
}

export interface CommunityAccountsPageData {
  readonly total: number
  readonly page: number
  readonly pageCount: number
  readonly items: readonly CommunityAccountView[]
}

export type CommunityCreateAccountRequest = CommunityCreateAccountInput

export type CommunityErrorCode =
  | 'plugin-local-copy-unavailable' | 'contribution-maintainer-required' | 'contribution-version-required' | 'contribution-check-failed'
  | 'contribution-invalid' | 'contribution-limit' | 'contribution-unavailable'
  | 'mcp-catalog-locked' | 'mcp-import-retired'
  | 'mcp-name-conflict' | 'mcp-runtime-not-ready' | 'mcp-required' | 'mcp-test-required' | 'mcp-test-stale' | 'mcp-service-unavailable' | 'mcp-service-invalid' | 'mcp-grant-invalid'
  | 'runtime-dependency-invalid' | 'runtime-dependency-name-conflict' | 'runtime-dependency-unavailable' | 'runtime-dependency-referenced' | 'runtime-dependency-locked'
  | 'execution-config-invalid'
  | 'skill-preview-changed' | 'skill-pack-invalid' | 'skill-pack-name-conflict' | 'skill-unavailable' | 'skill-sync-failed'
  | 'skill-archive-invalid' | 'skill-upload-too-large' | 'skill-frontmatter-invalid' | 'skill-builtin-conflict'
  | 'plugin-access-invalid' | 'plugin-publication-credential-confirmation'
  | 'plugin-upstream-test-required' | 'plugin-upstream-test-failed'
  | 'plugin-upstream-invalid' | 'plugin-upstream-referenced'
  | 'plugin-incompatible'
  | 'plugin-market-unavailable' | 'plugin-download-denied' | 'plugin-install-failed'
  | 'plugin-grant-invalid' | 'plugin-managed-load-failed'
  | 'plugin-version-conflict' | 'plugin-upload-extension' | 'plugin-upload-too-large' | 'plugin-upload-interrupted'
  | 'plugin-candidate-unavailable' | 'plugin-impact-changed' | 'plugin-job-busy'
  | 'plugin-identity-invalid' | 'plugin-name-in-use' | 'plugin-action-invalid'
  | 'plugin-cleanup-failed' | 'plugin-precheck-failed' | 'plugin-runtime-required' | 'plugin-dependency-invalid'
  | 'plugin-integrity-invalid' | 'plugin-job-interrupted' | 'plugin-package-invalid'
  | 'group-action-invalid'
  | 'group-name-invalid'
  | 'group-name-in-use'
  | 'group-not-found'
  | 'group-protected'
  | 'group-has-members'
  | 'group-role-conflict'
  | 'group-required'
  | 'password-required'
  | 'last-admin-required'
  | 'username-invalid'
  | 'email-invalid'
  | 'origin-forbidden'
  | 'account-request-invalid'
  | 'account-fields-invalid'
  | 'account-action-invalid'
  | 'account-action-unknown'
  | 'account-action-fields-unexpected'
  | 'account-action-fields-invalid'
  | 'json-invalid'
  | 'media-type-unsupported'
  | 'request-too-large'
  | 'request-interrupted'
  | 'update-query-invalid'
  | 'model-action-invalid'
  | 'account-path-invalid'
  | 'restart-confirmation-required'
  | 'update-action-invalid'
  | 'update-release-required'
  | 'update-confirmation-required'
  | 'update-operation-required'
  | 'sign-in-required'
  | 'admin-required'
  | 'email-in-use'
  | 'account-not-found'
  | 'bootstrap-complete'
  | 'username-in-use'
  | 'model-revision-conflict'
  | 'not-found'
  | 'bootstrap-credential-invalid'
  | 'environment-account-disabled'
  | 'environment-space-changed'
  | 'account-inactive'
  | 'credentials-invalid'
  | 'provider-not-found'
  | 'model-default-required'
  | 'provider-invalid'
  | 'method-not-allowed'
  | 'internal-error'
  | 'request-failed'
  | 'account-stop-failed'
  | 'update-service-unavailable'
  | 'update-request-refused'
  | 'runtime-draining'
  | 'runtime-shutdown'
  | 'runtime-start-cancelled'
  | 'runtime-authorization-unavailable'
  | 'runtime-profile-unavailable'
  | 'runtime-storage-unavailable'
  | 'runtime-startup-unavailable'
  | 'runtime-upgrade-unavailable'
  | 'environment-recovery-failed'

export type CommunityErrorParams = Readonly<Record<string, string | number | boolean>>

export interface CommunityApiErrorBody {
  readonly error: string
  readonly code: CommunityErrorCode
  readonly params?: CommunityErrorParams
}

export type CommunityAccountActionRequest = { readonly action: 'reset-password', readonly password: string }
  | { readonly action: 'set-email', readonly email: string, readonly groupId?: string }
  | { readonly action: 'set-disabled', readonly disabled: boolean }
  | { readonly action: 'set-admin', readonly admin: boolean, readonly groupId?: string }
  | { readonly action: 'delete' }

export type CommunityAccountActionResult =
  | { readonly kind: 'updated', readonly account: CommunityAccountView }
  | { readonly kind: 'deleted', readonly username: string, readonly userSpace: 'preserved' }

export interface CommunityProviderInput {
  readonly id?: string
  readonly name: string
  readonly baseUrl: string
  readonly apiFormat: 'anthropic-messages'
  readonly apiKey?: string
  readonly enabled: boolean
  readonly models: readonly { readonly id?: string, readonly name: string, readonly enabled: boolean }[]
}
export interface CommunityProviderView extends Omit<CommunityProviderInput, 'id' | 'apiKey' | 'models'> {
  readonly id: string
  readonly hasApiKey: boolean
  readonly models: readonly { readonly id: string, readonly name: string, readonly enabled: boolean }[]
}
export interface CommunityModelSettings {
  readonly revision: number
  readonly providers: readonly CommunityProviderView[]
  readonly defaultModelId: string | null
}
export type CommunityModelAction = { readonly revision: number, readonly defaultModelId?: string | null } & (
  { readonly action: 'save-provider', readonly provider: CommunityProviderInput }
  | { readonly action: 'delete-provider', readonly providerId: string }
  | { readonly action: 'set-default', readonly defaultModelId: string | null })
export interface CommunityRestartResult { readonly entry: string }

export interface CommunityEnvironmentBackup {
  readonly id: string
  readonly location: string
  readonly restoreInstructions: string
  readonly restoreInstructionsPath?: string
}
export interface CommunityEnvironmentResetResult {
  readonly username: string
  readonly spaceId: string
  readonly entry: string
  readonly backup: CommunityEnvironmentBackup
}
export interface CommunityEnvironmentResetRequest { readonly confirmed: true }
export interface CommunityEnvironmentResetFailure extends CommunityApiErrorBody {
  readonly phase: 'stop' | 'backup' | 'reset' | 'start'
  readonly backup?: CommunityEnvironmentBackup
}

export type { CommunitySystemUpdatePhase, CommunitySystemUpdateSpace, CommunitySystemUpdateCleanup, CommunitySystemUpdateOperation, CommunitySystemUpdateEvent, CommunitySystemUpdateStatus, CommunitySystemUpdateCheck, CommunitySystemUpdateCheckResult, CommunitySystemUpdateSubmission, CommunitySystemUpdateAction } from './system-update-contract.js'

export type CommunityGroupView = CommunityGroupRecord & { readonly pluginCount?: number, readonly skillCount?: number }
export type CommunityGroupAction = { readonly action: 'create', readonly name: string }
  | { readonly action: 'rename', readonly id: string, readonly name: string }
  | { readonly action: 'delete', readonly id: string }
  | { readonly action: 'set-default', readonly id: string, readonly confirmed: true }

export type CommunityPluginStage = 'resolving' | 'downloading' | 'installing' | 'prechecking' | 'available' | 'failed'
export type CommunityPluginChangeResult = CommunityPluginView | { readonly removed: string }
export interface CommunityPluginImpact { readonly groups: number, readonly members: number, readonly selectedMembers?: number, readonly revision: string }
export type CommunityPluginChangeAction = { readonly action: 'prepare', readonly packageName: string, readonly version: string }
  | { readonly action: 'select' | 'remove', readonly packageName: string, readonly revision: string, readonly confirmed: true }
export interface CommunityPluginView {
  readonly provenance?: import('./library-contribution.js').LibraryProvenance
  readonly maintenanceRevision?: string
  readonly accessConfigured?: boolean
  readonly invalidAccessEntries?: readonly string[]
  readonly hasPlatformCredential?: boolean
  readonly selectedMembers?: number
  readonly incompatible?: boolean
  readonly publicationPaused?: boolean
  readonly removing?: boolean
  readonly replacement?: { readonly version: string, readonly stage: CommunityPluginStage, readonly failureCode?: CommunityErrorCode }
  readonly failures?: readonly { username: string, code: 'plugin-managed-load-failed' }[]
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
export interface CommunityPluginAction { readonly action: 'add' | 'retry', readonly packageName: string, readonly version: string }

export interface CommunityManagedGroupView {
  readonly group: CommunityGroupView
  readonly plugins: readonly { packageName: string, title: string, version: string | null, granted: boolean, available: boolean, incompatible?: boolean,
    failures: readonly { username: string, code: 'plugin-managed-load-failed' }[] }[]
  readonly pendingMembers: readonly string[]
}

export type CommunityPluginGrantAction = { readonly action: 'save', readonly packages: readonly string[] } | { readonly action: 'restart', readonly confirmed: true }

export interface CommunityMarketPluginView {
  readonly contribution?: { readonly name?: string, readonly anonymous: boolean }
  readonly packageName: string
  readonly title: string
  readonly description: string
  readonly version: string
  readonly status: 'install' | 'selected' | 'managed' | 'native'
}
export interface CommunityMarketPageData { readonly plugins: readonly CommunityMarketPluginView[], readonly pending: boolean }
export interface CommunityPluginPublishAction { readonly confirmed?: true; readonly selectedMembers?: number; readonly action: 'publish', readonly packageName: string, readonly published: boolean }
export interface CommunityMarketInstallAction { readonly packageName: string, readonly action?: 'install' | 'uninstall' }
export interface CommunityMarketInstallResult { readonly application: 'applied' | 'restart-required' }

export interface CommunityPluginPublishResult { readonly published: boolean }

export interface CommunityPluginUpstreamTestRequest {
  readonly method: string
  readonly path: string
  readonly body?: unknown
}
export interface CommunityPluginUpstreamTestResult {
  readonly status: number
  readonly elapsedMs: number
  readonly passed: boolean
  readonly body: string
  readonly truncated: boolean
}
export interface CommunityPluginUpstreamInput {
  readonly testRequest?: CommunityPluginUpstreamTestRequest | null
  readonly name: string
  readonly baseUrl: string
  /** Omit to retain, empty string to clear. Never returned by a read endpoint. */
  readonly credential?: string
  readonly headers: readonly { readonly name: string, readonly value: string }[]
}
export interface CommunityPluginUpstreamView extends Omit<CommunityPluginUpstreamInput, 'credential'> {
  readonly hasCredential: boolean
}
export type CommunityPluginUpstreamAction = { readonly action: 'save', readonly upstream: CommunityPluginUpstreamInput }
  | { readonly action: 'delete', readonly name: string }

export interface CommunityPluginAccessInput {
  readonly environment: readonly { readonly name: string, readonly value: string }[]
  readonly entriesYaml: string
}
export interface CommunityPluginAccessView extends CommunityPluginAccessInput {
  readonly configured: boolean
  readonly entryIds: readonly string[]
  readonly invalidEntryIds: readonly string[]
}

export interface CommunitySkillImpact {
  readonly managedMembers: number
  readonly selectedMembers: number
  readonly revision: string
}
export interface CommunitySkillView {
  readonly runtimeDependencies?: readonly string[]
  readonly provenance?: import('./library-contribution.js').LibraryProvenance
  readonly maintenanceRevision?: string
  readonly source?: import('./skill-git-source.js').SkillGitSource
  readonly packs?: readonly string[]
  readonly name: string
  readonly description: string
  readonly hash: string
  readonly importedAt: number
  readonly published: boolean
  readonly conflict?: boolean
  readonly managedMembers: number
  readonly selectedMembers: number
}
export interface CommunitySkillDetail extends CommunitySkillView, CommunitySkillImpact {
  readonly markdown: string
  readonly files: readonly string[]
}
export interface CommunitySkillPreview {
  readonly token: string
  readonly name: string
  readonly description: string
  readonly markdown: string
  readonly files: readonly string[]
  readonly replacing: boolean
  readonly revision: string
  readonly managedMembers: number
  readonly selectedMembers: number
}
export type CommunitySkillChangeAction = { readonly action: 'confirm', readonly token: string, readonly revision: string }
  | { readonly action: 'remove', readonly name: string, readonly revision: string }
  | { readonly action: 'cancel', readonly token: string }
  | { readonly action: 'publish', readonly name: string, readonly published: boolean, readonly revision: string }

export interface CommunitySkillGroupView {
  readonly packs?: readonly { readonly name: string, readonly description: string, readonly granted: boolean, readonly empty: boolean }[]
  readonly group: CommunityGroupRecord
  readonly skills: readonly { readonly name: string, readonly description: string, readonly granted: boolean, readonly conflict: boolean }[]
  readonly members: number
  readonly revision: string
}

export interface CommunitySkillSynchronization { readonly pending: boolean }

export interface CommunityMarketSkillView {
  readonly contribution?: { readonly name?: string, readonly anonymous: boolean }
  readonly selectable?: boolean
  readonly selectedDirectly?: boolean
  readonly name: string
  readonly description: string
  readonly status: 'install' | 'selected' | 'managed' | 'overridden'
  readonly source: 'managed' | 'selected' | null
}
export interface CommunityMarketSkills { readonly skills: readonly CommunityMarketSkillView[], readonly pending: boolean }
export interface CommunityMarketSkillDetail extends CommunityMarketSkillView { readonly markdown: string, readonly files: readonly string[] }

export interface CommunityExecutionInput {
  readonly runtimeDependencies?: readonly string[]
  readonly enabled: boolean
  readonly commands: readonly { readonly command: string, readonly blocked: readonly string[] }[]
  readonly variables: readonly { readonly name: string, readonly value?: string, readonly secret: boolean }[]
  readonly prepare?: string
}
export interface CommunityExecutionView extends Omit<CommunityExecutionInput, 'variables'> {
  readonly awaitingPreparation?: boolean
  readonly unavailableCommands?: readonly string[]
  readonly preparation?: { readonly usable?: boolean, readonly usingPrevious?: boolean, readonly stage: 'preparing' | 'ready' | 'failed', readonly updatedAt: number, readonly log: string }
  readonly variables: readonly { readonly name: string, readonly value?: string, readonly secret: boolean, readonly configured: boolean }[]
}

export interface CommunityExecutionSettings { readonly limits: CommunityExecutionLimits, readonly isolated: boolean }
export interface CommunityExecutionTrial { readonly stdout: string, readonly stderr: string, readonly exitCode: number, readonly truncated: boolean }

export type CommunityExecutionLimits = import('./execution-control.js').ExecutionLimits
export type CommunityExecutionRecord = import('./execution-control.js').ExecutionRecord

export interface CommunitySkillPackInput {
  readonly name: string
  readonly description: string
  readonly skills: readonly string[]
  readonly instructions: string
  readonly published: boolean
}
export interface CommunitySkillPackView extends CommunitySkillPackInput {
  readonly empty: boolean
  readonly conflict: boolean
  readonly revision: string
}
export interface CommunitySkillPackDetail extends CommunitySkillPackView {
  readonly removal: {
    readonly deleting: readonly string[]
    readonly retained: readonly { readonly name: string, readonly reasons: readonly ('other-pack' | 'direct-grant')[] }[]
    readonly groups: readonly { readonly id: string, readonly name: string }[]
    readonly selectedMembers: number
    readonly selectedMembersWithSkills: number
  }
}
export interface CommunityMarketPack {
  readonly name: string
  readonly description: string
  readonly skills: readonly string[]
  readonly instructions: string
  readonly source: 'managed' | 'selected' | null
}

export interface CommunitySkillPackLibrary { readonly packs: readonly CommunitySkillPackView[], readonly revision: string }

export interface CommunitySkillImportPreview {
  readonly updating?: boolean
  readonly deleted?: readonly { readonly packs: readonly string[], readonly name: string, readonly managedMembers: number, readonly selectedMembers: number }[]
  readonly token: string
  readonly defaultPackName: string
  readonly candidates: readonly (import('./skill-import.js').SkillImportCandidate & { readonly change?: 'changed' | 'added' | 'unchanged', readonly replacing: boolean, readonly managedMembers: number, readonly selectedMembers: number })[]
  readonly packs: readonly import('./skill-import.js').SkillImportSuggestion[]
}
export interface CommunitySkillImportInput {
  readonly removals?: readonly string[]
  readonly token: string
  readonly names: readonly string[]
  readonly replacements: readonly string[]
  readonly packs: readonly { readonly name: string, readonly description: string, readonly skills: readonly string[], readonly note?: string }[]
}

export interface CommunityMcpRun {
  readonly location: 'shared' | 'member'
  readonly command: string
  readonly args: readonly string[]
  readonly env: readonly CommunityMcpTemplate[]
  readonly prepareCommand: string
}
export interface CommunityMcpService {
  readonly run?: CommunityMcpRun | null
  readonly name: string
  readonly description: string
  readonly url: string
}
export interface CommunityMcpGroup {
  readonly groupId: string
  readonly implicit: boolean
  readonly services: readonly (CommunityMcpService & { readonly granted: boolean })[]
}

export type CommunityMcpAction = { readonly action: 'prepare', readonly name: string } | { readonly action: 'save', readonly service: CommunityMcpInput, readonly create?: boolean, readonly originalName?: string } | { readonly action: 'remove', readonly name: string } | { readonly action: 'publish', readonly name: string, readonly published: boolean }

export interface CommunityMcpTemplate { readonly name: string, readonly value: string }
export interface CommunityMcpTool { readonly name: string, readonly description?: string, readonly inputSchema: Readonly<Record<string, unknown>>, readonly isNew?: boolean }
export interface CommunityMcpCatalogSource { readonly id: string, readonly version: string, readonly status: 'preparing' | 'testing' | 'ready' | 'failed' }
export interface CommunityMcpCatalogEntry {
  readonly id: string
  readonly version: string
  readonly title: Readonly<Record<'en' | 'zh-CN', string>>
  readonly description: Readonly<Record<'en' | 'zh-CN', string>>
  readonly location: 'remote' | 'shared' | 'member'
  readonly credentialLabel?: Readonly<Record<'en' | 'zh-CN', string>>
  readonly documentation: string
  readonly imported: number
}
export interface CommunityMcpCatalogInput { readonly presetId: string, readonly name: string, readonly credential: string, readonly requestId: string }
export interface CommunityMcpCatalogUpdateInput { readonly name: string, readonly version: string, readonly requestId: string, readonly credential?: string }
export interface CommunityMcpCatalogUpdatePreview {
  readonly currentVersion: string
  readonly version: string
  readonly credentialRequired: boolean
  readonly changes: readonly { readonly field: string, readonly before: string, readonly after: string }[]
}
export interface CommunityMcpSettings extends CommunityMcpService {
  readonly availableCatalogVersion?: string
  readonly catalogUpdate?: { readonly version: string, readonly status: 'preparing' | 'testing' | 'failed' | 'applied' }

  readonly catalog?: CommunityMcpCatalogSource
  readonly preparation?: { readonly isolated?: boolean, readonly stage: 'preparing' | 'ready' | 'failed', readonly updatedAt: number, readonly log: string }
  readonly published: boolean
  readonly required: boolean
  readonly credentialConfigured: boolean
  readonly credentialNames: readonly string[]
  readonly headers: readonly CommunityMcpTemplate[]
  readonly query: readonly CommunityMcpTemplate[]
  readonly disabledTools: readonly string[]
  readonly tools: readonly CommunityMcpTool[]
  readonly testStatus: 'untested' | 'passed' | 'failed'
}
export interface CommunityMcpInput extends CommunityMcpService {
  readonly credentials?: Readonly<Record<string, string>>
  readonly required?: boolean
  readonly credential?: string
  readonly headers?: readonly CommunityMcpTemplate[]
  readonly query?: readonly CommunityMcpTemplate[]
  readonly disabledTools?: readonly string[]
}

export interface CommunityMarketMcp {
  readonly name: string
  readonly description: string
  readonly granted: boolean
  readonly enabled: boolean
  readonly required: boolean
  readonly tools: readonly Pick<CommunityMcpTool, 'name' | 'description'>[]
}
export interface CommunityMarketMcpAction { readonly name: string, readonly action: 'enable' | 'disable' }

export type { CommunityContributionsView, CommunityContributionCounts, CommunityContributionGroupView, CommunityContributionPluginView, CommunityContributionReview, CommunityContributionInspection, CommunityPluginContributionInfo, CommunityLibraryMaintainerInput, ContributionPluginDraft } from './contribution-contract.js'

export type { CommunityRuntimeDependencyInput, CommunityRuntimeDependencyView, CommunityRuntimeDependencyAction } from './runtime-dependency-contract.js'

export interface CommunitySkillRuntimeDependenciesInput { readonly action: 'runtime-dependencies', readonly name: string, readonly names: readonly string[], readonly revision: string }
