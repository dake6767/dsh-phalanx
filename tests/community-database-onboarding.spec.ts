import { PlatformDatabase } from '../src/adapters/platform-database.js'
import { createBootstrapLink } from '../src/adapters/community-bootstrap.js'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import { expect, it } from 'vitest'
import { createCommunityApplication } from '../src/composition/community-application.js'
import { FilePlatformDatabaseConfig } from '../src/adapters/platform-database-config.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { postgresConnection } from './support/postgres.js'
import { testDatabaseConfigFile } from './support/community-application.js'

it('listens for first-install authorization without writing any platform business records', async () => {
  const root = mkdtempSync(join(tmpdir(), 'community-database-onboarding-')),
    path = testDatabaseConfigFile(root)
  const saved = FilePlatformDatabaseConfig.open(path, root),
    observer = new Pool({ ...saved.connection, user: saved.connection.username })
  const application = createCommunityApplication({
    platformDatabaseConfigFile: path,
    listen: { host: '127.0.0.1', port: 0 },
    runtime: {
      command: '/unavailable-dsh',
      args: [],
      dataRoot: root,
      defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'http://127.0.0.1:1' } },
    },
  })
  try {
    const origin = await application.start()
    expect((await observer.query("SELECT to_regnamespace('dsh_phalanx') AS schema")).rows).toEqual([{ schema: null }])
    expect((await fetch(origin + '/bootstrap')).status).toBe(200)
    expect((await fetch(origin + '/login')).status).toBe(200)
    expect((await fetch(origin + '/readyz')).status).toBe(503)
    expect(readBootstrapCredential(root)).toBeDefined()
    const credential = readBootstrapCredential(root)!.credential
    const authorize = (value: string) =>
      fetch(origin + '/bootstrap', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', origin },
        body: new URLSearchParams({ action: 'database-authorize', credential: value }),
      })
    const refused = await authorize('fictional-invalid-invitation')
    expect(refused.status).toBe(403)
    expect(await refused.text()).not.toContain('databaseHost')
    const allowed = await authorize(credential)
    expect(allowed.status).toBe(200)
    const view = (await allowed.json()) as { html: string }
    expect(view.html).toContain('name="databaseHost"')
    expect(view.html).not.toContain(credential)
    expect((await observer.query("SELECT to_regnamespace('dsh_phalanx') AS schema")).rows).toEqual([{ schema: null }])

    const created = await fetch(origin + '/bootstrap', {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin },
      body: new URLSearchParams({ credential, username: 'admin', password: 'fictional-admin-password' }),
    })

    expect(created.status).toBe(303)
    expect(created.headers.get('location')).toBe('/admin')
    expect(FilePlatformDatabaseConfig.open(path, root).selection).toBe('builtin')
    expect((await fetch(origin + '/readyz')).status).toBe(200)
    const cookie = created.headers
      .getSetCookie()
      .map(value => value.split(';')[0])
      .join('; ')
    expect(await (await fetch(origin + '/admin/api/session', { headers: { cookie } })).json()).toMatchObject({ username: 'admin', admin: true })
  } finally {
    await application.stop()
    await observer.end()
    rmSync(root, { recursive: true, force: true })
  }
})

it('tests an external target without writes, then activates every platform owner on that selection', async () => {
  const root = mkdtempSync(join(tmpdir(), 'community-external-onboarding-')),
    path = testDatabaseConfigFile(root)
  const builtin = FilePlatformDatabaseConfig.open(path, root).connection,
    external = postgresConnection()
  const observers = [builtin, external].map(connection => new Pool({ ...connection, user: connection.username }))
  const application = createCommunityApplication({
    platformDatabaseConfigFile: path,
    listen: { host: '127.0.0.1', port: 0 },
    runtime: {
      command: '/unavailable-dsh',
      args: [],
      dataRoot: root,
      defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'http://127.0.0.1:1' } },
    },
  })
  try {
    const origin = await application.start(),
      credential = readBootstrapCredential(root)!.credential
    const input = {
      credential,
      databaseKind: 'external',
      databaseHost: external.host,
      databasePort: String(external.port),
      databaseName: external.database,
      databaseUsername: external.username,
      databasePassword: external.password,
      databaseTls: external.tls,
    }
    const post = (action: string) =>
      fetch(origin + '/bootstrap', {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded', origin },
        body: new URLSearchParams({ ...input, action }),
      })
    const tested = await post('database-test')
    expect(tested.status).toBe(200)
    expect(await tested.json()).toMatchObject({
      ok: true,
      checks: [
        { stage: 'connection', passed: true },
        { stage: 'version', passed: true },
        { stage: 'owner', passed: true },
        { stage: 'schema', passed: true },
      ],
    })
    for (const observer of observers) expect((await observer.query("SELECT to_regnamespace('dsh_phalanx') AS schema")).rows).toEqual([{ schema: null }])
    const selected = await post('database-select')
    expect(selected.status).toBe(200)
    expect(((await selected.json()) as { html: string }).html).toContain('name="username"')
    expect(FilePlatformDatabaseConfig.open(path, root)).toMatchObject({ selection: 'external', connection: external })
    const created = await fetch(origin + '/bootstrap', {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin },
      body: new URLSearchParams({ credential, username: 'admin', password: 'fictional-admin-password' }),
    })
    expect(created.status).toBe(303)
    const cookie = created.headers
      .getSetCookie()
      .map(value => value.split(';')[0])
      .join('; ')
    const model = await fetch(origin + '/admin/api/models', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin, cookie },
      body: JSON.stringify({
        revision: 0,
        action: 'save-provider',
        provider: {
          name: 'External fixture',
          baseUrl: 'https://models.example.test/anthropic',
          apiFormat: 'anthropic-messages',
          apiKey: 'fictional-external-provider-value',
          enabled: true,
          models: [{ name: 'fixture', enabled: true }],
        },
      }),
    })
    expect(model.status).toBe(200)
    expect((await observers[0]!.query("SELECT to_regnamespace('dsh_phalanx') AS schema")).rows).toEqual([{ schema: null }])
    expect((await observers[1]!.query('SELECT count(*)::integer AS count FROM dsh_phalanx.accounts')).rows).toEqual([{ count: 1 }])
    expect((await observers[1]!.query('SELECT count(*)::integer AS count FROM dsh_phalanx.shared_model_providers')).rows).toEqual([{ count: 1 }])
  } finally {
    await application.stop()
    await Promise.all(observers.map(pool => pool.end()))
    rmSync(root, { recursive: true, force: true })
  }
})

