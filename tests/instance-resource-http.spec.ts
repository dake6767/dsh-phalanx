import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { createCommunityApplication } from '../src/composition/community-application.js'
import { CommunityAccountStore } from '../src/adapters/community-account-store.js'

it('serves private revisioned resource settings, persists changes and blocks member, cross-origin and development application', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'instance-resource-http-'))
  const config = { listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'resource-settings-http-secret-at-least-32-bytes',
    runtime: { command: process.execPath, args: [fileURLToPath(new URL('./fixtures/runtime.mjs', import.meta.url))], dataRoot, defaultModel: { provider: 'deepseek-official' as const, model: 'fixture', upstream: { baseUrl: 'http://127.0.0.1:1' } } } }
  let app = createCommunityApplication(config)
  try {
    const accounts = new CommunityAccountStore(join(dataRoot, 'community-accounts.db'))
    let spaceId: string
    try { await accounts.createFirstAdmin({ username: 'admin', email: '', password: 'password' }); spaceId = (await accounts.create({ username: 'member', email: '', password: 'password' })).spaceId } finally { accounts.close() }
    let origin = await app.start()
    const login = async (username: string) => {
      const response = await fetch(origin + '/login', { method: 'POST', redirect: 'manual', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username, password: 'password' }) })
      expect(response.status).toBe(303)
      return response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    }
    const admin = await login('admin'), member = await login('member')
    const endpoint = '/admin/api/instance-resources'
    const get = (cookie?: string, suffix = '') => fetch(origin + endpoint + suffix, { headers: cookie ? { cookie } : {} })
    const post = (body: object, cookie = admin, requestOrigin = origin) => fetch(origin + endpoint, { method: 'POST', headers: { cookie, origin: requestOrigin, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    expect((await get()).status).toBe(401); expect((await get(member)).status).toBe(403)
    expect(await (await get(admin)).json()).toMatchObject({ revision: 0, isolated: false, defaults: { cpus: null, memoryMiB: null, pids: null } })
    const save = { action: 'save-defaults', revision: 0, limits: { cpus: 0.5, memoryMiB: 512, pids: 64 } }
    expect((await post(save, admin, 'https://another.example.test')).status).toBe(403)
    expect((await post(save, member)).status).toBe(403)
    expect((await post(save)).status).toBe(200)
    expect((await post(save)).status).toBe(409)
    expect((await post({ action: 'apply', revision: 1, confirmed: true, targets: [] })).status).toBe(409)
    expect((await post({ action: 'save-member', revision: 1, username: 'member', spaceId, override: { cpus: null, memoryMiB: null, pids: null } })).status).toBe(200)
    expect(await (await get(admin, '?username=member')).json()).toMatchObject({ revision: 2, source: 'custom', target: { cpus: null, memoryMiB: null, pids: null } })
    await app.stop(); app = createCommunityApplication(config); origin = await app.start()
    expect(await (await get(admin)).json()).toMatchObject({ revision: 2, defaults: save.limits })
  } finally { await app.stop(); await rm(dataRoot, { recursive: true, force: true }) }
})
