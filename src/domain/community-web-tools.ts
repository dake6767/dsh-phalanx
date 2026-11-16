/** Typed failures for the member web retrieval gateway; never branch on message text. */
export class CommunityWebToolsError extends Error {
  constructor(
    readonly kind: 'unconfigured' | 'credential-rejected' | 'timeout' | 'upstream',
    host = 'the configured retrieval host',
  ) {
    super(communityWebToolsMessage(kind, host))
  }
}

/** One owner for member-facing explanations; the retrieval seam supplies its host. */
export function communityWebToolsMessage(
  kind: 'unconfigured' | 'credential-rejected' | 'timeout' | 'upstream',
  host = 'the configured retrieval host',
): string {
  switch (kind) {
    case 'unconfigured':
      return `Platform DeepSeek Search for ${host} is not configured. Ask an administrator to check DSH features in System settings.`
    case 'credential-rejected':
      return 'The platform DeepSeek Search credential was rejected. Ask an administrator to update it in DSH features.'
    case 'timeout':
      return 'The platform DeepSeek retrieval request timed out. Retry the search or fetch later.'
    case 'upstream':
      return 'DeepSeek web retrieval is unavailable right now. Retry the search or fetch later.'
  }
}
