import { removeCommunityFixture } from './fixtures/owned-cleanup.js'
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { createCommunityApplication, openTestDatabase } from './support/community-application.js'
import { withPluginFacts } from './support/plugin-facts.js'

it('saves and reopens write-only upstream settings through the application without creating a JSON backend', async () => {
  const root = await mkdtemp(join(tmpdir(), 'upstream-application-'))
  await withPluginFacts(root, async ({ library }) =>
    library.save({ packageName: 'plugin', version: '1.0.0', current: null, stage: 'failed', published: false }),
  )
  const make = () =>
    createCommunityApplication({
      listen: { host: '127.0.0.1', port: 0 },
      runtime: {
        command: '/unavailable-dsh',
        args: [],
        dataRoot: root,
        defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'https://example.test' } },
      },
    })
  let application = make()
  try {
    let origin = await application.start()
    const bootstrap = await fetch(origin + '/bootstrap', {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ credential: readBootstrapCredential(root)!.credential, username: 'admin', password: 'password' }),
    })
    const cookie = bootstrap.headers
      .getSetCookie()
      .map(value => value.split(';')[0])
      .join('; ')
    const path = '/admin/api/plugins/upstreams?packageName=plugin'
    const upstream = {
      name: 'search',
      baseUrl: 'https://upstream.example.test',
      credential: 'fictional-upstream-private-key',
      headers: [
        { name: 'Authorization', value: 'Bearer {credential}' },
        { name: 'X-Private', value: 'fictional-locked-header-value' },
      ],
    }
    const response = await fetch(origin + path, {
      method: 'POST',
      headers: { cookie, origin, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'save', upstream }),
    })
    expect(response.status).toBe(200)
    const body = await response.text()
    for (const secret of [upstream.credential, ...upstream.headers.map(row => row.value)]) expect(body).not.toContain(secret)
    expect(JSON.parse(body)).toMatchObject([
      { credential: { configured: true, last4: '-key' }, headers: [{ configured: true }, { configured: true, last4: 'alue' }] },
    ])
    expect(await readdir(root)).not.toContain('plugin-upstreams.json')
    const database = await openTestDatabase(root)
    try {
      const rows = JSON.stringify(await database.query('SELECT * FROM dsh_phalanx.plugin_upstreams'))
      for (const secret of [upstream.credential, upstream.headers[1]!.value]) expect(rows).not.toContain(secret)
    } finally {
      await database.close()
    }
    await application.stop()
    application = make()
    origin = await application.start()
    expect(await (await fetch(origin + path, { headers: { cookie } })).json()).toEqual(JSON.parse(body))
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name)
        if (entry.isDirectory()) await visit(path)
        else if (entry.isFile()) {
          const bytes = await readFile(path)
          for (const secret of [upstream.credential, upstream.headers[1]!.value]) expect(bytes.includes(Buffer.from(secret))).toBe(false)
        }
      }
    }
    await visit(root)
  } finally {
    await application.stop()
    await removeCommunityFixture(root)
  }
})
