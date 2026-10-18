/** Typed failures for the member web retrieval gateway; never branch on message text. */
export class CommunityWebToolsError extends Error {
  constructor(readonly kind: 'unconfigured' | 'credential-rejected' | 'timeout' | 'upstream') {
    super(communityWebToolsMessage(kind))
  }
}

/** Member-facing explanation for each retrieval failure. */
export function communityWebToolsMessage(kind: 'unconfigured' | 'credential-rejected' | 'timeout' | 'upstream'): string {
  switch (kind) {
    case 'unconfigured':
      // The member-facing wording names the upstream host, so the DSH seam owns it.
      return 'DeepSeek Search and Fetch are unavailable: no shared model credential is configured.'
    case 'credential-rejected':
      return 'The platform DeepSeek credential was rejected by the retrieval service. '
        + 'Ask an administrator to update the shared model provider.'
    case 'timeout':
      return 'The platform DeepSeek retrieval request timed out. Retry the search or fetch later.'
    case 'upstream':
      return 'DeepSeek web retrieval is unavailable right now. Retry the search or fetch later.'
  }
}
