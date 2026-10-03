/** The entry transport supplies sockets; the registry owns their account association. */
export interface SessionConnection {
  readonly destroyed: boolean
  once(event: 'close', listener: () => void): void
  destroy(): void
}

/** Ephemeral session facts shared by entry handlers and reclamation. */
export interface SessionRegistryPort {
  registerConnection(connection: SessionConnection, trackUsers: boolean): void
  track(userId: string, connection: SessionConnection): void
  untrack(connection: SessionConnection): void
  hasUser(userId: string): boolean
  closeUser(userId: string): Promise<void>
  closeAll(): void
  rememberRuntimeCookie(userId: string, cookie: string): void
  runtimeCookie(userId: string): string | undefined
  idleSince(userId: string): number | undefined
  setIdleSince(userId: string, since: number): void
  clearIdle(userId: string): void
  clearAllIdle(): void
}
