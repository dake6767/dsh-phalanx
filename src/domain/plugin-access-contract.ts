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
  readonly clearCredential?: boolean
  readonly testRequest?: CommunityPluginUpstreamTestRequest | null
  readonly name: string
  readonly baseUrl: string
  /** Omit or leave blank to retain. Never returned by a read endpoint. */
  readonly credential?: string
  readonly headers: readonly { readonly name: string; readonly value: string }[]
}
export interface CommunityPluginUpstreamView extends Omit<CommunityPluginUpstreamInput, 'credential' | 'headers' | 'testRequest'> {
  readonly testRequest?: CommunityPluginUpstreamTestRequest | { readonly method: string; readonly configured: true }
  readonly credential: { readonly configured: boolean; readonly last4: string }
  readonly headers: readonly { readonly name: string; readonly configured: boolean; readonly last4: string }[]
}
export type CommunityPluginUpstreamAction =
  { readonly action: 'save'; readonly upstream: CommunityPluginUpstreamInput } | { readonly action: 'delete'; readonly name: string }

export interface CommunityPluginAccessInput {
  readonly clearEntriesYaml?: boolean
  /** Contribution defaults add missing keys without reading existing protected values. */
  readonly retainEntries?: boolean
  readonly environment: readonly { readonly name: string; readonly value: string }[]
  readonly entriesYaml: string
}
export interface CommunityPluginAccessView {
  readonly environment: readonly { readonly name: string; readonly configured: boolean; readonly last4: string }[]
  readonly entriesYaml: { readonly configured: boolean; readonly last4: string }
  readonly entryPaths: readonly string[]
  readonly configured: boolean
  readonly entryIds: readonly string[]
  readonly invalidEntryIds: readonly string[]
}
