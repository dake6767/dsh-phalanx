import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { PostgresPluginLibraryStore } from '../src/adapters/postgres-plugin-library.js'
import { PostgresCommunityAccountStore } from '../src/adapters/postgres-community-accounts.js'
import { PostgresPluginUpstreams } from '../src/adapters/postgres-plugin-upstreams.js'
import type { LibraryPlugin } from '../src/domain/plugin-library.js'
import { upstreamWriteInput } from '../src/domain/plugin-upstream.js'
import { PluginUpstreamAccess } from '../src/use-cases/plugin-upstream-access.js'
import { PluginUpstreamAdministration } from '../src/use-cases/plugin-upstream-administration.js'
import { PluginUpstreamTest } from '../src/use-cases/plugin-upstream-test.js'
import { openTestDatabase } from './support/community-application.js'
import { seedPluginParents } from './support/plugin-facts.js'

it('keeps saved diagnostic paths and arbitrary JSON body values encrypted and write-only across credential rotation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'postgres-upstream-diagnostic-'))
  const database = await openTestDatabase(root),
    store = new PostgresPluginUpstreams(database)
  const actor = { username: 'admin', spaceId: 'a', sessionEpoch: 0 }
  const accounts = { get: async () => ({ ...actor, admin: true, disabled: false, groupId: 'admins', email: '', createdAt: 0, updatedAt: 0 }) }
  const library = { list: async () => [{ packageName: 'plugin' } as LibraryPlugin] }
  const request = {
    method: 'POST',
    path: '/check?token=fictional-diagnostic-query',
    body: { key: 'fictional-diagnostic-body', nested: [false, 0, null, ['fictional-diagnostic-leaf']] },
  }
  try {
    await seedPluginParents(database)
    await store.initialize()
    const service = new PluginUpstreamAdministration(accounts, library, store)
    const first = await service.execute(actor, 'plugin', {
      action: 'save',
      upstream: { name: 'test', baseUrl: 'https://example.test', credential: 'fictional-diagnostic-body', headers: [], testRequest: request },
    })
    const inputs = [
      JSON.stringify(first),
      JSON.stringify(await service.contributionList(actor, 'plugin')),
      JSON.stringify(await database.query('SELECT * FROM dsh_phalanx.plugin_upstream_settings')),
      JSON.stringify(await database.query('SELECT * FROM dsh_phalanx.plugin_upstreams')),
    ]
    for (const input of inputs)
      for (const value of ['fictional-diagnostic-query', 'fictional-diagnostic-body', 'fictional-diagnostic-leaf']) expect(input).not.toContain(value)
    const draft = upstreamWriteInput(first[0]!)
    expect(draft.testRequest).toBeUndefined()
    await service.execute(actor, 'plugin', { action: 'save', upstream: { ...draft, credential: 'fictional-rotated-credential' } })
    const reopened = new PostgresPluginUpstreams(database)
    await reopened.initialize()
    const tester = new PluginUpstreamTest(
      service,
      reopened,
      {
        send: async input => {
          expect(input.method).toBe(request.method)
          expect(input.path).toBe(request.path)
          expect(JSON.parse(await new Response(input.body).text())).toEqual(request.body)
          return new Response('echo fictional-diagnostic-query fictional-diagnostic-body fictional-diagnostic-leaf')
        },
      },
      { now: () => 0 },
    )
    const result = await tester.execute(actor, 'plugin', 'test')
    expect(result.body).not.toContain('fictional-diagnostic')
    expect(result.passed).toBe(true)
    expect((await reopened.list('plugin'))[0]?.testRequest).toEqual(request)
    const second = new PluginUpstreamAdministration(accounts, library, reopened)
    for (const body of [false, 0, null, [], { nested: [false, 0, null] }]) {
      await second.execute(actor, 'plugin', { action: 'save', upstream: { ...draft, testRequest: { method: 'POST', path: '/replacement', body } } })
      expect((await reopened.list('plugin'))[0]?.testRequest?.body).toEqual(body)
    }
    await second.execute(actor, 'plugin', { action: 'save', upstream: { ...draft, testRequest: null } })
    expect((await reopened.list('plugin'))[0]?.testRequest).toBeNull()
    await reopened.close()
  } finally {
    await store.close()
    await database.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('refuses a misplaced upstream ciphertext on admission while other upstreams remain usable after reopening', async () => {
  const root = await mkdtemp(join(tmpdir(), 'postgres-upstream-aad-'))
  const database = await openTestDatabase(root),
    other = await openTestDatabase(root)
  try {
    const accounts = new PostgresCommunityAccountStore(database)
    const actor = await accounts.createFirstAdmin({ username: 'admin', email: '', password: 'password' })
    const store = new PostgresPluginUpstreams(database)
    await seedPluginParents(database)
    await store.initialize()
    await store.save(
      '@sample/plugin',
      ['first', 'second'].map(name => ({ name, baseUrl: 'https://upstream.example.test', credential: 'fictional-' + name, headers: [] })),
    )
    await database.query(
      `UPDATE dsh_phalanx.plugin_upstreams SET credential=(SELECT credential FROM dsh_phalanx.plugin_upstreams WHERE package_name=$1 AND name='first') WHERE package_name=$1 AND name='second'`,
      ['@sample/plugin'],
    )
    const reopened = new PostgresPluginUpstreams(other)
    await reopened.initialize()
    const access = new PluginUpstreamAccess(
      accounts,
      { resolve: token => (token === 'member-token' ? { username: actor.username, spaceId: actor.spaceId } : undefined) },
      {
        authorizationRevision: () => 'fixed',
        list: async () => [{ packageName: '@sample/plugin', stage: 'available', current: { runtimeRevision: 'revision' }, published: true } as LibraryPlugin],
      },
      { authorizationRevision: () => 'fixed', get: async () => [] },
      reopened,
      'revision',
    )
    const headers = { authorization: 'Bearer member-token' }
    await expect(access.authorize('@sample/plugin', 'second', headers)).rejects.toMatchObject({
      status: 503,
      message: 'Plugin upstream secret cannot be decrypted; configure it again',
    })
    expect((await access.authorize('@sample/plugin', 'first', headers)).upstream.credential).toBe('fictional-first')
    const [before] = await other.query('SELECT credential FROM dsh_phalanx.plugin_upstreams WHERE name=$1', ['second'])
    await reopened.save('@sample/plugin', await reopened.list('@sample/plugin'), { id: 'receipt', revision: 'revision' })
    const [after] = await other.query('SELECT credential FROM dsh_phalanx.plugin_upstreams WHERE name=$1', ['second'])
    expect(after).toEqual(before)
  } finally {
    await Promise.all([database.close(), other.close()])
    await rm(root, { recursive: true, force: true })
  }
})

it('reopens plugin upstream credentials and locked headers from PostgreSQL without persisting their plaintext', async () => {
  const root = await mkdtemp(join(tmpdir(), 'postgres-plugin-upstreams-'))
  const database = await openTestDatabase(root),
    other = await openTestDatabase(root)
  const upstreams = [
    {
      name: 'search',
      baseUrl: 'https://upstream.example.test',
      credential: 'fictional-upstream-credential',
      headers: [{ name: 'x-private-routing', value: 'fictional-locked-header' }],
    },
  ]
  try {
    const store = new PostgresPluginUpstreams(database)
    await seedPluginParents(database)
    await store.initialize()
    expect(await store.list('@sample/plugin')).toEqual([])
    await store.save('@sample/plugin', upstreams)
    expect(await store.list('@sample/plugin')).toEqual(upstreams)
    const rows = await database.query('SELECT * FROM dsh_phalanx.plugin_upstreams')
    expect(rows).toHaveLength(1)
    expect(JSON.stringify(rows)).not.toContain('fictional-upstream-credential')
    expect(JSON.stringify(rows)).not.toContain('fictional-locked-header')
    const metadata = await database.query('SELECT * FROM dsh_phalanx.plugin_upstream_settings')
    expect(JSON.stringify(metadata)).toContain('https://upstream.example.test')
    expect(JSON.stringify(metadata)).not.toContain('fictional-upstream-credential')
    expect(JSON.stringify(metadata)).not.toContain('fictional-locked-header')
    const reopened = new PostgresPluginUpstreams(other)
    await reopened.initialize()
    expect(await reopened.list('@sample/plugin')).toEqual(upstreams)
  } finally {
    await Promise.all([database.close(), other.close()])
    await rm(root, { recursive: true, force: true })
  }
})

it.each(['save', 'adopt', 'skip'] as const)('keeps an upstream %s response pending until its PostgreSQL transaction commits', async action => {
  const root = await mkdtemp(join(tmpdir(), 'postgres-upstream-response-'))
  const database = await openTestDatabase(root)
  let release!: () => void, pendingWrite: Promise<void> | undefined
  try {
    const accounts = new PostgresCommunityAccountStore(database)
    const actor = await accounts.createFirstAdmin({ username: 'admin', email: '', password: 'password' })
    const library = new PostgresPluginLibraryStore(database)
    await library.save({ packageName: '@sample/plugin', version: '1.0.0', current: null, stage: 'failed', published: false })
    const store = new PostgresPluginUpstreams(database)
    await seedPluginParents(database)
    await store.initialize()
    await store.save('@sample/plugin', [])
    let entered!: () => void,
      completed = false
    const began = new Promise<void>(resolve => {
        entered = resolve
      }),
      gate = new Promise<void>(resolve => {
        release = resolve
      })
    const holder = database.transaction(async sql => {
      await sql.query('SELECT package_name FROM dsh_phalanx.plugin_upstream_settings WHERE package_name=$1 FOR UPDATE', ['@sample/plugin'])
      entered()
      await gate
    })
    await began
    const management = new PluginUpstreamAdministration(accounts, library, {
      list: store.list.bind(store),
      save: (packageName, upstreams, receipt) => {
        pendingWrite = store.save(packageName, upstreams, receipt)
        return pendingWrite
      },
    })
    const upstream = {
      name: 'search',
      baseUrl: 'https://upstream.example.test',
      credential: 'fictional-upstream-credential',
      headers: [],
    }
    const receipt = { id: 'contribution', revision: 'submission' }
    const saving = Promise.resolve(
      action === 'save'
        ? management.execute(actor, '@sample/plugin', { action: 'save', upstream })
        : action === 'adopt'
          ? management.adoptContribution('@sample/plugin', [upstream], receipt)
          : management.skipContribution('@sample/plugin', receipt, ['Retain newer settings']),
    ).then(result => {
      completed = true
      return result
    })
    try {
      await expect
        .poll(async () =>
          Number(
            (
              await database.query<{ waiting: string }>(
                "SELECT count(*) AS waiting FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'",
              )
            )[0]!.waiting,
          ),
        )
        .toBeGreaterThan(0)
      expect(completed).toBe(false)
      release()
      await holder
      await saving
      if (action !== 'skip') expect((await store.list('@sample/plugin'))[0]?.name).toBe('search')
      if (action !== 'save') expect(await store.receipt('@sample/plugin')).toMatchObject(receipt)
    } finally {
      release()
      await Promise.allSettled([holder, saving, pendingWrite])
    }
  } finally {
    release?.()
    await database.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('retains its committed upstream view after PostgreSQL rejects COMMIT and accepts a later save', async () => {
  const root = await mkdtemp(join(tmpdir(), 'postgres-upstream-commit-'))
  const database = await openTestDatabase(root),
    other = await openTestDatabase(root)
  const upstreams = [{ name: 'search', baseUrl: 'https://upstream.example.test', credential: 'fictional-upstream-credential', headers: [] }]
  try {
    const store = new PostgresPluginUpstreams(database)
    await seedPluginParents(database)
    await store.initialize()
    await store.save('@sample/plugin', [])
    await database.query(`CREATE TABLE dsh_phalanx.commit_parents(id integer PRIMARY KEY);
      CREATE TABLE dsh_phalanx.commit_children(id integer REFERENCES dsh_phalanx.commit_parents(id) DEFERRABLE INITIALLY DEFERRED);
      CREATE FUNCTION dsh_phalanx.reject_upstream_commit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN INSERT INTO dsh_phalanx.commit_children VALUES(42); RETURN NEW; END $$;
      CREATE TRIGGER reject_upstream_commit AFTER UPDATE ON dsh_phalanx.plugin_upstream_settings FOR EACH ROW EXECUTE FUNCTION dsh_phalanx.reject_upstream_commit();`)
    await expect(store.save('@sample/plugin', upstreams)).rejects.toMatchObject({ code: 'query-failed', sqlState: '23503' })
    expect(await store.list('@sample/plugin')).toEqual([])
    expect(await database.query('SELECT * FROM dsh_phalanx.plugin_upstreams')).toEqual([])
    const reopened = new PostgresPluginUpstreams(other)
    await reopened.initialize()
    expect(await reopened.list('@sample/plugin')).toEqual([])
    await database.query('DROP TRIGGER reject_upstream_commit ON dsh_phalanx.plugin_upstream_settings')
    await store.save('@sample/plugin', upstreams)
    expect(await store.list('@sample/plugin')).toEqual(upstreams)
  } finally {
    await Promise.all([database.close(), other.close()])
    await rm(root, { recursive: true, force: true })
  }
})

it('retains contribution receipts and stable configuration revisions across PostgreSQL reopen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'postgres-upstream-receipt-'))
  const database = await openTestDatabase(root),
    other = await openTestDatabase(root)
  const upstreams = [{ name: 'search', baseUrl: 'https://upstream.example.test', credential: 'fictional-upstream-credential', headers: [] }]
  const firstReceipt = { id: 'contribution-one', revision: 'submission-one' }
  const nextReceipt = { id: 'contribution-two', revision: 'submission-two', warnings: ['Retained public endpoint warning'] }
  try {
    const store = new PostgresPluginUpstreams(database)
    await seedPluginParents(database)
    await store.initialize()
    expect(await store.revision('@sample/plugin')).toBe('none')
    await store.save('@sample/plugin', upstreams, firstReceipt)
    const revision = await store.revision('@sample/plugin')
    expect(revision).not.toBe('none')
    const reopened = new PostgresPluginUpstreams(other)
    await reopened.initialize()
    expect(await reopened.revision('@sample/plugin')).toBe(revision)
    expect(await reopened.receipt('@sample/plugin')).toEqual(firstReceipt)
    await store.save('@sample/plugin', upstreams, nextReceipt)
    expect(await store.revision('@sample/plugin')).toBe(revision)
    expect(await store.receipt('@sample/plugin')).toEqual(nextReceipt)
    const replayed = new PostgresPluginUpstreams(other)
    await seedPluginParents(other)
    await replayed.initialize()
    expect(await replayed.receipt('@sample/plugin')).toEqual(nextReceipt)
    await store.save('@sample/plugin', upstreams)
    expect(await store.receipt('@sample/plugin')).toEqual(nextReceipt)
    await store.save('@sample/plugin', [{ ...upstreams[0]!, credential: 'replacement-upstream-credential' }])
    expect(await store.revision('@sample/plugin')).not.toBe(revision)
    await store.save('@sample/plugin', [])
    expect(await store.revision('@sample/plugin')).toBe('none')
    expect(await store.receipt('@sample/plugin')).toEqual(nextReceipt)
  } finally {
    await Promise.all([database.close(), other.close()])
    await rm(root, { recursive: true, force: true })
  }
})

it('keeps the same revision when an unchanged upstream is saved after reopening its owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'postgres-upstream-unchanged-'))
  const database = await openTestDatabase(root),
    other = await openTestDatabase(root)
  const upstreams = [
    {
      name: 'search',
      baseUrl: 'https://upstream.example.test',
      credential: 'fictional-upstream-credential',
      headers: [{ name: 'Authorization', value: 'Bearer {credential}' }],
      testRequest: { method: 'POST', path: '/test', body: { second: 'two', first: 'one' } },
    },
  ]
  try {
    const store = new PostgresPluginUpstreams(database)
    await seedPluginParents(database)
    await store.initialize()
    await store.save('@sample/plugin', upstreams)
    const revision = await store.revision('@sample/plugin')
    const reopened = new PostgresPluginUpstreams(other)
    await reopened.initialize()
    await reopened.save('@sample/plugin', upstreams)
    expect(await reopened.revision('@sample/plugin')).toBe(revision)
  } finally {
    await Promise.all([database.close(), other.close()])
    await rm(root, { recursive: true, force: true })
  }
})

it('rejects an upstream save based on a stale PostgreSQL configuration instead of overwriting a newer save', async () => {
  const root = await mkdtemp(join(tmpdir(), 'postgres-upstream-stale-'))
  const database = await openTestDatabase(root),
    other = await openTestDatabase(root)
  const upstreams = [{ name: 'search', baseUrl: 'https://upstream.example.test', credential: 'fictional-upstream-credential', headers: [] }]
  try {
    const current = new PostgresPluginUpstreams(database)
    await seedPluginParents(database)
    await current.initialize()
    await current.save('@sample/plugin', upstreams)
    const stale = new PostgresPluginUpstreams(other)
    await seedPluginParents(other)
    await stale.initialize()
    const expectedRevision = await stale.revision('@sample/plugin')
    const newer = [{ ...upstreams[0]!, baseUrl: 'https://newer.example.test' }]
    await current.save('@sample/plugin', newer)
    await expect(
      stale.save('@sample/plugin', [{ ...upstreams[0]!, baseUrl: 'https://stale.example.test' }], undefined, expectedRevision),
    ).rejects.toMatchObject({
      kind: 'conflict',
      code: 'platform-configuration-conflict',
    })
    expect(await stale.list('@sample/plugin')).toEqual(newer)
    const reopened = new PostgresPluginUpstreams(other)
    await reopened.initialize()
    expect(await reopened.list('@sample/plugin')).toEqual(newer)
  } finally {
    await Promise.all([database.close(), other.close()])
    await rm(root, { recursive: true, force: true })
  }
})

it('drains an accepted upstream save before closing, rejects new saves and leaves the shared database open', async () => {
  const root = await mkdtemp(join(tmpdir(), 'postgres-upstream-close-'))
  const database = await openTestDatabase(root),
    other = await openTestDatabase(root)
  let release!: () => void
  try {
    const store = new PostgresPluginUpstreams(database)
    await seedPluginParents(database)
    await store.initialize()
    await store.save('@sample/plugin', [])
    let entered!: () => void,
      closed = false
    const began = new Promise<void>(resolve => {
        entered = resolve
      }),
      gate = new Promise<void>(resolve => {
        release = resolve
      })
    const holder = database.transaction(async sql => {
      await sql.query('SELECT package_name FROM dsh_phalanx.plugin_upstream_settings WHERE package_name=$1 FOR UPDATE', ['@sample/plugin'])
      entered()
      await gate
    })
    await began
    const upstreams = [{ name: 'search', baseUrl: 'https://upstream.example.test', credential: 'fictional-upstream-credential', headers: [] }]
    const saving = store.save('@sample/plugin', upstreams)
    let closing: Promise<void> | undefined
    try {
      await expect
        .poll(async () =>
          Number(
            (
              await database.query<{ waiting: string }>(
                "SELECT count(*) AS waiting FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'",
              )
            )[0]!.waiting,
          ),
        )
        .toBeGreaterThan(0)
      closing = store.close().then(() => {
        closed = true
      })
      await expect(store.save('@sample/plugin', [])).rejects.toThrow(/closed/u)
      expect(closed).toBe(false)
      release()
      await holder
      await saving
      await closing
      await expect(store.list('@sample/plugin')).rejects.toThrow(/closed/u)
      expect((await database.health()).state).toBe('connected')
      const reopened = new PostgresPluginUpstreams(other)
      await reopened.initialize()
      expect(await reopened.list('@sample/plugin')).toEqual(upstreams)
    } finally {
      release()
      await Promise.allSettled([holder, saving, closing])
    }
  } finally {
    release?.()
    await Promise.all([database.close(), other.close()])
    await rm(root, { recursive: true, force: true })
  }
})

it('clears an upstream credential explicitly while retaining its referenced identity, headers and diagnostic request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'postgres-upstream-clear-')),
    database = await openTestDatabase(root),
    store = new PostgresPluginUpstreams(database)
  const actor = { username: 'admin', spaceId: 'a', sessionEpoch: 0 }
  try {
    await seedPluginParents(database)
    await store.initialize()
    const accounts = { get: async () => ({ ...actor, admin: true, disabled: false, groupId: 'admins', email: '', createdAt: 0, updatedAt: 0 }) }
    const service = new PluginUpstreamAdministration(accounts, { list: async () => [{ packageName: 'plugin' } as LibraryPlugin] }, store, {
      references: () => ['main.endpoint'],
    })
    await service.execute(actor, 'plugin', {
      action: 'save',
      upstream: {
        name: 'search',
        baseUrl: 'https://example.test',
        credential: 'fictional-clear-upstream-key',
        headers: [{ name: 'X-Tenant', value: 'fictional-tenant' }],
        testRequest: { method: 'GET', path: '/check' },
      },
    })
    const draft = upstreamWriteInput((await service.list(actor, 'plugin'))[0]!)
    await service.execute(actor, 'plugin', { action: 'save', upstream: { ...draft, credential: '' } })
    expect((await store.list('plugin'))[0]?.credential).toBe('fictional-clear-upstream-key')
    const clear = { ...draft, clearCredential: true }
    expect((await service.execute(actor, 'plugin', { action: 'save', upstream: clear }))[0]?.credential).toEqual({ configured: false, last4: '' })
    expect((await store.list('plugin'))[0]).toMatchObject({
      name: 'search',
      baseUrl: 'https://example.test',
      headers: [{ name: 'X-Tenant', value: 'fictional-tenant' }],
      testRequest: { method: 'GET', path: '/check' },
    })
    await expect(service.execute(actor, 'plugin', { action: 'delete', name: 'search' })).rejects.toMatchObject({ code: 'plugin-upstream-referenced' })
    const conflicting = { ...clear, credential: 'replacement' }
    await expect(service.execute(actor, 'plugin', { action: 'save', upstream: conflicting })).rejects.toMatchObject({ code: 'plugin-upstream-invalid' })
    const restored = new PostgresPluginUpstreams(database)
    await seedPluginParents(database)
    await restored.initialize()
    expect((await restored.list('plugin'))[0]?.credential).toBe('')
    await restored.close()
  } finally {
    await store.close()
    await database.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('reads credentials, headers and diagnostic requests with the original upstream AAD spelling', async () => {
  const root = await mkdtemp(join(tmpdir(), 'upstream-old-aad-')),
    database = await openTestDatabase(root)
  try {
    await seedPluginParents(database)
    const store = new PostgresPluginUpstreams(database)
    await store.initialize()
    const upstream = {
      name: 'search',
      baseUrl: 'https://example.test',
      credential: 'old-credential',
      headers: [{ name: 'X-Key', value: 'old-header' }],
      testRequest: { method: 'POST' as const, path: '/check', body: { value: 'old-body' } },
    }
    await store.save('plugin', [upstream])
    const encrypt = (field: string, value: string) => database.cipher().encrypt({ table: 'plugin_upstreams', recordId: '["plugin","search"]', field }, value)
    await database.query('UPDATE dsh_phalanx.plugin_upstreams SET credential=$1,headers=$2,test_request=$3 WHERE package_name=$4 AND name=$5', [
      JSON.stringify(encrypt('credential', 'old-credential')),
      JSON.stringify([encrypt('headers/x-key', 'old-header')]),
      JSON.stringify(encrypt('testRequest', JSON.stringify(upstream.testRequest))),
      'plugin',
      'search',
    ])
    expect(await store.list('plugin')).toEqual([upstream])
  } finally {
    await database.close()
    await rm(root, { recursive: true, force: true })
  }
})
