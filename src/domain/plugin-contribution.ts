import type { PluginCandidate, PreparedPlugin } from './plugin-library.js'
/** Private preparation reference; excluded from member/browser responses. */
export interface PluginContributionArtifact {
  readonly checkedFor?: string
  readonly candidate: PluginCandidate
  readonly prepared: PreparedPlugin
}

export interface PluginContributionInspection {
  readonly files: readonly string[]
  readonly keyFiles: readonly { readonly path: string, readonly content: string }[]
  readonly findings: readonly import('./member-contribution.js').ContributionFinding[]
  readonly externalHosts?: readonly string[]
  readonly installScripts?: readonly string[]
}
