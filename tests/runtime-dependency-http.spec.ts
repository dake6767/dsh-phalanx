import { chmod, lstat, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createCommunityApplication } from '../src/composition/community-application.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'

it('creates, inspects, retries and deletes dependencies through the administrator public entry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dependency-http-'))
  const app = createCommunityApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'runtime-dependency-fixture-secret-32', runtime: { command: '/unavailable', args: [], dataRoot: root, defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'https://example.test' } } } })
  try {
    const origin = await app.start(), endpoint = origin + '/admin/api/runtime-dependencies'
    const bootstrap = await fetch(origin + '/bootstrap', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ credential: readBootstrapCredential(root)!.credential, username: 'admin', password: 'password' }) })
    const cookie = bootstrap.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    const post = (body: unknown, requestOrigin = origin) => fetch(endpoint, { method: 'POST', headers: { cookie, origin: requestOrigin, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const get = async () => (await fetch(endpoint + '?name=example', { headers: { cookie } })).json()
    expect((await fetch(endpoint)).status).toBe(401)
    expect((await post({ action: 'create' }, 'https://other.example.test')).status).toBe(403)
    const input = { name: 'example', prepareCommand: 'mkdir bin; printf "#!/bin/sh\\necho ready\\n" > bin/example; chmod +x bin/example', pathDirectories: ['bin'], checkCommand: 'example' }
    expect((await post({ action: 'create', input: { ...input, env: { KEY: 'never-store' } } })).status).toBe(400)
    expect((await post({ action: 'create', input })).status).toBe(202)
    await expect.poll(async () => (await get()).stage).toBe('ready')
    const first = await get(); expect(first).toMatchObject({ name: 'example', current: { commands: ['example'] } })
    expect(JSON.stringify(first)).not.toContain(root)
    expect((await post({ action: 'create', input })).status).toBe(409)
    expect((await post({ action: 'prepare', name: 'example' })).status).toBe(202)
    await expect.poll(async () => { const row = await get(); return row.stage === 'ready' && row.current.id !== first.current.id }).toBe(true)
    expect((await post({ action: 'remove', name: 'example' })).status).toBe(200)
    expect(await (await fetch(endpoint, { headers: { cookie } })).json()).toEqual([])
  } finally { await app.stop(); const writable = async (path: string): Promise<void> => { if ((await lstat(path)).isDirectory()) { await chmod(path, 0o700); for (const name of await readdir(path)) await writable(join(path, name)) } }; await writable(root); await rm(root, { recursive: true, force: true }) }
})
