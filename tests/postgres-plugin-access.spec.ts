import { PostgresPluginLibraryStore } from '../src/adapters/postgres-plugin-library.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { YamlPluginAccessSyntax } from '../src/adapters/plugin-access-syntax.js'
import { PostgresCommunityAccountStore } from '../src/adapters/postgres-community-accounts.js'
import { PostgresPluginAccessStore } from '../src/adapters/postgres-plugin-access-store.js'
import { PluginAccessAdministration } from '../src/use-cases/plugin-access-administration.js'
import { openTestDatabase } from './support/community-application.js'
import { seedPluginParents } from './support/plugin-facts.js'

it('protects plugin access environment and both YAML representations in current and checkpoint snapshots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'postgres-plugin-access-'))
  const database = await openTestDatabase(root),
    other = await openTestDatabase(root)
  const before = {
    environment: [{ name: 'PRIVATE_KEY', value: 'fictional-plugin-before-key' }],
    entriesYaml: 'main:\n  key: fictional-yaml-before-key\n',
    entries: { main: { key: 'fictional-yaml-before-key', enabled: true, nested: ['plain-string', 3] } },
  }
  const next = {
    environment: [{ name: 'PRIVATE_KEY', value: 'fictional-plugin-current-key' }],
    entriesYaml: 'main:\n  key: fictional-yaml-current-key\n',
    entries: { main: { key: 'fictional-yaml-current-key', enabled: false } },
  }
  try {
    const store = new PostgresPluginAccessStore(database)
    await seedPluginParents(database)
    await store.initialize()
    await store.save('plugin', before, { id: 'contribution', revision: 'one' })
    const original = (await store.get('plugin'))!
    await store.applySuite('plugin', 'suite-task', next)
    const metadata = JSON.stringify(await database.query('SELECT * FROM dsh_phalanx.plugin_access_settings'))
    const secrets = JSON.stringify(await database.query('SELECT * FROM dsh_phalanx.plugin_access_secrets'))
    for (const value of [
      'fictional-plugin-before-key',
      'fictional-yaml-before-key',
      'fictional-plugin-current-key',
      'fictional-yaml-current-key',
      'plain-string',
    ]) {
      expect(metadata).not.toContain(value)
      expect(secrets).not.toContain(value)
    }
    expect(metadata).toContain('PRIVATE_KEY')
    expect(metadata).toContain('main')
    expect(metadata).toContain('enabled')
    expect(metadata).toContain('suite-task')
    expect(secrets).toContain('ciphertext')
    const reopened = new PostgresPluginAccessStore(other)
    await seedPluginParents(database)
    await reopened.initialize()
    expect(await reopened.get('plugin')).toMatchObject(next)
    expect(await reopened.suiteCheckpoint('plugin')).toEqual({
      task: 'suite-task',
      before: original,
      receipt: { id: 'contribution', revision: 'one' },
      appliedRevision: (await reopened.get('plugin'))!.revision,
    })
    await reopened.applySuite('plugin', 'suite-task', next)
    expect(await reopened.restoreSuite('plugin', 'suite-task')).toBe(true)
    expect(await reopened.get('plugin')).toEqual(original)
    expect(await reopened.receipt('plugin')).toEqual({ id: 'contribution', revision: 'one' })
  } finally {
    await Promise.all([database.close(), other.close()])
    await rm(root, { recursive: true, force: true })
  }
})

