import type { TrustedSuiteCatalogKey } from '../domain/suite-catalog-signature.js'
import type { PublicEntryBinding } from '../inbound/stable-public-entry.js'
import type { Clock } from '../ports/clock.js'
import type { CommunityRuntimePort } from '../ports/community-runtime.js'
import type { CommunitySystemUpdatePort } from '../ports/community-system-update.js'
import type { ExecutionDeadlinePort } from '../ports/execution-control.js'
import type { MemberNativePluginManagerPort } from '../ports/member-native-plugins.js'
import type { PluginArchiveInspectorPort, PluginPreparerPort } from '../ports/plugin-library.js'
import type { UsageDecisionPort } from '../ports/usage-records.js'

import type { CommunityEnvironmentPort } from '../ports/community-environment.js'

export interface CommunityApplicationOptions {
  readonly publicEntry?: PublicEntryBinding
  readonly mcpPresets?: readonly import('../domain/mcp-catalog.js').McpPreset[]
  /** Test-only online catalog override: production startup reads the configured address and official keys. */
  readonly suiteCatalog?: { readonly address: string; readonly trustedKeys: readonly TrustedSuiteCatalogKey[] }
  readonly mcpTransport?: import('../ports/plugin-upstreams.js').PluginUpstreamTransportPort
  readonly clock?: Clock
  readonly executionDeadlines?: ExecutionDeadlinePort
  readonly pluginManager?: MemberNativePluginManagerPort
  readonly pluginArchiveInspector?: PluginArchiveInspectorPort
  readonly pluginPreparer?: PluginPreparerPort
  readonly runtime?: CommunityRuntimePort
  readonly environment?: CommunityEnvironmentPort
  readonly systemUpdate?: CommunitySystemUpdatePort
  /** Test seam: the DeepSeek retrieval destination; production always uses the public host. */
  readonly testOnlyUsageDecision?: UsageDecisionPort
  readonly testOnlyWebToolsUpstreamBaseUrl?: string
}