it.each(['durable', 'legacy'])('refuses an initialization invitation over retained default user files (%s)', async layout => {
  const directory = mkdtempSync(join(tmpdir(), 'bootstrap-retained-default-')),
    root = join(directory, 'data')
  mkdirSync(root, { mode: 0o700 })
  const home = layout === 'durable' ? join(directory, 'data.durable/users/member/home') : join(root, 'users/member/home')
  mkdirSync(home, { recursive: true, mode: 0o700 })
  writeFileSync(join(home, 'retained.txt'), 'KEEP_PRIVATE_USER_FILE', { mode: 0o600 })
  const path = testDatabaseConfigFile(root),
    connection = FilePlatformDatabaseConfig.open(path, root).connection,
    observer = new Pool({ ...connection, user: connection.username })
  const application = createCommunityApplication({
    platformDatabaseConfigFile: path,
    listen: { host: '127.0.0.1', port: 0 },
    runtime: {
      command: '/unavailable-dsh',
      args: [],
      dataRoot: root,
      defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'http://127.0.0.1:1' } },
    },
  })
  try {
    await expect(application.start()).rejects.toThrow('existing account data is not migrated')

    await expect(createBootstrapLink(root, new URL('https://platform.example.test'), false, path)).rejects.toThrow('existing account data is not migrated')
    expect(readBootstrapCredential(root)).toBeUndefined()
    expect((await observer.query("SELECT to_regnamespace('dsh_phalanx') AS schema")).rows).toEqual([{ schema: null }])
    expect(readFileSync(join(home, 'retained.txt'), 'utf8')).toBe('KEEP_PRIVATE_USER_FILE')
  } finally {
    await application.stop()
    await observer.end()
    rmSync(directory, { recursive: true, force: true })
  }
})

it('prints the outstanding initialization link without initializing any business storage', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bootstrap-link-readonly-')),
    path = testDatabaseConfigFile(root)
  const connection = FilePlatformDatabaseConfig.open(path, root).connection,
    observer = new Pool({ ...connection, user: connection.username })
  try {
    const first = await createBootstrapLink(root, new URL('https://platform.example.test'), false, path)
    expect(new URL(first).pathname).toBe('/bootstrap')
    expect(new URLSearchParams(new URL(first).hash.slice(1)).get('credential')).toBe(readBootstrapCredential(root)!.credential)
    expect(await createBootstrapLink(root, new URL('https://platform.example.test'), false, path)).toBe(first)
    expect((await observer.query("SELECT to_regnamespace('dsh_phalanx') AS schema")).rows).toEqual([{ schema: null }])
  } finally {
    await observer.end()
    rmSync(root, { recursive: true, force: true })
  }
})

it('closes a failed activation and starts a fresh graph on the persisted external target after contention clears', async () => {
  const root = mkdtempSync(join(tmpdir(), 'onboarding-activation-recovery-')),
    path = testDatabaseConfigFile(root)
  const saved = FilePlatformDatabaseConfig.open(path, root),
    external = postgresConnection()
  const holder = new PlatformDatabase(external, saved.security)
  const config = {
    platformDatabaseConfigFile: path,
    listen: { host: '127.0.0.1', port: 0 },
    runtime: {
      command: '/unavailable-dsh',
      args: [],
      dataRoot: root,
      defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'http://127.0.0.1:1' } },
    },
  }
  let application = createCommunityApplication(config)
  try {
    await holder.claimDeployment('fixture-contending-instance', () => {})
    const stopped = new Promise<void>(resolve => {
      application.onFailure!(resolve)
    })
    const origin = await application.start(),
      credential = readBootstrapCredential(root)!.credential
    const selected = await fetch(origin + '/bootstrap', {
      method: 'POST',
      headers: { origin, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        credential,
        action: 'database-select',
        databaseKind: 'external',
        databaseHost: external.host,
        databasePort: String(external.port),
        databaseName: external.database,
        databaseUsername: external.username,
        databasePassword: external.password,
        databaseTls: external.tls,
      }),
    })
    expect(selected.status).toBe(503)
    expect(await selected.json()).toMatchObject({ code: 'platform-database-unavailable' })
    await stopped
    expect(FilePlatformDatabaseConfig.open(path, root)).toMatchObject({ selection: 'external', connection: external })
    expect(readBootstrapCredential(root)!.credential).toBe(credential)
    await holder.close()
    application = createCommunityApplication(config)
    const resumed = await application.start()
    const created = await fetch(resumed + '/bootstrap', {
      method: 'POST',
      redirect: 'manual',
      headers: { origin: resumed, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ credential, username: 'admin', password: 'fictional-admin-password' }),
    })
    expect(created.status).toBe(303)
    expect(FilePlatformDatabaseConfig.open(path, root)).toMatchObject({ selection: 'external', connection: external })
  } finally {
    await application.stop()
    await holder.close()
    rmSync(root, { recursive: true, force: true })
  }
})