it('keeps plugin access revisions stable after JSONB reload and rejects an older package snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'postgres-plugin-access-revision-'))
  const database = await openTestDatabase(root),
    other = await openTestDatabase(root)
  const settings = {
    environment: [{ name: 'KEY', value: 'fictional-access-stable-key' }],
    entriesYaml: 'main: {}',
    entries: { main: { enabled: true, count: 2 } },
  }
  try {
    const store = new PostgresPluginAccessStore(database)
    await seedPluginParents(database)
    await store.initialize()
    await store.save('plugin', settings)
    const original = (await store.get('plugin'))!
    const reopened = new PostgresPluginAccessStore(other)
    await seedPluginParents(database)
    await reopened.initialize()
    await reopened.save('plugin', settings)
    expect((await reopened.get('plugin'))!.revision).toBe(original.revision)
    await reopened.save('plugin', settings, { id: 'contribution', revision: 'receipt-only' })
    expect((await reopened.get('plugin'))!.revision).toBe(original.revision)
    expect(await store.receipt('plugin')).toEqual({ id: 'contribution', revision: 'receipt-only' })
    await reopened.save('plugin', { ...settings, entries: { main: { enabled: false } } })
    await expect(store.save('plugin', settings, undefined, original.revision)).rejects.toMatchObject({ code: 'platform-configuration-conflict' })
    expect(await store.get('plugin')).toMatchObject({ entries: { main: { enabled: false } } })
    const current = new PostgresPluginAccessStore(database)
    await seedPluginParents(database)
    await current.initialize()
    expect(await current.get('plugin')).toMatchObject({ entries: { main: { enabled: false } } })
    expect(await current.receipt('plugin')).toEqual({ id: 'contribution', revision: 'receipt-only' })
  } finally {
    await Promise.all([database.close(), other.close()])
    await rm(root, { recursive: true, force: true })
  }
})

it('retains committed settings and suite checkpoints when PostgreSQL rejects COMMIT, then accepts the next write', async () => {
  const root = await mkdtemp(join(tmpdir(), 'postgres-plugin-access-commit-'))
  const database = await openTestDatabase(root),
    other = await openTestDatabase(root)
  const before = { environment: [{ name: 'KEY', value: 'fictional-access-committed-key' }], entriesYaml: '', entries: {} }
  const next = { environment: [{ name: 'KEY', value: 'fictional-access-replacement-key' }], entriesYaml: '', entries: {} }
  try {
    const store = new PostgresPluginAccessStore(database)
    await seedPluginParents(database)
    await store.initialize()
    await store.save('plugin', before)
    const original = (await store.get('plugin'))!
    await database.query(`CREATE TABLE dsh_phalanx.commit_parents(id integer PRIMARY KEY);
      CREATE TABLE dsh_phalanx.commit_children(id integer REFERENCES dsh_phalanx.commit_parents(id) DEFERRABLE INITIALLY DEFERRED);
      CREATE FUNCTION dsh_phalanx.reject_access_commit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN INSERT INTO dsh_phalanx.commit_children VALUES(42); RETURN NULL; END $$;
      CREATE TRIGGER reject_access_commit AFTER UPDATE ON dsh_phalanx.plugin_access_settings FOR EACH ROW EXECUTE FUNCTION dsh_phalanx.reject_access_commit();`)
    await expect(store.applySuite('plugin', 'task', next)).rejects.toMatchObject({ code: 'query-failed', sqlState: '23503' })
    expect(await store.get('plugin')).toEqual(original)
    expect(await store.suiteCheckpoint('plugin')).toBeUndefined()
    const reopened = new PostgresPluginAccessStore(other)
    await seedPluginParents(database)
    await reopened.initialize()
    expect(await reopened.get('plugin')).toEqual(original)
    expect(await reopened.suiteCheckpoint('plugin')).toBeUndefined()
    await database.query('DROP TRIGGER reject_access_commit ON dsh_phalanx.plugin_access_settings')
    await store.applySuite('plugin', 'task', next)
    expect(await store.get('plugin')).toMatchObject(next)
    expect((await store.suiteCheckpoint('plugin'))?.before).toEqual(original)
    expect(await store.restoreSuite('plugin', 'task')).toBe(true)
    expect(await store.get('plugin')).toEqual(original)
  } finally {
    await Promise.all([database.close(), other.close()])
    await rm(root, { recursive: true, force: true })
  }
})

