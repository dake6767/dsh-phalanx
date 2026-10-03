import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createCommunityApplication } from '../src/composition/community-application.js'
import { CommunityAccountStore } from '../src/adapters/community-account-store.js'
import { fileURLToPath } from 'node:url'

it('clears storage on first login and account changes, retains it on same-account login, and leaves failures alone', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'dsh-phalanx-login-storage-'))
  const app = createCommunityApplication({ listen: { host: '127.0.0.1', port: 0 },
    sessionSecret: 'login-storage-secret-with-at-least-32-bytes',
    runtime: { command: process.execPath, args: [fileURLToPath(new URL('./fixtures/runtime.mjs', import.meta.url))], dataRoot,
      defaultModel: { provider: 'deepseek-official', model: 'fixture',
        upstream: { baseUrl: 'http://127.0.0.1:1' } } },
  })
  try {
    const accounts = new CommunityAccountStore(join(dataRoot, 'community-accounts.db'))
    try { for (const username of ['alice', 'bob', 'root']) await accounts.create({ username,
      email: `${username}@dsh-phalanx.test`, password: 'password', ...(username === 'root' ? { admin: true } : {}) }) }
    finally { accounts.close() }
    const origin = await app.start()
    const login = async (username: string, cookie?: string, password = 'password') => await fetch(`${origin}/login`, {
      method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded',
        ...(cookie === undefined ? {} : { cookie }) }, body: new URLSearchParams({ username, password }),
    })
    const marker = (response: Response): string => {
      const cookie = response.headers.getSetCookie().find(value => value.startsWith('dsh-phalanx_last_account='))
      expect(cookie).toContain('HttpOnly')
      expect(cookie).toContain('SameSite=Strict')
      expect(cookie).toContain('Max-Age=31536000')
      expect(cookie).not.toMatch(/alice|bob|root/u)
      return cookie!.split(';', 1)[0]!
    }
    const first = await login('alice')
    expect(first.status).toBe(303)
    expect(first.headers.get('clear-site-data')).toBe('"storage"')
    const aliceMarker = marker(first)
    expect((await fetch(origin, { redirect: 'manual', headers: { cookie: aliceMarker } })).status).toBe(303)
    const same = await login('alice', aliceMarker)
    expect(same.status).toBe(303)
    expect(same.headers.get('clear-site-data')).toBeNull()
    expect(marker(same)).toBe(aliceMarker)
    const switched = await login('bob', aliceMarker)
    expect(switched.headers.get('clear-site-data')).toBe('"storage"')
    const bobMarker = marker(switched)
    expect(bobMarker).not.toBe(aliceMarker)
    const admin = await login('root', bobMarker)
    expect(admin.status).toBe(303)
    expect(admin.headers.get('clear-site-data')).toBe('"storage"')
    const rootMarker = marker(admin)
    expect((await login('root', rootMarker)).headers.get('clear-site-data')).toBeNull()
    const failed = await login('alice', rootMarker, 'wrong')
    expect(failed.status).toBe(401)
    expect(failed.headers.get('clear-site-data')).toBeNull()
    expect(failed.headers.getSetCookie()).toEqual([])
    const cookies = first.headers.getSetCookie().map(cookie => cookie.split(';', 1)[0]).join('; ')
    const served = await fetch(origin, { headers: { cookie: cookies } })
    expect(served.status).toBe(200)
    expect(served.headers.get('clear-site-data')).toBeNull()
    const logout = await fetch(`${origin}/logout`, { method: 'POST', redirect: 'manual', headers: { cookie: cookies, origin } })
    expect(logout.status).toBe(303)
    expect(logout.headers.getSetCookie().join(';')).not.toContain('dsh-phalanx_last_account')
    expect(logout.headers.get('clear-site-data')).toBeNull()
  } finally {
    await app.stop()
    await rm(dataRoot, { recursive: true, force: true })
  }
})
