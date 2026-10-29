/** Allows supervised construction to await pool shutdown and lock release before rebuilding. */
export class CommunityConstructionError extends Error {
  constructor(
    cause: unknown,
    readonly cleanup: Promise<void>,
  ) {
    super(cause instanceof Error ? cause.message : 'Platform construction failed', { cause })
  }
}
