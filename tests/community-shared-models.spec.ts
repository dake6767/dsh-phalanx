import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import type { CommunityApplication } from '../src/ports/community-application.js'
import { removeCommunityFixture } from './fixtures/owned-cleanup.js'
import { createCommunityApplication, openTestDatabase } from './support/community-application.js'

let application: CommunityApplication | undefined
let root: string | undefined
afterEach(async () => {
  await application?.stop()
  if (root) await removeCommunityFixture(root)
})
const start = async () => {
  root ??= await mkdtemp(join(tmpdir(), 'shared-models-'))
  application = createCommunityApplication({
    listen: { host: '127.0.0.1', port: 0 },
    sessionSecret: 'shared-model-fixture-secret-with-32-bytes',
    runtime: {
      command: '/unavailable-dsh',
      args: [],
      dataRoot: root,
      defaultModel: { provider: 'deepseek-official', model: 'deepseek-chat', upstream: { baseUrl: 'https://api.deepseek.com' } },
    },
  })
  return await application.start()
}
it('persists administrator provider settings without returning the stored key and rejects stale edits', async () => {
  let origin = await start()
  const bootstrap = await fetch(`${origin}/bootstrap`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ credential: readBootstrapCredential(root!)!.credential, username: 'admin', password: 'password' }),
  })
  const cookie = bootstrap.headers
    .getSetCookie()
    .map(value => value.split(';')[0])
    .join('; ')
  const get = () => fetch(`${origin}/admin/api/models`, { headers: { cookie } })
  expect((await get()).status).toBe(200)
  expect(await (await get()).json()).toEqual({ revision: 0, providers: [], defaultModelId: null })
  const input = {
    revision: 0,
    action: 'save-provider',
    provider: {
      name: 'Custom Messages',
      baseUrl: 'https://models.example.test/custom',
      apiFormat: 'anthropic-messages',
      apiKey: 'private-fixture-key',
      enabled: true,
      models: [{ name: 'shared-chat', enabled: true }],
    },
  }
  const post = (body: unknown, requestOrigin = origin) =>
    fetch(`${origin}/admin/api/models`, {
      method: 'POST',
      headers: { cookie, origin: requestOrigin, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  expect((await post(input, 'https://other.example.test')).status).toBe(403)
  const saved = await post(input)
  expect(saved.status).toBe(200)
  let body = await saved.text()
  expect(body).not.toContain('private-fixture-key')
  expect(JSON.parse(body)).toMatchObject({
    revision: 1,
    providers: [{ name: 'Custom Messages', apiKey: { configured: true, last4: '-key' }, models: [{ name: 'shared-chat', input: 'text' }] }],
  })
  const files = async (directory: string): Promise<string[]> =>
    (
      await Promise.all(
        (await readdir(directory)).map(async name => {
          const path = join(directory, name)
          return (await stat(path)).isDirectory() ? files(path) : [path]
        }),
      )
    ).flat()
  const storedFiles = await files(root!)
  expect(storedFiles).not.toContain(join(root!, 'shared-models.json'))
  expect(storedFiles).not.toContain(join(root!, 'model-access.json'))
  for (const path of storedFiles) expect((await readFile(path)).includes(Buffer.from(input.provider.apiKey))).toBe(false)
  const database = await openTestDatabase(root!)
  try {
    const rows = await database.query('SELECT * FROM dsh_phalanx.shared_model_providers')
    expect(rows).toHaveLength(1)
    expect(JSON.stringify(rows)).not.toContain(input.provider.apiKey)
    expect(await database.query('SELECT * FROM dsh_phalanx.session_signing_key')).toHaveLength(1)
  } finally {
    await database.close()
  }
  const conflict = await post(input)
  expect(conflict.status).toBe(409)
  expect(await conflict.json()).toEqual({
    error: 'Model settings changed. Reload before saving.',
    code: 'model-revision-conflict',
    params: { expectedRevision: 1, receivedRevision: 0 },
  })
  const provider = JSON.parse(body).providers[0] as { id: string; models: unknown[] }
  const edit = { ...input.provider, id: provider.id, models: provider.models, apiKey: '' }
  const preserved = await post({ revision: 1, action: 'save-provider', provider: edit })
  expect(preserved.status).toBe(200)
  expect(await preserved.json()).toMatchObject({ revision: 2, providers: [{ apiKey: { configured: true, last4: '-key' } }] })
  const check = await openTestDatabase(root!)
  try {
    const [row] = await check.query<{ api_key: import('../src/domain/platform-secret.js').PlatformSecretEnvelope }>(
      'SELECT api_key FROM dsh_phalanx.shared_model_providers WHERE id=$1',
      [provider.id],
    )
    expect(check.cipher().decrypt({ table: 'shared_model_providers', recordId: provider.id, field: 'api_key' }, row!.api_key) === input.provider.apiKey).toBe(
      true,
    )
  } finally {
    await check.close()
  }
  const replacement = 'replacement-fixture-credential'
  const replaced = await post({ revision: 2, action: 'save-provider', provider: { ...edit, apiKey: replacement } })
  expect(replaced.status).toBe(200)
  body = await replaced.text()
  expect(body).not.toContain(replacement)
  expect(JSON.parse(body)).toMatchObject({ revision: 3, providers: [{ apiKey: { configured: true, last4: 'tial' } }] })
  for (const path of await files(root!)) expect((await readFile(path)).includes(Buffer.from(replacement))).toBe(false)
  await application!.stop()
  origin = await start()
  expect(await (await get()).json()).toEqual(JSON.parse(body))
})
