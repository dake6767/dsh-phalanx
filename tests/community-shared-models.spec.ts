import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createCommunityApplication } from '../src/composition/community-application.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import type { CommunityApplication } from '../src/ports/community-application.js'

let application: CommunityApplication | undefined
let root: string | undefined
afterEach(async () => { await application?.stop(); if (root) await rm(root, { recursive: true, force: true }) })
const start = async () => {
  root ??= await mkdtemp(join(tmpdir(), 'shared-models-'))
  application = createCommunityApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'shared-model-fixture-secret-with-32-bytes',
    runtime: { command: '/unavailable-dsh', args: [], dataRoot: root,
      defaultModel: { provider: 'deepseek-official', model: 'deepseek-chat', upstream: { baseUrl: 'https://api.deepseek.com' } } } })
  return await application.start()
}
it('persists administrator provider settings without returning the stored key and rejects stale edits', async () => {
  let origin = await start()
  const bootstrap = await fetch(`${origin}/bootstrap`, { method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ credential: readBootstrapCredential(root!)!.credential, username: 'admin', password: 'password' }) })
  const cookie = bootstrap.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  const get = () => fetch(`${origin}/admin/api/models`, { headers: { cookie } })
  expect((await get()).status).toBe(200)
  expect(await (await get()).json()).toEqual({ revision: 0, providers: [], defaultModelId: null })
  const input = { revision: 0, action: 'save-provider', provider: { name: 'Custom Messages', baseUrl: 'https://models.example.test/custom',
    apiFormat: 'anthropic-messages', apiKey: 'private-fixture-key', enabled: true, models: [{ name: 'shared-chat', enabled: true }] } }
  const post = (body: unknown, requestOrigin = origin) => fetch(`${origin}/admin/api/models`, { method: 'POST',
    headers: { cookie, origin: requestOrigin, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  expect((await post(input, 'https://other.example.test')).status).toBe(403)
  const saved = await post(input)
  expect(saved.status).toBe(200)
  const body = await saved.text()
  expect(body).not.toContain('private-fixture-key')
  expect(JSON.parse(body)).toMatchObject({ revision: 1, providers: [{ name: 'Custom Messages', hasApiKey: true, models: [{ name: 'shared-chat' }] }] })
  const conflict = await post(input)
  expect(conflict.status).toBe(409)
  expect(await conflict.json()).toEqual({ error: 'Model settings changed. Reload before saving.', code: 'model-revision-conflict', params: { expectedRevision: 1, receivedRevision: 0 } })
  await application!.stop(); origin = await start()
  expect(await (await get()).text()).toBe(body)
})
