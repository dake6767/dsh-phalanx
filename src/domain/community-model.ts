/** Credential-independent denial facts for the default model route. */
export class CommunityModelAccessError extends Error {
  constructor(readonly kind: 'unauthenticated' | 'forbidden') {
    super(kind === 'unauthenticated' ? 'Model access is required' : 'Model access is unavailable')
  }
}

export class CommunityModelRouteError extends Error {
  constructor(readonly kind: 'unconfigured' | 'unavailable') {
    super(kind === 'unconfigured' ? 'Shared models are not configured. Ask an administrator to configure a provider in Model settings.'
      : 'This shared model is disabled or was removed. Select an enabled shared model to continue.')
  }
}
