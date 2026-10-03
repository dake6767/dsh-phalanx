import type { DshSessionPort } from '../ports/dsh-session.js'
import type { Clock } from '../ports/clock.js'
import { CommunityRuntimeUnavailableError, type CommunityUserInstance, type CommunityRuntimePort } from '../ports/community-runtime.js'
import type { SessionRegistryPort } from '../ports/session-registry.js'

export interface IdleReclamationDeps {
  readonly idleSeconds: number | undefined
  readonly clock: Clock
  readonly sessions: SessionRegistryPort
  readonly runtime: Pick<CommunityRuntimePort, 'status' | 'reclaim'>
  readonly dsh: Pick<DshSessionPort, 'hasRunningAgent'>
  readonly users: () => readonly string[]
  readonly recordsReady: () => boolean
  readonly gateClosed: (userId: string) => boolean
  readonly origin: () => URL
  readonly onReclaimed: (userId: string) => void
  readonly onError: (error: unknown) => void
}

/** One activity fence serves operator reclamation and the idle sweep. */
export function createIdleReclamation(deps: IdleReclamationDeps): {
  prepare(userId: string, instance: CommunityUserInstance, origin: URL): Promise<boolean>
  check(): Promise<void>
} {
  let running = false
  const prepare = async (userId: string, instance: CommunityUserInstance, origin: URL): Promise<boolean> => {
    const cookie = deps.sessions.runtimeCookie(userId)
    if (cookie === undefined) throw new CommunityRuntimeUnavailableError('authorization-unavailable', 'Runtime authorization is unavailable')
    if (await deps.dsh.hasRunningAgent(instance, cookie, origin)) return false
    await deps.sessions.closeUser(userId)
    return !(await deps.dsh.hasRunningAgent(instance, cookie, origin))
  }

  const check = async (): Promise<void> => {
    if (deps.idleSeconds === undefined || deps.idleSeconds <= 0 || !deps.recordsReady() || running) return
    running = true
    try {
      const now = deps.clock.now()
      const origin = deps.origin()
      for (const userId of deps.users()) {
        if (deps.gateClosed(userId) || deps.runtime.status(userId).state !== 'ready') {
          deps.sessions.clearIdle(userId)
          continue
        }
        if (deps.sessions.hasUser(userId)) {
          deps.sessions.setIdleSince(userId, now)
          continue
        }
        const since = deps.sessions.idleSince(userId) ?? now
        deps.sessions.setIdleSince(userId, since)
        if (now - since < deps.idleSeconds * 1000) continue
        // A missing credential makes the DSH activity check unverifiable.
        if (deps.sessions.runtimeCookie(userId) === undefined) continue
        const result = await deps.runtime.reclaim(userId, async instance => await prepare(userId, instance, origin))
          .catch(() => undefined)
        deps.sessions.clearIdle(userId)
        if (result === 'reclaimed') deps.onReclaimed(userId)
      }
    } catch (error) {
      deps.onError(error)
    } finally {
      running = false
    }
  }

  return { prepare, check }
}
