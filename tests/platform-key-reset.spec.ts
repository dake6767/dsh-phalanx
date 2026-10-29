import { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { FilePlatformDatabaseConfig } from '../src/adapters/platform-database-config.js'
import { PostgresContributionSetups } from '../src/adapters/postgres-contribution-setups.js'
import { PostgresExecutionConfigurations } from '../src/adapters/postgres-execution-configurations.js'
import { PostgresPluginAccessStore } from '../src/adapters/postgres-plugin-access-store.js'
import { PostgresPluginUpstreams } from '../src/adapters/postgres-plugin-upstreams.js'
import { PostgresSharedModelStore } from '../src/adapters/postgres-shared-model-store.js'
import { PostgresSystemStatus } from '../src/adapters/postgres-system-status.js'
import { FileSharedModelProjection } from '../src/adapters/shared-model-projection.js'
import { createMcpStorage } from '../src/composition/mcp-storage.js'
import type { McpService } from '../src/domain/mcp-service.js'
import { seedExecutionOwners } from './fixtures/execution-owners.js'
import { seedMcpParents } from './fixtures/mcp-parents.js'
import { removeCommunityFixture } from './fixtures/owned-cleanup.js'
import { createCommunityApplication, openTestDatabase, testDatabaseConfigFile } from './support/community-application.js'
import { restoreResetCatalog } from './support/platform-catalog-reset.js'
import { seedPluginParents } from './support/plugin-facts.js'

const execute = promisify(execFile)
it('requires an explicit phrase and recovers a lost master without deleting accounts or provider configuration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-reset-')),
    data = join(root, 'data')
  await mkdir(data)
  const configFile = testDatabaseConfigFile(data),
    saved = FilePlatformDatabaseConfig.open(configFile, data)
  FilePlatformDatabaseConfig.select(configFile, data, saved.connection, 'builtin')
  await copyFile(configFile, join(dirname(configFile), 'builtin-database.json'))
  const config = {
    listen: { host: '127.0.0.1', port: 0 },
    platformDatabaseConfigFile: configFile,
    runtime: {
      command: process.execPath,
      args: ['tests/fixtures/runtime.mjs'],
      dataRoot: data,
      defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'http://127.0.0.1:1' } },
    },
  }
  let app = createCommunityApplication(config),
    setupReference = ''
  try {
    const origin = await app.start()
    const initialized = await fetch(origin + '/bootstrap', {
      method: 'POST',
      redirect: 'manual',
      headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ credential: readBootstrapCredential(data)!.credential, username: 'admin', password: 'password' }),
    })
    expect(initialized.status).toBe(303)
    const cookie = initialized.headers
      .getSetCookie()
      .map(value => value.split(';')[0])
      .join('; ')
    await app.stop()
    const database = await openTestDatabase(data),
      models = new PostgresSharedModelStore(database, new FileSharedModelProjection(data))
    const upstreams = new PostgresPluginUpstreams(database),
      execution = new PostgresExecutionConfigurations(database),
      mcp = createMcpStorage(database),
      access = new PostgresPluginAccessStore(database),
      setups = new PostgresContributionSetups(database)
    try {
      await seedPluginParents(database)
      await seedMcpParents(database, { groups: ['team'] })
      await seedExecutionOwners(database, ['skill:example'])
      await Promise.all([models.initialize(), upstreams.initialize(), execution.initialize(), mcp.initialize(), access.initialize(), setups.initialize()])
      await database.query('INSERT INTO dsh_phalanx.master_key_backups(fingerprint,username,space_id) VALUES($1,$2,$3)', [
        saved.security.registry.masterFingerprint,
        'admin',
        'fixture-space',
      ])
      await models.save({
        revision: models.read().revision + 1,
        defaultModelId: 'fixture',
        providers: [
          {
            id: 'provider',
            name: 'Retained provider',
            apiFormat: 'anthropic-messages',
            baseUrl: 'https://models.example.test',
            apiKey: 'fictional-reset-secret',
            enabled: true,
            models: [{ id: 'fixture', name: 'Fixture', enabled: true, input: 'text' }],
          },
        ],
      })
      await upstreams.save('plugin', [
        {
          name: 'search',
          baseUrl: 'https://search.example.test',
          credential: 'fictional-upstream-key',
          headers: [{ name: 'X-Key', value: 'fictional-upstream-header' }],
          testRequest: { method: 'POST', path: '/check?key=fictional-query-key', body: { key: 'fictional-body-key' } },
        },
      ])
      await execution.save('skill:example', {
        enabled: true,
        commands: [{ command: 'scripts/run.py', blocked: [] }],
        variables: [
          { name: 'PRIVATE_KEY', value: 'fictional-variable-key', secret: true },
          { name: 'REGION', value: 'retained-region', secret: false },
        ],
      })
      const candidate: McpService = {
        name: 'p-service',
        generation: 2,
        description: 'Retained service',
        url: 'https://mcp.example.test/fictional-mcp-key',
        credential: 'fictional-mcp-key',
        credentials: { account: 'fictional-account-key' },
        headers: [{ name: 'X-Key', value: 'fictional-mcp-header' }],
        query: [{ name: 'token', value: 'fictional-mcp-query' }],
        run: {
          location: 'shared',
          command: 'fictional-mcp-key',
          args: ['fictional-account-key'],
          env: [{ name: 'KEY', value: 'fictional-mcp-env' }],
          prepareCommand: 'fictional-mcp-key',
        },
      }
      await mcp.update(await mcp.read(), {
        services: [
          {
            ...candidate,
            generation: 3,
            catalog: { id: 'amap', version: '1', status: 'ready' },
            catalogUpdate: {
              name: 'p-service',
              requestId: 'request',
              version: 'next',
              baseGeneration: 2,
              actor: { username: 'admin', spaceId: 'space', sessionEpoch: 0 },
              status: 'failed',
              candidate: {
                ...candidate,
                catalogUpdate: {
                  name: 'p-service',
                  requestId: 'nested',
                  version: 'later',
                  baseGeneration: 1,
                  actor: { username: 'admin', spaceId: 'space', sessionEpoch: 0 },
                  status: 'failed',
                  candidate,
                },
              },
            },
          },
        ],
        grants: { team: ['p-service'] },
      })
      const before = {
        environment: [{ name: 'KEY', value: 'fictional-before-key' }],
        entriesYaml: 'main:\n  key: fictional-before-key',
        entries: { main: { key: 'fictional-before-key', enabled: true, nested: ['fictional-before-key', 7] } },
      }
      await access.save('plugin', before, { id: 'contribution', revision: 'receipt' })
      await access.applySuite('plugin', 'suite-task', { ...before, environment: [{ name: 'KEY', value: 'fictional-current-key' }] })
      setupReference = await setups.save(
        { id: 'setup', revision: 'revision' },
        { execution: { enabled: true, commands: [], variables: [{ name: 'KEY', value: 'fictional-setup-key', secret: true }] } },
      )
    } finally {
      await Promise.all([models.close(), upstreams.close(), execution.close(), mcp.close(), access.close(), setups.close()])
      await database.close()
    }
    const recovery = join(dirname(configFile), 'secret-recovery.json'),
      maintenance = join(root, 'maintenance')
    await writeFile(recovery, JSON.stringify({ activePassword: saved.connection.password, builtinPassword: saved.connection.password }), { mode: 0o600 })
    await rm(saved.security.masterKeyPath)
    const reset = (confirmation: string) =>
      execute(process.execPath, [
        '--import',
        'tsx',
        'src/composition/cli.ts',
        'master-key-reset',
        '--config-file',
        configFile,
        '--data-root',
        data,
        '--maintenance-file',
        maintenance,
        '--recovery-file',
        recovery,
        '--confirmation',
        confirmation,
        '--offline',
      ])
    await expect(reset('not-confirmed')).rejects.toMatchObject({ stderr: expect.stringContaining('RESET ALL PLATFORM SECRETS') })
    await writeFile(recovery, 'fixturekey')
    await expect(reset('RESET ALL PLATFORM SECRETS')).rejects.toMatchObject({ stderr: expect.not.stringContaining('fixturekey') })
    await writeFile(recovery, JSON.stringify({ activePassword: saved.connection.password, builtinPassword: saved.connection.password }))
    const result = JSON.parse((await reset('RESET ALL PLATFORM SECRETS')).stdout)
    expect(result).toMatchObject({ status: 'reset', fingerprint: expect.stringMatching(/^sha256:/u) })
    expect(result.fingerprint).not.toBe(saved.security.registry.masterFingerprint)
    expect((await readFile(saved.security.masterKeyPath)).length).toBe(32)
    const restored = await openTestDatabase(data),
      owners = {
        upstreams: new PostgresPluginUpstreams(restored),
        execution: new PostgresExecutionConfigurations(restored),
        mcp: createMcpStorage(restored),
        access: new PostgresPluginAccessStore(restored),
        setups: new PostgresContributionSetups(restored),
      }
    try {
      await Promise.all(Object.values(owners).map(owner => owner.initialize()))
      const status = new PostgresSystemStatus(restored, () => 'builtin')
      expect((await status.read()).masterKey).toEqual({ fingerprint: result.fingerprint, backup: null })
      await expect(status.confirmBackup(saved.security.registry.masterFingerprint, { username: 'admin', spaceId: 'fixture-space' })).rejects.toMatchObject({
        code: 'master-key-changed',
      })
      expect(await owners.upstreams.list('plugin')).toMatchObject([
        { name: 'search', credential: '', headers: [{ name: 'X-Key', value: '' }], testRequest: null },
      ])
      expect((await owners.execution.get('skill:example'))?.variables).toEqual([
        { name: 'PRIVATE_KEY', value: '', secret: true },
        { name: 'REGION', value: 'retained-region', secret: false },
      ])
      const service = (await owners.mcp.read()).services[0]!
      for (const row of [service, service.catalogUpdate!.candidate!, service.catalogUpdate!.candidate!.catalogUpdate!.candidate!]) {
        expect(row).toMatchObject({
          credential: '',
          credentials: { account: '' },
          url: '',
          run: { command: '', args: [''], prepareCommand: '', env: [{ name: 'KEY', value: '' }] },
        })
        expect(row.protectedValues ?? []).toEqual([])
        expect(row.protectedCredentials ?? []).toEqual([])
      }
      expect((await owners.mcp.read()).grants).toEqual({ team: ['p-service'] })
      expect(await owners.access.get('plugin')).toMatchObject({
        environment: [{ name: 'KEY', value: '' }],
        entriesYaml: '',
        entries: { main: { key: '', enabled: true, nested: ['', 7] } },
      })
      expect(await owners.access.restoreSuite('plugin', 'suite-task')).toBe(true)
      expect((await owners.access.get('plugin'))?.environment).toEqual([{ name: 'KEY', value: '' }])
      expect(await owners.access.receipt('plugin')).toEqual({ id: 'contribution', revision: 'receipt' })
      expect(await owners.setups.read(setupReference, { id: 'setup', revision: 'revision' })).toBeUndefined()
    } finally {
      await Promise.all(Object.values(owners).map(owner => owner.close()))
      await restored.close()
    }
    app = createCommunityApplication(config)
    const restarted = await app.start()
    expect((await fetch(restarted + '/admin/api/session', { headers: { cookie } })).status).not.toBe(200)
    const login = await fetch(restarted + '/login', {
      method: 'POST',
      redirect: 'manual',
      headers: { origin: restarted, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'admin', password: 'password' }),
    })
    expect(login.status).toBe(303)
    const renewed = login.headers
      .getSetCookie()
      .map(value => value.split(';')[0])
      .join('; ')
    expect(await (await fetch(restarted + '/admin/api/models', { headers: { cookie: renewed } })).json()).toMatchObject({
      providers: [{ id: 'provider', apiKey: { configured: false, last4: '' } }],
    })
    expect(await (await fetch(restarted + '/admin/api/mcp', { headers: { cookie: renewed } })).json()).toMatchObject([
      { name: 'p-service', credential: { configured: false }, credentials: { account: { configured: false } }, testStatus: 'untested' },
    ])
    await app.stop()
    const reopened = await openTestDatabase(data),
      store = new PostgresSharedModelStore(reopened, new FileSharedModelProjection(data))
    try {
      await restoreResetCatalog(reopened)
      await store.initialize()
      expect((await store.read()).providers).toMatchObject([{ id: 'provider', name: 'Retained provider', apiKey: '' }])
    } finally {
      await store.close()
      await reopened.close()
    }
    app = createCommunityApplication(config)
    const recold = await app.start()
    expect(await (await fetch(recold + '/admin/api/mcp', { headers: { cookie: renewed } })).json()).toMatchObject([
      { name: 'p-service', catalog: { version: '1', status: 'ready' }, credential: { configured: true }, testStatus: 'passed' },
    ])
  } finally {
    await app.stop()
    await removeCommunityFixture(root)
  }
})
