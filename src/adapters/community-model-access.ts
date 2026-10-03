import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { CommunityModelAccessPort } from '../ports/community-model-access.js'

/** Durable opaque tokens stay outside user spaces so surviving instances retain scoped access. */
export class FileCommunityModelAccess implements CommunityModelAccessPort {
  private readonly tokens = new Map<string, string>()
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    if (!existsSync(path)) return
    try {
      const entries: unknown = JSON.parse(readFileSync(path, 'utf8'))
      if (!Array.isArray(entries)) throw new Error('Invalid access entries')
      const seen = new Set<string>()
      for (const entry of entries) {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || typeof entry[1] !== 'string'
          || !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(entry[0]) || !/^[A-Za-z0-9_-]{43}$/u.test(entry[1])
          || this.tokens.has(entry[0]) || seen.has(entry[1])) throw new Error('Invalid access entry')
        this.tokens.set(entry[0], entry[1]); seen.add(entry[1])
      }
      chmodSync(path, 0o600)
    } catch { throw new Error('Community model access storage could not be loaded') }
  }
  forUser(username: string): string {
    const existing = this.tokens.get(username)
    if (existing !== undefined) return existing
    const token = randomBytes(32).toString('base64url')
    const staging = `${this.path}.tmp-${randomBytes(8).toString('hex')}`
    try {
      writeFileSync(staging, JSON.stringify([...this.tokens, [username, token]]), { mode: 0o600, flag: 'wx' })
      renameSync(staging, this.path)
    } finally { rmSync(staging, { force: true }) }
    this.tokens.set(username, token)
    return token
  }
  resolve(token: string): string | undefined {
    const actual = Buffer.from(token)
    if (actual.length !== 43) return undefined
    for (const [username, expected] of this.tokens) {
      if (timingSafeEqual(actual, Buffer.from(expected))) return username
    }
    return undefined
  }
}
