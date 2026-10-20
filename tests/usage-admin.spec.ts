import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { createCommunityApplication } from '../src/composition/community-application.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'

it('keeps usage administration private, validates filters and persists retention through a platform restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'usage-admin-'))
  const config = { listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'usage-admin-fixture-session-secret', runtime: { command: '/unavailable-dsh', args: [], dataRoot: root, defaultModel: { provider: 'deepseek-official', model: 'deepseek-chat', upstream: { baseUrl: 'https://api.deepseek.com' } } } }
  let app = createCommunityApplication(config)
  try {
    let origin = await app.start()
    const bootstrap = await fetch(origin + '/bootstrap', { method: 'POST', redirect: 'manual', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ credential: readBootstrapCredential(root)!.credential, username: 'admin', password: 'password' }) })
    const cookie = bootstrap.headers.getSetCookie().map(row => row.split(';')[0]).join('; ')
    const get = (path: string, authenticated = true) => fetch(origin + '/admin/api/' + path, { headers: authenticated ? { cookie } : {} })
    const post = (data: object, requestOrigin = origin) => fetch(origin + '/admin/api/usage-settings', { method: 'POST', headers: { cookie, origin: requestOrigin, 'content-type': 'application/json' }, body: JSON.stringify(data) })
    expect((await get('usage-records', false)).status).toBe(401)
    expect((await get('usage-models', false)).status).toBe(401)
    expect((await get('usage-reported', false)).status).toBe(401)
    expect(await (await get('usage-reported')).json()).toMatchObject({ items: [] })
    for (const suffix of ['?from=1', '?from=86400000&until=0', '?skill=a&skill=b', '?provider=forged']) expect((await get('usage-reported' + suffix)).status).toBe(400)
    expect(await (await get('usage-models')).json()).toMatchObject({ items: [] })
    for (const suffix of ['?from=1', '?from=-3600000', '?from=3600000&until=0', '?from=0&until=3600000&until=7200000', '?unknown=x']) expect((await get('usage-models' + suffix)).status).toBe(400)
    expect(await (await get('usage-records')).json()).toMatchObject({ total: 0, items: [], summaries: { members: [], groups: [], capabilities: [], days: [] } })
    expect(await (await get('usage-settings')).json()).toEqual({ retentionDays: 180 })
    for (const suffix of ['?page=0', '?outcome=unknown', '?from=no', '?from=100&until=0', '?page=1&page=2', '?unknown=x']) expect((await get('usage-records' + suffix)).status).toBe(400)
    expect((await post({ retentionDays: 7 }, 'https://elsewhere.example')).status).toBe(403)
    expect((await post({ retentionDays: 0 })).status).toBe(400)
    expect(await (await post({ retentionDays: 7 })).json()).toEqual({ retentionDays: 7 })
    await app.stop(); app = createCommunityApplication(config); origin = await app.start()
    expect(await (await get('usage-settings')).json()).toEqual({ retentionDays: 7 })
    const member = await fetch(origin + '/admin/api/accounts', { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'member', password: 'password', email: '' }) }); expect(member.status).toBe(201)
    const login = await fetch(origin + '/login', { method: 'POST', redirect: 'manual', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: 'member', password: 'password' }) })
    // The account-management session is valid even when its runtime cannot start.
    const memberCookie = login.headers.getSetCookie().map(row => row.split(';')[0]).join('; ')
    expect((await fetch(origin + '/admin/api/usage-records', { headers: { cookie: memberCookie } })).status).toBe(403)
    expect((await fetch(origin + '/admin/api/usage-models', { headers: { cookie: memberCookie } })).status).toBe(403)
    expect((await fetch(origin + '/admin/api/usage-reported', { headers: { cookie: memberCookie } })).status).toBe(403)
  } finally { await app.stop(); await rm(root, { recursive: true, force: true }) }
})
