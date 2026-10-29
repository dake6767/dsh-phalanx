import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { loadCommunityConfig } from '../src/adapters/community-env-config.js'
import { PostgresSessionKey } from '../src/adapters/postgres-session-key.js'
import { createCommunityApplication } from '../src/composition/community-application.js'
import { PlatformSessionCodec } from '../src/inbound/platform-session.js'
import { removeCommunityFixture } from './fixtures/owned-cleanup.js'
import { openTestDatabase, testDatabaseConfigFile } from './support/community-application.js'

it('boots the production application with a generated PG key and retains its login after restart without legacy secret configuration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'production-secret-startup-'))
  const config = loadCommunityConfig({
    DSH_PHALANX_DATABASE_CONFIG_FILE: testDatabaseConfigFile(root),
    DSH_PHALANX_SESSION_SECRET: 'fictional-obsolete-session-secret-32-bytes',
    DSH_PHALANX_MODEL_UPSTREAM_API_KEY: 'fictional-obsolete-provider-key',
    DSH_PHALANX_RUNTIME_COMMAND: '/unavailable-dsh',
    DSH_PHALANX_RUNTIME_ARGS_JSON: '[]',
    DSH_PHALANX_DATA_ROOT: root,
    DSH_PHALANX_HOST: '127.0.0.1',
    DSH_PHALANX_PORT: '0',
    DSH_PHALANX_ALLOWED_MODEL_PROVIDER: 'deepseek-official',
    DSH_PHALANX_ALLOWED_MODEL: 'fixture',
    DSH_PHALANX_MODEL_UPSTREAM_BASE_URL: 'https://example.test',
  })
  let application = createCommunityApplication(config)
  try {
    let origin = await application.start()
    const bootstrap = await fetch(origin + '/bootstrap', {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ credential: readBootstrapCredential(root)!.credential, username: 'admin', password: 'password' }),
    })
    expect(bootstrap.status).toBe(303)
    const cookie = bootstrap.headers
      .getSetCookie()
      .map(value => value.split(';')[0])
      .join('; ')
    const bearer = /(?:^|; )dsh-phalanx_session=([^;]+)/u.exec(cookie)![1]!
    const database = await openTestDatabase(root),
      key = new PostgresSessionKey(database)
    try {
      await key.initialize()
      expect(key.read() === 'fictional-obsolete-session-secret-32-bytes').toBe(false)
      expect(new PlatformSessionCodec(key).verify(bearer)).toMatchObject({ userId: 'admin' })
      expect(new PlatformSessionCodec('fictional-obsolete-session-secret-32-bytes').verify(bearer)).toBeUndefined()
    } finally {
      await key.close()
      await database.close()
    }
    const read = () => fetch(origin + '/admin/api/models', { headers: { cookie } })
    expect(await (await read()).json()).toEqual({ revision: 0, providers: [], defaultModelId: null })
    expect(await readdir(root)).not.toContain('shared-models.json')
    expect(await readdir(root)).not.toContain('model-access.json')
    await application.stop()
    application = createCommunityApplication(config)
    origin = await application.start()
    expect((await read()).status).toBe(200)
  } finally {
    await application.stop()
    await removeCommunityFixture(root)
  }
})
