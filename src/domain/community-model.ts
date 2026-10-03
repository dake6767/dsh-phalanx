/** Credential-independent denial facts for the default model route. */
export class CommunityModelAccessError extends Error {
  constructor(readonly kind: 'unauthenticated' | 'forbidden') {
    super(kind === 'unauthenticated' ? 'Model access is required' : 'Model access is unavailable')
  }
}
