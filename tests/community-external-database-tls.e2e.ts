// Validation: T2; real credentials: none; installed Linux platform and a separate rootless TLS PostgreSQL server.
import { assertInstalledExternalUpgrade } from './support/installed-external-upgrade.js'
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
import { chromium, type Browser } from 'playwright'
import { expect, it } from 'vitest'
import { postgresConnection } from './support/postgres.js'
import { startTlsPostgres } from './support/tls-postgres.js'
import { startPlatformCli } from './support/platform-cli.js'
import { loopbackPort } from '../src/adapters/loopback-port.js'

it('installs, upgrades and restores registered schemas on external TLS PostgreSQL while retaining sign-in and shared models', async () => {
  const installed = process.env.DSH_PHALANX_INSTALL_ROOT
  if (!installed || process.platform !== 'linux') throw Error('External database acceptance requires the installed Linux artifact')
  const image = process.env.DSH_PHALANX_CONTAINER_IMAGE
  if (!image) throw Error('Installed acceptance requires the pinned container image')
  const identity = JSON.parse(readFileSync(join(installed, 'build-info.json'), 'utf8')) as { commit: string; platform: string }
  expect(identity.commit).toBe(process.env.DSH_PHALANX_CANDIDATE_SHA)
  expect(identity.platform).toBe('linux/' + (process.arch === 'arm64' ? 'arm64' : 'amd64'))
  const load = (module: string) => import(pathToFileURL(join(installed, 'dist', module + '.js')).href)
  const { FilePlatformDatabaseConfig: Saved } = (await load(
    'adapters/platform-database-config',
  )) as typeof import('../src/adapters/platform-database-config.js')
  const { readBootstrapCredential } = (await load('adapters/bootstrap-credential')) as typeof import('../src/adapters/bootstrap-credential.js')
  const { PlatformDatabase } = (await load('adapters/platform-database')) as typeof import('../src/adapters/platform-database.js')
  const { PostgresCommunityModelAccess } = (await load(
    'adapters/postgres-community-model-access',
  )) as typeof import('../src/adapters/postgres-community-model-access.js')
  const { platformDatabasePool } = (await load('adapters/platform-database-inspection')) as typeof import('../src/adapters/platform-database-inspection.js')
  const root = mkdtempSync(join(tmpdir(), 'external-database-installed-')),
    data = join(root, 'data'),
    path = join(root, 'database.json')
  mkdirSync(data, { mode: 0o700 })
  const builtin = postgresConnection()
  Saved.create(path, join(root, 'master.key'), builtin)
  const fingerprint = Saved.open(path, data).security.registry.masterFingerprint
  copyFileSync(path, join(root, 'builtin-database.json'))
  let upstreamPath: string | undefined, upstreamKey: string | string[] | undefined
  const upstream = createServer((request, response) => {
    upstreamPath = request.url
    upstreamKey = request.headers['x-api-key']
    response.setHeader('content-type', 'application/json')
    response.end('{"content":[{"type":"text","text":"external TLS model response"}],"usage":{"input_tokens":1,"output_tokens":2}}')
  })
  let app: Awaited<ReturnType<typeof startPlatformCli>> | undefined
  let browser: Browser | undefined
  let external: Awaited<ReturnType<typeof startTlsPostgres>> | undefined
  const base = process.env.DSH_PHALANX_E2E_PORT_BASE
  const port = base === undefined ? await loopbackPort() : Number(base),
    gateway = base === undefined ? await loopbackPort() : Number(base) + 1
  const environment = {
    DSH_PHALANX_DATA_ROOT: data,
    DSH_PHALANX_DATABASE_CONFIG_FILE: path,
    DSH_PHALANX_HOST: '127.0.0.1',
    DSH_PHALANX_PORT: String(port),
    DSH_PHALANX_CONTAINER_GATEWAY_PORT: String(gateway),
    DSH_PHALANX_CONTAINER_IMAGE: image,
    DSH_PHALANX_RUNTIME_COMMAND: '/unavailable-dsh',
    DSH_PHALANX_RUNTIME_ARGS_JSON: '[]',
    DSH_PHALANX_ALLOWED_MODEL_PROVIDER: 'deepseek-official',
    DSH_PHALANX_ALLOWED_MODEL: 'fixture',
    DSH_PHALANX_MODEL_UPSTREAM_BASE_URL: 'http://127.0.0.1:1',
  }
  try {
    external = await startTlsPostgres()
    await new Promise<void>(resolve => upstream.listen(base === undefined ? 0 : Number(base) + 2, '127.0.0.1', resolve))
    const address = upstream.address()
    if (!address || typeof address === 'string') throw Error('No upstream listener')
    app = await startPlatformCli(join(installed, 'start'), [], environment)
    const origin = app.origin,
      credential = readBootstrapCredential(data)!.credential
    const fields = {
      credential,
      databaseKind: 'external',
      databaseHost: external.connection.host,
      databasePort: String(external.connection.port),
      databaseName: external.connection.database,
      databaseUsername: external.connection.username,
      databasePassword: external.connection.password,
      databaseTls: 'require',
    }
    const post = (body: Record<string, string>, cookie = '') =>
      fetch(origin + '/bootstrap', {
        method: 'POST',
        redirect: 'manual',
        headers: { origin, cookie, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(body),
      })
    const authorized = await post({ credential, action: 'database-authorize' })
    expect(authorized.status).toBe(200)
    const verified = await post({ ...fields, action: 'database-test', databaseTls: 'verify-full', databaseCa: external.ca })
    expect(await verified.json()).toMatchObject({ ok: true })
    const tested = await post({ ...fields, action: 'database-test' })
    expect(await tested.json()).toMatchObject({ ok: true })
    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({ locale: 'en' }),
      page = await context.newPage()
    page.setDefaultTimeout(10_000)
    await page.goto(origin + '/bootstrap#credential=' + credential)
    await page.getByLabel('Platform database', { exact: true }).selectOption('external')
    for (const [label, value] of [
      ['Database host', fields.databaseHost],
      ['Database port', fields.databasePort],
      ['Database name', fields.databaseName],
      ['Database username', fields.databaseUsername],
      ['Database password', fields.databasePassword],
    ]) {
      await page.getByLabel(label!, { exact: true }).fill(value!)
    }
    await page.getByLabel('TLS mode', { exact: true }).selectOption('verify-full')
    await page
      .getByLabel('Upload CA certificate', { exact: true })
      .setInputFiles({ name: 'fixture-ca.pem', mimeType: 'application/x-pem-file', buffer: Buffer.from(external.ca) })
    await expect.poll(() => page.getByLabel('CA certificate (PEM)', { exact: true }).inputValue()).toBe(external.ca)
    const successful = page.getByRole('status').filter({ hasText: 'Empty or matching platform schema: Passed' })
    await page.getByRole('button', { name: 'Test connection', exact: true }).click()
    await successful.waitFor()
    await page.getByLabel('TLS mode', { exact: true }).selectOption('require')
    expect(await page.getByRole('button', { name: 'Continue', exact: true }).isDisabled()).toBe(true)
    await page.getByRole('button', { name: 'Test connection', exact: true }).click()
    await successful.waitFor()
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
    await page.getByRole('button', { name: 'Create administrator', exact: true }).waitFor()
    const created = await post({ credential, username: 'admin', password: 'fixture-admin-password' })
    expect(created.status).toBe(303)
    const cookie = created.headers
      .getSetCookie()
      .map(value => value.split(';')[0])
      .join('; ')
    const model = await fetch(origin + '/admin/api/models', {
      method: 'POST',
      headers: { origin, cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        revision: 0,
        action: 'save-provider',
        provider: {
          name: 'TLS external',
          baseUrl: `http://127.0.0.1:${address.port}/anthropic`,
          apiFormat: 'anthropic-messages',
          apiKey: 'fixture-external-shared-provider',
          enabled: true,
          models: [{ name: 'fixture', enabled: true }],
        },
      }),
    })
    expect(model.status).toBe(200)
    const models = (await model.json()) as { providers: { models: { id: string }[] }[] }
    const modelId = models.providers[0]!.models[0]!.id
    const saved = Saved.open(path, data)
    expect(saved.selection).toBe('external')
    expect(saved.connection.tls).toBe('require')
    expect(saved.security.registry.masterFingerprint).toBe(fingerprint)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(readFileSync(path, 'utf8')).not.toContain(external.connection.password)
    const observer = platformDatabasePool(saved.connection),
      builtinObserver = platformDatabasePool(builtin)
    try {
      expect((await observer.query('SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()')).rows).toEqual([{ ssl: true }])
      const connections = (
        await observer.query<{ encrypted: boolean; sessions: number }>(
          'SELECT bool_and(s.ssl) AS encrypted,count(*)::integer AS sessions FROM pg_stat_activity a JOIN pg_stat_ssl s USING(pid) WHERE a.client_addr IS NOT NULL',
        )
      ).rows[0]!
      expect(connections.encrypted).toBe(true)
      expect(connections.sessions).toBeGreaterThanOrEqual(2)
      expect((await observer.query('SELECT count(*)::integer AS count FROM dsh_phalanx.accounts')).rows).toEqual([{ count: 1 }])
      expect((await observer.query('SELECT count(*)::integer AS count FROM dsh_phalanx.session_signing_key')).rows).toEqual([{ count: 1 }])
      expect((await builtinObserver.query("SELECT to_regnamespace('dsh_phalanx') AS schema")).rows).toEqual([{ schema: null }])
    } finally {
      await observer.end()
      await builtinObserver.end()
    }
    // An independent operator creates a real token; a fresh production graph loads it.
    await app.stop()
    app = undefined
    const database = new PlatformDatabase(saved.connection, saved.security),
      access = new PostgresCommunityModelAccess(database)
    let token: string
    try {
      await database.initialize()
      await access.initialize()
      const [account] = await database.query<{ space_id: string }>('SELECT space_id FROM dsh_phalanx.accounts WHERE username=$1', ['admin'])
      token = await access.forUser('admin', account!.space_id)
    } finally {
      await access.close()
      await database.close()
    }
    app = await startPlatformCli(join(installed, 'start'), [], environment)
    const login = await fetch(app.origin + '/login', {
      method: 'POST',
      redirect: 'manual',
      headers: { origin: app.origin, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'admin', password: 'fixture-admin-password' }),
    })
    expect(login.status).toBe(303)
    const response = await fetch(`http://127.0.0.1:${gateway}/_dsh-phalanx/model/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': token, 'content-type': 'application/json' },
      body: JSON.stringify({ model: modelId, messages: [{ role: 'user', content: 'hello' }], max_tokens: 8 }),
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('external TLS model response')
    expect(upstreamPath).toBe('/anthropic/v1/messages')
    expect(upstreamKey).toBe('fixture-external-shared-provider')
    const usage = platformDatabasePool(saved.connection)
    try {
      await expect
        .poll(async () => Number((await usage.query('SELECT coalesce(sum(requests),0) AS count FROM dsh_phalanx.usage_model_hours')).rows[0]!.count))
        .toBe(1)
    } finally {
      await usage.end()
    }
    await app.stop()
    app = undefined
    await assertInstalledExternalUpgrade(installed, root, path, data)
    app = await startPlatformCli(join(installed, 'start'), [], environment)
    expect((await fetch(app.origin + '/admin/api/session', { headers: { cookie } })).status).toBe(200)
    // The same installed CLI transfers every table, preserves the member session/token,
    // and rewraps the selected TLS database plus the retained built-in database.
    const operation = async (command: string, target?: 'builtin' | 'external') => {
      await app!.stop()
      app = undefined
      const input = join(root, 'database-target.json')
      if (target === 'external') writeFileSync(input, JSON.stringify(external!.connection), { mode: 0o600 })
      const result = await promisify(execFile)(
        join(installed, 'start'),
        [
          command,
          '--config-file',
          path,
          '--data-root',
          data,
          '--maintenance-file',
          join(root, 'maintenance'),
          '--offline',
          ...(target ? ['--target', target] : []),
          ...(target === 'external' ? ['--connection-file', input] : []),
        ],
        { env: { ...process.env, ...environment } },
      )
      app = await startPlatformCli(join(installed, 'start'), [], environment)
      expect((await fetch(app.origin + '/admin/api/session', { headers: { cookie } })).status).toBe(200)
      const called = await fetch(`http://127.0.0.1:${gateway}/_dsh-phalanx/model/v1/messages`, {
        method: 'POST',
        headers: { 'x-api-key': token, 'content-type': 'application/json' },
        body: JSON.stringify({ model: modelId, messages: [{ role: 'user', content: 'hello again' }], max_tokens: 8 }),
      })
      expect(called.status).toBe(200)
      expect(await called.text()).toContain('external TLS model response')
      return JSON.parse(result.stdout) as { status: string; fingerprint: string }
    }
    expect(await operation('database-switch', 'builtin')).toMatchObject({ status: 'switched' })
    expect(Saved.open(path, data).selection).toBe('builtin')
    expect(await operation('database-switch', 'external')).toMatchObject({ status: 'switched' })
    expect(Saved.open(path, data)).toMatchObject({ selection: 'external', connection: { tls: 'require' } })
    const rotation = await operation('master-key-rotate')
    expect(rotation.status).toBe('rotated')
    expect(rotation.fingerprint).not.toBe(fingerprint)
    expect(Saved.open(join(root, 'builtin-database.json'), data).security.registry.masterFingerprint).toBe(rotation.fingerprint)
  } finally {
    try {
      await browser?.close()
    } finally {
      try {
        await app?.stop()
      } finally {
        try {
          upstream.closeAllConnections()
          await new Promise<void>(resolve => upstream.close(() => resolve()))
        } finally {
          try {
            external?.stop()
          } finally {
            rmSync(root, { recursive: true, force: true })
          }
        }
      }
    }
  }
})
