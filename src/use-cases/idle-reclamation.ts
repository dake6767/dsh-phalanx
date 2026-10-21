import type { DshSessionPort } from '../ports/dsh-session.js'
import type { Clock } from '../ports/clock.js'
import { CommunityRuntimeUnavailableError, type CommunityUserInstance, type CommunityRuntimePort } from '../ports/community-runtime.js'
import type { SessionRegistryPort } from '../ports/session-registry.js'

export interface IdleReclamationDeps {
  readonly idleSeconds: number | undefined | (() => number)
  readonly resident?: (userId: string) => boolean
  readonly afterHealthCheck?: () => void
  readonly clock: Clock
  readonly sessions: SessionRegistryPort
  readonly runtime: Pick<CommunityRuntimePort, 'status' | 'reclaim' | 'refresh'>
  readonly dsh: Pick<DshSessionPort, 'hasRunningAgent'>
  readonly users: () => readonly string[]
  readonly recordsReady: () => boolean
  readonly gateClosed: (userId: string) => boolean
  readonly origin: () => URL
  readonly previewActivity?: (userId: string) => number | undefined
  readonly onReclaimed: (userId: string) => void
  readonly onError: (error: unknown) => void
}

/** One activity fence serves operator reclamation and the idle sweep. */
export function createIdleReclamation(deps: IdleReclamationDeps): {
  readonly intervalMs: number
  prepare(userId: string, instance: CommunityUserInstance, origin: URL): Promise<boolean>
  check(): Promise<void>
} {
  const readIdleSeconds = () => typeof deps.idleSeconds === 'function' ? deps.idleSeconds() : deps.idleSeconds
  const initial = readIdleSeconds()
  const desiredInterval = typeof deps.idleSeconds === 'function' ? 1_000 : initial !== undefined && initial > 0
    ? Math.min(30_000, Math.max(1_000, Math.floor(initial * 250))) : 30_000
  // Every scan period divides the health period, so an idle setting cannot delay it.
  const intervalMs = [30_000, 15_000, 10_000, 5_000, 2_000, 1_000].find(value => value <= desiredInterval)!
  let running = false
  let checkedAt: number | undefined
  const prepare = async (userId: string, instance: CommunityUserInstance, origin: URL, eligible: () => boolean = () => true): Promise<boolean> => {
    if (!eligible()) return false
    const cookie = deps.sessions.runtimeCookie(userId)
    if (cookie === undefined) throw new CommunityRuntimeUnavailableError('authorization-unavailable', 'Runtime authorization is unavailable')
    if (await deps.dsh.hasRunningAgent(instance, cookie, origin) || !eligible()) return false
    await deps.sessions.closeUser(userId)
    return !(await deps.dsh.hasRunningAgent(instance, cookie, origin)) && eligible()
  }

  const check = async (): Promise<void> => {
    if (!deps.recordsReady() || running) return
    running = true
    try {
      const now = deps.clock.now()
      if (checkedAt === undefined || now - checkedAt >= 30_000) {
        checkedAt = now
        await deps.runtime.refresh?.()
        deps.afterHealthCheck?.()
      }
      const idleSeconds = readIdleSeconds()
      if (idleSeconds === undefined || idleSeconds <= 0) return
      const origin = deps.origin()
      for (const userId of deps.users()) {
        if (deps.resident?.(userId) || deps.gateClosed(userId) || deps.runtime.status(userId).state !== 'ready') {
          deps.sessions.clearIdle(userId)
          continue
        }
        if (deps.sessions.hasUser(userId)) {
          deps.sessions.setIdleSince(userId, now)
          continue
        }
        const since = Math.max(deps.sessions.idleSince(userId) ?? now, deps.previewActivity?.(userId) ?? 0)
        deps.sessions.setIdleSince(userId, since)
        const eligible = () => {
          const seconds = readIdleSeconds()
          return seconds !== undefined && seconds > 0 && !deps.resident?.(userId) && !deps.gateClosed(userId)
            && !deps.sessions.hasUser(userId) && deps.clock.now() - Math.max(since, deps.previewActivity?.(userId) ?? 0) >= seconds * 1000
        }
        if (!eligible()) continue
        // A missing credential makes the DSH activity check unverifiable.
        if (deps.sessions.runtimeCookie(userId) === undefined) continue
        const result = await deps.runtime.reclaim(userId, async instance => await prepare(userId, instance, origin, eligible))
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

  return { intervalMs, prepare, check }
}
