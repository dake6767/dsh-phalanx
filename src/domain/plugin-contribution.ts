import type { PluginCandidate, PreparedPlugin } from './plugin-library.js'
/** Private preparation reference; excluded from member/browser responses. */
export interface PluginContributionArtifact {
  readonly checkedFor?: string
  readonly candidate: PluginCandidate
  readonly prepared: PreparedPlugin
}
