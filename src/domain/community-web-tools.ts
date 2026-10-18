/** Typed failures for the member web retrieval gateway; never branch on message text. */
export class CommunityWebToolsError extends Error {
  constructor(readonly kind: 'unconfigured' | 'credential-rejected' | 'timeout' | 'upstream', host = 'the configured retrieval host') {
    super(communityWebToolsMessage(kind, host))
  }
}

/** One owner for member-facing explanations; the retrieval seam supplies its host. */
export function communityWebToolsMessage(kind: 'unconfigured' | 'credential-rejected' | 'timeout' | 'upstream', host = 'the configured retrieval host'): string {
  switch (kind) {
    case 'unconfigured':
      return 'DeepSeek Search and Fetch are unavailable: no shared model '
        + `credential for ${host} is configured. Ask an administrator to configure a DeepSeek provider in `
        + 'Model management. A provider that proxies another host does not supply this retrieval credential.'
    case 'credential-rejected':
      return 'The platform DeepSeek credential was rejected by the retrieval service. '
        + 'Ask an administrator to update the shared model provider.'
    case 'timeout':
      return 'The platform DeepSeek retrieval request timed out. Retry the search or fetch later.'
    case 'upstream':
      return 'DeepSeek web retrieval is unavailable right now. Retry the search or fetch later.'
  }
}
