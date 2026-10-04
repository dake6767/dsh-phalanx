import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { CommunityModelAccessPort, CommunityModelIdentity } from '../ports/community-model-access.js'

/** Durable opaque tokens stay outside user spaces so surviving instances retain scoped access. */
export class FileCommunityModelAccess implements CommunityModelAccessPort {
  private readonly tokens = new Map<string, { token: string, spaceId: string }>()
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    if (!existsSync(path)) return
    try {
      const entries: unknown = JSON.parse(readFileSync(path, 'utf8'))
      if (!Array.isArray(entries)) throw new Error('Invalid access entries')
      const seen = new Set<string>(); const users = new Set<string>()
      for (const entry of entries) {
        if (!Array.isArray(entry) || (entry.length !== 2 && entry.length !== 3) || typeof entry[0] !== 'string' || typeof entry[1] !== 'string'
          || !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(entry[0]) || !/^[A-Za-z0-9_-]{43}$/u.test(entry[1])
          || users.has(entry[0]) || seen.has(entry[1])) throw new Error('Invalid access entry')
        seen.add(entry[1]); users.add(entry[0])
        // Legacy tokens have no space binding; startup rebuilds carriers with fresh access.
        if (entry.length === 2) continue
        if (typeof entry[2] !== 'string' || entry[2].length === 0) throw new Error('Invalid access space')
        this.tokens.set(entry[0], { token: entry[1], spaceId: entry[2] })
      }
      chmodSync(path, 0o600)
    } catch { throw new Error('Community model access storage could not be loaded') }
  }
  forUser(username: string, spaceId: string): string {
    const existing = this.tokens.get(username)
    if (existing?.spaceId === spaceId) return existing.token
    const token = randomBytes(32).toString('base64url')
    const staging = `${this.path}.tmp-${randomBytes(8).toString('hex')}`
    try {
      writeFileSync(staging, JSON.stringify([...new Map([...this.tokens, [username, { token, spaceId }]])].map(([user, value]) => [user, value.token, value.spaceId])), { mode: 0o600, flag: 'wx' })
      renameSync(staging, this.path)
    } finally { rmSync(staging, { force: true }) }
    this.tokens.set(username, { token, spaceId })
    return token
  }
  resolve(token: string): CommunityModelIdentity | undefined {
    const actual = Buffer.from(token)
    if (actual.length !== 43) return undefined
    for (const [username, expected] of this.tokens) {
      if (timingSafeEqual(actual, Buffer.from(expected.token))) return { username, spaceId: expected.spaceId }
    }
    return undefined
  }
}
