import type { CommunityErrorCode } from './admin-error-contract.js'
import type { DownloadSourcePreset, DownloadSourceSelection, DownloadSourceValues } from './download-source.js'
/** Single management wire contract for the server and browser. Types only. */
import type { CommunityCreateAccountInput } from './community-account.js'
import type { CommunityGroupRecord } from './community-group.js'
export type { McpRemovalImpact as CommunityMcpRemovalImpact } from './mcp-removal.js'

export type {
  CommunityExpertGroup,
  CommunityExpertImpact,
  CommunityExpertInput,
  CommunityExpertLibrary,
  CommunityExpertMarket,
} from './expert-admin-contract.js'

export type InstanceState = 'stopped' | 'starting' | 'ready' | 'draining'

export type CommunityInstanceResourceLimits = import('./instance-resources.js').InstanceResourceLimits
export type CommunityInstanceResourceMember = import('./instance-resources.js').InstanceResourceMember
export type CommunityInstanceResourceSettings = import('./instance-resources.js').InstanceResourceSettingsView
export type CommunityInstanceResourceTarget = import('./instance-resources.js').InstanceResourceTarget
export type CommunityInstanceResourceApplication = import('./instance-resources.js').InstanceResourceApplication
export type CommunityInstanceResourceAction =
  | { readonly action: 'save-defaults'; readonly idleSeconds?: number; readonly revision: number; readonly limits: CommunityInstanceResourceLimits }
  | {
      readonly action: 'save-member'
      readonly resident?: boolean
      readonly revision: number
      readonly username: string
      readonly spaceId: string
      readonly override: CommunityInstanceResourceLimits | null
    }
  | { readonly action: 'apply'; readonly revision: number; readonly confirmed: boolean; readonly targets: readonly CommunityInstanceResourceTarget[] }

export interface CommunitySessionInfo {
  readonly username: string
  readonly admin: boolean
}
/** Ordinary members may read only their own platform display identity. */
export interface CommunitySelfIdentity {
  readonly username: string
}

export interface CommunityManagementSession extends CommunitySessionInfo {
  readonly modelState: 'unconfigured' | 'configured'
}

export interface CommunityAccountView extends CommunitySessionInfo {
  readonly groupId: string
  readonly spaceId: string
  readonly email: string
  readonly disabled: boolean
  readonly lastEnvironmentReset?: import('./environment-reset-history.js').EnvironmentResetRequest
  readonly instance: { readonly state: InstanceState; readonly resourcePending?: boolean }
}

export interface CommunityAccountsPageData {
  readonly total: number
  readonly page: number
  readonly pageCount: number
  readonly items: readonly CommunityAccountView[]
}

export type CommunityCreateAccountRequest = CommunityCreateAccountInput

export type CommunityUsageQuery = import('./usage-record.js').UsageQuery
export type CommunityUsageRecords = import('./usage-record.js').UsageRecordsView
export interface CommunityUsageSettings {
  readonly retentionDays: number
}

export type { CommunitySystemStatusView } from './system-status-contract.js'

export type * from './admin-error-contract.js'

export type CommunityAccountActionRequest =
  | { readonly action: 'reset-password'; readonly password: string }
  | { readonly action: 'set-email'; readonly email: string; readonly groupId?: string }
  | { readonly action: 'set-disabled'; readonly disabled: boolean }
  | { readonly action: 'set-admin'; readonly admin: boolean; readonly groupId?: string }
  | { readonly action: 'delete' }

export type CommunityAccountActionResult =
  | { readonly kind: 'updated'; readonly account: CommunityAccountView }
  | { readonly kind: 'deleted'; readonly username: string; readonly userSpace: 'preserved' }