it('restores absent settings, rejects another suite task and leaves a newer manual revision intact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'postgres-plugin-access-suite-'))
  const database = await openTestDatabase(root)
  const settings = { environment: [{ name: 'KEY', value: 'fictional-access-suite-key' }], entriesYaml: '', entries: {} }
  try {
    const store = new PostgresPluginAccessStore(database)
    await seedPluginParents(database)
    await store.initialize()
    await store.applySuite('plugin', 'task', settings)
    await expect(store.applySuite('plugin', 'other-task', settings)).rejects.toMatchObject({ code: 'plugin-impact-changed' })
    await store.clearSuiteCheckpoint('plugin', 'other-task')
    expect((await store.suiteCheckpoint('plugin'))?.task).toBe('task')
    expect(await store.restoreSuite('plugin', 'task')).toBe(true)
    expect(await store.get('plugin')).toBeUndefined()
    await store.applySuite('plugin', 'task2', settings)
    await store.save('plugin', { ...settings, environment: [{ name: 'KEY', value: 'fictional-access-manual-key' }] })
    expect(await store.restoreSuite('plugin', 'task2')).toBe(false)
    expect((await store.get('plugin'))?.environment[0]?.value).toBe('fictional-access-manual-key')
    expect((await store.suiteCheckpoint('plugin'))?.task).toBe('task2')
  } finally {
    await database.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('drains accepted plugin access writes on close and keeps the shared PostgreSQL owner available', async () => {
  const root = await mkdtemp(join(tmpdir(), 'postgres-plugin-access-close-'))
  const database = await openTestDatabase(root)
  let release!: () => void
  try {
    const store = new PostgresPluginAccessStore(database)
    await seedPluginParents(database)
    await store.initialize()
    await store.save('plugin', { environment: [], entriesYaml: '', entries: {} })
    let entered!: () => void,
      closed = false
    const began = new Promise<void>(resolve => {
        entered = resolve
      }),
      gate = new Promise<void>(resolve => {
        release = resolve
      })
    const holder = database.transaction(async sql => {
      await sql.query("SELECT package_name FROM dsh_phalanx.plugin_access_settings WHERE package_name='plugin' FOR UPDATE")
      entered()
      await gate
    })
    await began
    const writing = store.save('plugin', { environment: [{ name: 'KEY', value: 'fictional-access-close-key' }], entriesYaml: '', entries: {} })
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
      await expect(store.remove('plugin')).rejects.toThrow(/closed/u)
      expect(closed).toBe(false)
      release()
      await holder
      await writing
      await closing
      await expect(store.get('plugin')).rejects.toThrow(/closed/u)
      expect((await database.health()).state).toBe('connected')
      const reopened = new PostgresPluginAccessStore(database)
      await seedPluginParents(database)
      await reopened.initialize()
      expect((await reopened.get('plugin'))?.environment[0]?.value).toBe('fictional-access-close-key')
    } finally {
      release()
      await Promise.allSettled([holder, writing, closing])
    }
  } finally {
    release?.()
    await database.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('waits for plugin access COMMIT before returning the management response', async () => {
  const root = await mkdtemp(join(tmpdir(), 'postgres-plugin-access-response-'))
  const database = await openTestDatabase(root),
    store = new PostgresPluginAccessStore(database)
  let release!: () => void
  try {
    await seedPluginParents(database)
    await store.initialize()
    await store.save('plugin', { environment: [], entriesYaml: '', entries: {} })
    const accounts = new PostgresCommunityAccountStore(database)
    const actor = await accounts.createFirstAdmin({ username: 'admin', password: 'password', email: '' })
    const writes: Promise<void>[] = []
    const management = new PluginAccessAdministration(
      accounts,
      { list: async () => [{ packageName: 'plugin', version: '1.0.0', current: null, stage: 'failed', published: false }] },
      {
        get: store.get.bind(store),
        list: store.list.bind(store),
        remove: store.remove.bind(store),
        save: (name, settings, receipt) => {
          const write = store.save(name, settings, receipt)
          writes.push(write)
          return write
        },
      },
      { list: () => [] },
      new YamlPluginAccessSyntax(),
    )
    let entered!: () => void,
      completed = false
    const began = new Promise<void>(resolve => {
        entered = resolve
      }),
      gate = new Promise<void>(resolve => {
        release = resolve
      })
    const holder = database.transaction(async sql => {
      await sql.query("SELECT package_name FROM dsh_phalanx.plugin_access_settings WHERE package_name='plugin' FOR UPDATE")
      entered()
      await gate
    })
    await began
    const saving = management.save(actor, 'plugin', { environment: [{ name: 'KEY', value: 'fictional-plugin-management-key' }], entriesYaml: '' }).then(() => {
      completed = true
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
      expect((await store.get('plugin'))?.environment[0]?.value).toBe('fictional-plugin-management-key')
    } finally {
      release()
      await Promise.allSettled([holder, saving, ...writes])
    }
  } finally {
    release?.()
    await store.close()
    await database.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('makes environment and YAML write-only through management, keeps blanks and clears YAML explicitly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'postgres-plugin-access-view-'))
  const database = await openTestDatabase(root),
    store = new PostgresPluginAccessStore(database)
  try {
    await seedPluginParents(database)
    await store.initialize()
    const accounts = new PostgresCommunityAccountStore(database)
    const actor = await accounts.createFirstAdmin({ username: 'admin', password: 'password', email: '' })
    const prepared = {
      packageName: 'plugin',
      version: '1.0.0',
      title: '',
      description: '',
      artifact: '',
      integrity: '',
      runtimeRevision: '',
      dependencies: {},
      bundlePatch: '- insert:\n  - id: main\n    name: plugin\n',
    }
    const management = new PluginAccessAdministration(
      accounts,
      { list: async () => [{ ...prepared, current: prepared, stage: 'available', published: false }] },
      store,
      { list: () => [] },
      new YamlPluginAccessSyntax(),
    )
    const original = {
      environment: [{ name: 'PRIVATE_KEY', value: 'fictional-access-view-key' }],
      entriesYaml: 'main:\n  key: fictional-access-yaml-view-key\n  enabled: true\n',
    }
    const saved = await management.save(actor, 'plugin', original)
    expect(JSON.stringify(saved)).not.toContain('fictional-access-')
    expect(saved).toMatchObject({ environment: [{ name: 'PRIVATE_KEY', configured: true, last4: '-key' }], entriesYaml: { configured: true } })
    expect(JSON.stringify(await management.contributionView(actor, prepared))).not.toContain('fictional-access-')
    const revision = (await store.get('plugin'))!.revision
    await management.save(actor, 'plugin', { environment: [{ name: 'PRIVATE_KEY', value: '' }], entriesYaml: '' })
    expect(await store.get('plugin')).toMatchObject(original)
    expect((await store.get('plugin'))!.revision).toBe(revision)
    await management.save(actor, 'plugin', {
      environment: [],
      entriesYaml: '',
      clearEntriesYaml: true,
    } as import('../src/domain/admin-contract.js').CommunityPluginAccessInput)
    expect(await store.get('plugin')).toBeUndefined()
  } finally {
    await store.close()
    await database.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('reads protected values written with the original access AAD spelling', async () => {
  const root = await mkdtemp(join(tmpdir(), 'access-old-aad-')),
    database = await openTestDatabase(root)
  try {
    await seedPluginParents(database)
    // A complete legacy row, independent of today's writer and field/context helpers.
    const blank = { environment: [{ name: 'KEY', value: '' }], entriesYaml: '', entries: { main: { key: '' } } }
    const metadata = {
      settings: { ...blank, revision: 'old-current' },
      checkpoint: { task: 'task', before: { ...blank, revision: 'old-before' }, appliedRevision: 'old-current' },
    }
    const legacyRows = [
      ['current', '["plugin","current"]', 'environment/KEY', 'old-current-environment'],
      ['current', '["plugin","current"]', 'entriesYaml', 'old-current-yaml'],
      ['current', '["plugin","current"]', 'entries/["main","key"]', 'old-current-entry'],
      ['before', '["plugin","before"]', 'environment/KEY', 'old-before-environment'],
      ['before', '["plugin","before"]', 'entriesYaml', 'old-before-yaml'],
      ['before', '["plugin","before"]', 'entries/["main","key"]', 'old-before-entry'],
    ] as const
    await database.query('INSERT INTO dsh_phalanx.plugin_access_settings(package_name,configuration,fields,commit_version) VALUES($1,$2,$3,1)', [
      'plugin',
      JSON.stringify(metadata),
      JSON.stringify(legacyRows.map(([scope, , field]) => ({ scope, field }))),
    ])
    for (const [scope, recordId, field, value] of legacyRows) {
      const envelope = database.cipher().encrypt({ table: 'plugin_access_secrets', recordId, field }, value)
      await database.query('INSERT INTO dsh_phalanx.plugin_access_secrets(package_name,scope,field,value) VALUES($1,$2,$3,$4)', [
        'plugin',
        scope,
        field,
        JSON.stringify(envelope),
      ])
    }
    const store = new PostgresPluginAccessStore(database)
    await store.initialize()
    expect(await store.get('plugin')).toEqual({
      revision: 'old-current',
      environment: [{ name: 'KEY', value: 'old-current-environment' }],
      entriesYaml: 'old-current-yaml',
      entries: { main: { key: 'old-current-entry' } },
    })
    expect((await store.suiteCheckpoint('plugin'))?.before).toEqual({
      revision: 'old-before',
      environment: [{ name: 'KEY', value: 'old-before-environment' }],
      entriesYaml: 'old-before-yaml',
      entries: { main: { key: 'old-before-entry' } },
    })
  } finally {
    await database.close()
    await rm(root, { recursive: true, force: true })
  }
})

it.each([false, true])('refuses a stale clear after another administrator commits access settings (existing=%s)', async existing => {
  const root = await mkdtemp(join(tmpdir(), 'access-clear-conflict-')),
    database = await openTestDatabase(root),
    store = new PostgresPluginAccessStore(database)
  let release!: () => void, entered!: () => void
  const waiting = new Promise<void>(resolve => {
      entered = resolve
    }),
    hold = new Promise<void>(resolve => {
      release = resolve
    })
  let clearing: Promise<unknown> | undefined
  try {
    await seedPluginParents(database)
    await store.initialize()
    const accounts = new PostgresCommunityAccountStore(database),
      actor = await accounts.createFirstAdmin({ username: 'admin', password: 'password', email: '' })
    if (existing) await store.save('plugin', { environment: [{ name: 'KEY', value: 'fictional-original-key' }], entriesYaml: '', entries: {} })
    const library = new PostgresPluginLibraryStore(database)
    const management = new PluginAccessAdministration(
      accounts,
      library,
      store,
      {
        list: async () => {
          entered()
          await hold
          return []
        },
      },
      new YamlPluginAccessSyntax(),
    )
    clearing = management.save(actor, 'plugin', { environment: [], entriesYaml: '', clearEntriesYaml: true })
    await waiting
    await store.save('plugin', { environment: [{ name: 'KEY', value: 'fictional-newer-key' }], entriesYaml: '', entries: {} })
    release()
    await expect(clearing).rejects.toMatchObject({ code: 'platform-configuration-conflict' })
    expect((await store.get('plugin'))?.environment).toEqual([{ name: 'KEY', value: 'fictional-newer-key' }])
  } finally {
    release?.()
    await Promise.allSettled(clearing ? [clearing] : [])
    await store.close()
    await database.close()
    await rm(root, { recursive: true, force: true })
  }
})
