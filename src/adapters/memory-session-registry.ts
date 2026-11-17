import type { SessionConnection, SessionRegistryPort } from '../ports/session-registry.js'

/** Process-local owner of DSH credentials, entry connections and idle windows. */
export class MemorySessionRegistry implements SessionRegistryPort {
  private readonly connections = new Set<SessionConnection>()
  private readonly userConnections = new Map<string, Set<SessionConnection>>()
  private readonly connectionUsers = new Map<SessionConnection, { userId: string; activity: 'active' | 'passive' }>()
  private readonly cookies = new Map<string, string>()
  private readonly idleTimes = new Map<string, number>()

  registerConnection(connection: SessionConnection, trackUsers: boolean): void {
    this.connections.add(connection)
    connection.once('close', () => {
      this.connections.delete(connection)
      if (trackUsers) this.untrack(connection)
    })
  }

  track(userId: string, connection: SessionConnection, activity: 'active' | 'passive' = 'active'): void {
    this.untrack(connection)
    const owned = this.userConnections.get(userId) ?? new Set<SessionConnection>()
    owned.add(connection)
    this.userConnections.set(userId, owned)
    this.connectionUsers.set(connection, { userId, activity })
  }

  untrack(connection: SessionConnection): void {
    const previous = this.connectionUsers.get(connection)
    if (previous === undefined) return
    this.connectionUsers.delete(connection)
    const owned = this.userConnections.get(previous.userId)
    owned?.delete(connection)
    if (owned?.size === 0) this.userConnections.delete(previous.userId)
  }

  hasActiveConnection(userId: string): boolean {
    for (const connection of this.userConnections.get(userId) ?? []) {
      if (this.connectionUsers.get(connection)?.activity === 'active') return true
    }
    return false
  }

  async closeUser(userId: string): Promise<void> {
    const owned = this.userConnections.get(userId)
    if (owned === undefined) return
    this.userConnections.delete(userId)
    await Promise.all(
      [...owned].map(async connection => {
        this.connectionUsers.delete(connection)
        if (connection.destroyed) return
        await new Promise<void>(resolve => {
          connection.once('close', resolve)
          connection.destroy()
        })
      }),
    )
  }

  closeAll(): void {
    for (const connection of this.connections) connection.destroy()
  }
  rememberRuntimeCookie(userId: string, cookie: string): void {
    this.cookies.set(userId, cookie)
  }
  runtimeCookie(userId: string): string | undefined {
    return this.cookies.get(userId)
  }
  idleSince(userId: string): number | undefined {
    return this.idleTimes.get(userId)
  }
  setIdleSince(userId: string, since: number): void {
    this.idleTimes.set(userId, since)
  }
  clearIdle(userId: string): void {
    this.idleTimes.delete(userId)
  }
  clearAllIdle(): void {
    this.idleTimes.clear()
  }
}