/** Declared input kinds of one shared model. `text+image` is the DSH `['text', 'image']` declaration. */
export type CommunityModelInput = 'text' | 'text+image'
export interface CommunityProviderInput {
  readonly id?: string
  readonly name: string
  readonly baseUrl: string
  readonly apiFormat: 'anthropic-messages'
  readonly apiKey?: string
  readonly enabled: boolean
  /** An omitted input keeps older management clients compatible; the server reuses the stored row's declaration, or the known model default for a new row. */
  readonly models: readonly { readonly id?: string; readonly name: string; readonly enabled: boolean; readonly input?: CommunityModelInput }[]
}
export interface CommunityProviderView extends Omit<CommunityProviderInput, 'id' | 'apiKey' | 'models'> {
  readonly id: string
  readonly apiKey: { readonly configured: boolean; readonly last4: string }
  readonly models: readonly { readonly id: string; readonly name: string; readonly enabled: boolean; readonly input: CommunityModelInput }[]
}
export interface CommunityModelSettings {
  readonly revision: number
  readonly providers: readonly CommunityProviderView[]
  readonly defaultModelId: string | null
}
export type CommunityModelAction = { readonly revision: number; readonly defaultModelId?: string | null } & (
  | { readonly action: 'save-provider'; readonly provider: CommunityProviderInput }
  | { readonly action: 'delete-provider'; readonly providerId: string }
  | { readonly action: 'set-default'; readonly defaultModelId: string | null }
)
export interface CommunityRestartResult {
  readonly entry: string
}
export type CommunityStartupStage = 'preparing' | 'starting' | 'connecting'
export type CommunityStartupView = { readonly state: CommunityStartupStage | 'ready' } | { readonly state: 'failed'; readonly code: CommunityErrorCode }

export type CommunityEnvironmentBackup = import('./community-environment.js').EnvironmentBackup
export type CommunityEnvironmentResetResult = import('./community-environment.js').EnvironmentResetResult
export type CommunityEnvironmentResetRequest = import('./community-environment.js').EnvironmentResetConfirmation
export type CommunityEnvironmentResetFailure = import('./community-environment.js').EnvironmentResetFailure
export type CommunitySelfEnvironmentResetResult = import('./community-environment.js').SelfEnvironmentResetResult
export type CommunitySelfEnvironmentResetFailure = import('./community-environment.js').SelfEnvironmentResetFailure

export type {
  CommunitySystemUpdateAction,
  CommunitySystemUpdateCheck,
  CommunitySystemUpdateCheckResult,
  CommunitySystemUpdateCleanup,
  CommunitySystemUpdateEvent,
  CommunitySystemUpdateOperation,
  CommunitySystemUpdatePhase,
  CommunitySystemUpdateSpace,
  CommunitySystemUpdateStatus,
  CommunitySystemUpdateSubmission,
} from './system-update-contract.js'

export type CommunityGroupView = CommunityGroupRecord & { readonly pluginCount?: number; readonly skillCount?: number }
export type CommunityGroupAction =
  | { readonly action: 'create'; readonly name: string }
  | { readonly action: 'rename'; readonly id: string; readonly name: string }
  | { readonly action: 'delete'; readonly id: string }
  | { readonly action: 'set-default'; readonly id: string; readonly confirmed: true }

export type * from './plugin-admin-contract.js'

export type * from './skill-admin-contract.js'

export type * from './mcp-admin-contract.js'

export type {
  CommunityContributionCounts,
  CommunityContributionGroupView,
  CommunityContributionInspection,
  CommunityContributionPluginView,
  CommunityContributionReview,
  CommunityContributionsView,
  CommunityLibraryMaintainerInput,
  CommunityPluginContributionInfo,
  ContributionPluginDraft,
} from './contribution-contract.js'

export type { CommunityRuntimeDependencyAction, CommunityRuntimeDependencyInput, CommunityRuntimeDependencyView } from './runtime-dependency-contract.js'

export type {
  CommunitySuiteCatalogEntryView,
  CommunitySuiteCatalogSourceView,
  CommunitySuiteCatalogView,
  CommunitySuiteInstallEntry,
  CommunitySuiteInstallInput,
  CommunitySuiteInstallPlanEntry,
  CommunitySuiteInstallPreview,
  CommunitySuiteInstallView,
  CommunitySuiteUninstallInput,
  CommunitySuiteUninstallPreview,
  CommunitySuiteUpdatePreview,
} from './suite-contract.js'

export interface CommunitySkillRuntimeDependenciesInput {
  readonly action: 'runtime-dependencies'
  readonly name: string
  readonly names: readonly string[]
  readonly revision: string
}

export interface CommunityDownloadSourcesView extends DownloadSourceSelection {
  readonly sources: DownloadSourceValues
  readonly presets: Readonly<Record<DownloadSourcePreset, DownloadSourceValues>>
}

export type CommunityModelUsage = import('./usage-record.js').UsageModelView
export type CommunityModelUsageQuery = import('./usage-record.js').UsageModelQuery

export type CommunityReportedUsage = import('./usage-record.js').UsageReportedView
export type CommunityReportedUsageQuery = import('./usage-record.js').UsageReportedQuery
