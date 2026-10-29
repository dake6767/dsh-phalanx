/** Management wire types owned by this domain; exported through admin-contract. */
export interface CommunityMcpRun {
  readonly location: 'shared' | 'member'
  readonly command: string
  readonly args: readonly string[]
  readonly env: readonly CommunityMcpTemplate[]
  /** Legacy persisted input, consumed by migration. */
  readonly prepareCommand?: string
  readonly runtimeDependencies?: readonly string[]
}
export interface CommunityMcpService {
  readonly run?: CommunityMcpRun | null
  readonly name: string
  readonly description: string
  readonly url: string
}
export interface CommunityMcpGroup {
  readonly groupId: string
  readonly services: readonly (CommunityMcpSettings & { readonly granted: boolean })[]
}

export type CommunityMcpAction =
  | { readonly action: 'prepare'; readonly name: string }
  | { readonly action: 'save'; readonly service: CommunityMcpInput; readonly create?: boolean; readonly originalName?: string }
  | { readonly action: 'remove'; readonly name: string; readonly revision?: string }
  | { readonly action: 'publish'; readonly name: string; readonly published: boolean }

export interface CommunityMcpTemplate {
  readonly name: string
  readonly value: string
}
export interface CommunityMcpTool {
  readonly name: string
  readonly description?: string
  readonly inputSchema: Readonly<Record<string, unknown>>
  readonly isNew?: boolean
}
export interface CommunityMcpCatalogSource {
  readonly id: string
  readonly version: string
  readonly status: 'preparing' | 'testing' | 'ready' | 'failed'
}
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
export interface CommunityMcpCatalogInput {
  readonly presetId: string
  readonly name: string
  readonly credential: string
  readonly requestId: string
}
export interface CommunityMcpCatalogUpdateInput {
  readonly name: string
  readonly version: string
  readonly requestId: string
  readonly credential?: string
}
export interface CommunityMcpCatalogUpdatePreview {
  readonly currentVersion: string
  readonly version: string
  readonly credentialRequired: boolean
  readonly changes: readonly { readonly field: string; readonly before: string; readonly after: string }[]
}
export interface CommunityMcpSecretStatus {
  readonly configured: boolean
  readonly last4: string
}
export interface CommunityMcpSettings extends Omit<CommunityMcpService, 'run'> {
  readonly run: (Omit<CommunityMcpRun, 'env'> & { readonly env: readonly (CommunityMcpSecretStatus & { readonly name: string })[] }) | null
  /** Protected free-text fields are blank in the view and replaced only by new input. */
  readonly protectedFields: Readonly<Record<string, CommunityMcpSecretStatus>>
  readonly generation: number
  readonly credential: CommunityMcpSecretStatus
  readonly credentials: Readonly<Record<string, CommunityMcpSecretStatus>>
  readonly availableCatalogVersion?: string
  readonly catalogUpdate?: { readonly version: string; readonly status: 'preparing' | 'testing' | 'failed' | 'applied' }

  readonly catalog?: CommunityMcpCatalogSource
  readonly preparation?: {
    readonly isolated?: boolean
    readonly stage: 'preparing' | 'ready' | 'failed'
    readonly updatedAt: number
    readonly log: string
  }
  readonly published: boolean
  readonly required: boolean
  readonly credentialConfigured: boolean
  readonly credentialNames: readonly string[]
  readonly headers: readonly (CommunityMcpSecretStatus & { readonly name: string })[]
  readonly query: readonly (CommunityMcpSecretStatus & { readonly name: string })[]
  readonly disabledTools: readonly string[]
  readonly tools: readonly CommunityMcpTool[]
  readonly testStatus: 'untested' | 'passed' | 'failed'
}
export interface CommunityMcpInput extends CommunityMcpService {
  readonly clearCredential?: boolean
  readonly removeCredentials?: readonly string[]
  /** Retain a protected argument from this service's current generation, independently of its new position. */
  readonly retainedArguments?: readonly { readonly index: number; readonly sourceIndex: number; readonly generation: number }[]
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
export interface CommunityMarketMcpAction {
  readonly name: string
  readonly action: 'enable' | 'disable'
}
