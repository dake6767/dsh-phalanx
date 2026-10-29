import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { PostgresExecutionConfigurations } from '../src/adapters/postgres-execution-configurations.js'
import { openTestDatabase } from './support/community-application.js'
import { PostgresRuntimeDependencyStore } from '../src/adapters/postgres-runtime-dependencies.js'
import { seedExecutionOwners } from './fixtures/execution-owners.js'
import { ExecutionAdministration } from '../src/use-cases/execution-administration.js'

async function configurationOf(store: PostgresExecutionConfigurations, owner: string) {
  const row = await store.get(owner)
  if (!row) return undefined
  const { rowRevision, ...configuration } = row
  void rowRevision
  return configuration
}
async function rowsOf(store: PostgresExecutionConfigurations) {
  return Promise.all((await store.list()).map(async row => ({ owner: row.owner, configuration: await configurationOf(store, row.owner) })))
}

it('reopens execution configuration with protected secret variables and intact nonsecret settings and ownership', async () => {
  const root = await mkdtemp(join(tmpdir(), 'postgres-execution-configuration-'))
  const database = await openTestDatabase(root),
    other = await openTestDatabase(root)
  const configuration = {
    enabled: true,
    commands: [{ command: 'scripts/run.py', blocked: ['print-key'] }],
    variables: [
      { name: 'PRIVATE_KEY', secret: true, value: 'fictional-execution-private-key' },
      { name: 'REGION', secret: false, value: 'region-one' },
    ],
    contributionReceipt: { id: 'contribution', revision: 'submission' },
    awaitingPreparation: true,
    approvedContribution: 'approval',
    suiteOrigin: 'suite:example',
    optionalVariables: ['REGION'],
    runtimeDependencies: ['python'],
  }
  try {
    const store = new PostgresExecutionConfigurations(database)
    await seedExecutionOwners(database, ['skill:example', 'skill:keep', 'skill:remove'])
    await store.initialize()
    expect(await configurationOf(store, 'skill:example')).toBeUndefined()
    await new PostgresRuntimeDependencyStore(database).save({
      name: 'python',
      prepareCommand: 'mkdir bin',
      pathDirectories: ['bin'],
      source: 'manual',
      stage: 'preparing',
      updatedAt: 0,
      checks: [],
      log: '',
    })
    await store.save('skill:example', configuration)
    expect(await configurationOf(store, 'skill:example')).toEqual(configuration)
    const rows =
      JSON.stringify(await database.query('SELECT * FROM dsh_phalanx.execution_configurations')) +
      JSON.stringify(await database.query('SELECT * FROM dsh_phalanx.execution_variables'))
    expect(rows).not.toContain('fictional-execution-private-key')
    expect(rows).toContain('region-one')
    expect(rows).toContain('PRIVATE_KEY')
    const reopened = new PostgresExecutionConfigurations(other)
    await reopened.initialize()
    expect(await configurationOf(reopened, 'skill:example')).toEqual(configuration)
    expect(await rowsOf(reopened)).toEqual([{ owner: 'skill:example', configuration }])
  } finally {
    await Promise.all([database.close(), other.close()])
    await rm(root, { recursive: true, force: true })
  }
})

it('waits for execution configuration COMMIT before refreshing projections or returning an administrator response', async () => {
  const root = await mkdtemp(join(tmpdir(), 'postgres-execution-response-'))
  const database = await openTestDatabase(root)
  let release!: () => void, pendingWrite: Promise<void> | undefined
  try {
    const store = new PostgresExecutionConfigurations(database)
    await seedExecutionOwners(database, ['skill:example', 'skill:keep', 'skill:remove'])
    await store.initialize()
    await store.save('skill:example', { enabled: false, commands: [], variables: [] })
    const actor = {
      username: 'admin',
      spaceId: 'space',
      sessionEpoch: 0,
      admin: true,
      disabled: false,
      groupId: 'admins',
      email: '',
      createdAt: 0,
      updatedAt: 0,
    }
    let entered!: () => void,
      completed = false,
      refreshed = false
    const began = new Promise<void>(resolve => {
        entered = resolve
      }),
      gate = new Promise<void>(resolve => {
        release = resolve
      })
    const holder = database.transaction(async sql => {
      await sql.query('SELECT owner FROM dsh_phalanx.execution_configurations WHERE owner=$1 FOR UPDATE', ['skill:example'])
      entered()
      await gate
    })
    await began
    const management = new ExecutionAdministration(
      { get: async () => actor },
      { get: id => ({ id, version: 'version' }), owns: async () => true },
      {
        get: store.get.bind(store),
        list: store.list.bind(store),
        remove: store.remove.bind(store),
        save: (owner, configuration) => {
          pendingWrite = store.save(owner, configuration)
          return pendingWrite
        },
      },
      async () => {
        refreshed = true
      },
    )
    const saving = management
      .save(actor, 'skill:example', { enabled: true, commands: [{ command: 'scripts/run.py', blocked: [] }], variables: [] })
      .then(result => {
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
      expect(refreshed).toBe(false)
      release()
      await holder
      expect((await saving).enabled).toBe(true)
      expect(refreshed).toBe(true)
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

it.each(['save', 'remove'] as const)('drains accepted execution %s work before closing and keeps the shared database open', async action => {
  const root = await mkdtemp(join(tmpdir(), 'postgres-execution-close-'))
  const database = await openTestDatabase(root),
    other = await openTestDatabase(root)
  let release!: () => void
  try {
    const store = new PostgresExecutionConfigurations(database)
    await seedExecutionOwners(database, ['skill:example', 'skill:keep', 'skill:remove'])
    await store.initialize()
    const configuration = { enabled: false, commands: [], variables: [] }
    await store.save('skill:example', configuration)
    let entered!: () => void,
      closed = false
    const began = new Promise<void>(resolve => {
        entered = resolve
      }),
      gate = new Promise<void>(resolve => {
        release = resolve
      })
    const holder = database.transaction(async sql => {
      await sql.query('SELECT owner FROM dsh_phalanx.execution_configurations WHERE owner=$1 FOR UPDATE', ['skill:example'])
      entered()
      await gate
    })
    await began
    const changed = { ...configuration, variables: [{ name: 'PRIVATE_KEY', secret: true, value: 'replacement-key' }] }
    const writing = action === 'save' ? store.save('skill:example', changed, await store.revision('skill:example')) : store.remove('skill:example')
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
      await expect(store.save('skill:new', configuration)).rejects.toThrow(/closed/u)
      await expect(store.remove('skill:example')).rejects.toThrow(/closed/u)
      expect(closed).toBe(false)
      release()
      await holder
      await writing
      await closing
      await expect(store.list()).rejects.toThrow(/closed/u)
      expect((await database.health()).state).toBe('connected')
      const reopened = new PostgresExecutionConfigurations(other)
      await reopened.initialize()
      expect(await configurationOf(reopened, 'skill:example')).toEqual(action === 'save' ? changed : undefined)
    } finally {
      release()
      await Promise.allSettled([holder, writing, closing])
    }
  } finally {
    release?.()
    await Promise.all([database.close(), other.close()])
    await rm(root, { recursive: true, force: true })
  }
})

it('retains committed execution configuration and variables when PostgreSQL rejects a save or pruning COMMIT', async () => {
  const root = await mkdtemp(join(tmpdir(), 'postgres-execution-commit-'))
  const database = await openTestDatabase(root),
    other = await openTestDatabase(root)
  try {
    const store = new PostgresExecutionConfigurations(database)
    await seedExecutionOwners(database, ['skill:example', 'skill:keep', 'skill:remove'])
    await store.initialize()
    const configuration = { enabled: false, commands: [], variables: [{ name: 'PRIVATE_KEY', secret: true, value: 'fictional-key' }] }
    await store.save('skill:example', configuration)
    const revision = await store.revision('skill:example')
    await database.query(`CREATE TABLE dsh_phalanx.commit_parents(id integer PRIMARY KEY);
      CREATE TABLE dsh_phalanx.commit_children(id integer REFERENCES dsh_phalanx.commit_parents(id) DEFERRABLE INITIALLY DEFERRED);
      CREATE FUNCTION dsh_phalanx.reject_execution_commit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN INSERT INTO dsh_phalanx.commit_children VALUES(42); RETURN NULL; END $$;
      CREATE TRIGGER reject_execution_commit AFTER INSERT OR UPDATE OR DELETE ON dsh_phalanx.execution_configurations FOR EACH ROW EXECUTE FUNCTION dsh_phalanx.reject_execution_commit();`)
    await expect(store.save('skill:example', { ...configuration, variables: [] }, revision)).rejects.toMatchObject({ code: 'query-failed', sqlState: '23503' })
    await expect(store.remove('skill:example')).rejects.toMatchObject({ code: 'query-failed', sqlState: '23503' })
    expect(await configurationOf(store, 'skill:example')).toEqual(configuration)
    expect(await store.revision('skill:example')).toBe(revision)
    const reopened = new PostgresExecutionConfigurations(other)
    await reopened.initialize()
    expect(await configurationOf(reopened, 'skill:example')).toEqual(configuration)
    expect(await reopened.revision('skill:example')).toBe(revision)
    await database.query('DROP TRIGGER reject_execution_commit ON dsh_phalanx.execution_configurations')
    await store.remove('skill:example')
    expect(await rowsOf(store)).toEqual([])
  } finally {
    await Promise.all([database.close(), other.close()])
    await rm(root, { recursive: true, force: true })
  }
})

it('prunes removed execution owners and their ciphertext without allowing a stale owner to resurrect them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'postgres-execution-retain-'))
  const database = await openTestDatabase(root),
    other = await openTestDatabase(root)
  try {
    const store = new PostgresExecutionConfigurations(database)
    await seedExecutionOwners(database, ['skill:example', 'skill:keep', 'skill:remove'])
    await store.initialize()
    const configuration = { enabled: false, commands: [], variables: [{ name: 'PRIVATE_KEY', secret: true, value: 'fictional-key' }] }
    await store.save('skill:keep', configuration)
    await store.save('skill:remove', configuration)
    const stale = new PostgresExecutionConfigurations(other)
    await stale.initialize()
    const removed = (await stale.get('skill:remove'))!
    await store.remove('skill:remove', removed.rowRevision)
    expect(await configurationOf(store, 'skill:remove')).toBeUndefined()
    expect(await store.revision('skill:remove')).toBe('none')
    expect(await configurationOf(store, 'skill:keep')).toEqual(configuration)
    expect(await database.query('SELECT * FROM dsh_phalanx.execution_variables WHERE owner=$1', ['skill:remove'])).toEqual([])
    await expect(stale.save('skill:remove', removed)).rejects.toMatchObject({ code: 'platform-configuration-conflict' })
    const reopened = new PostgresExecutionConfigurations(other)
    await reopened.initialize()
    expect(await rowsOf(reopened)).toEqual([{ owner: 'skill:keep', configuration }])
  } finally {
    await Promise.all([database.close(), other.close()])
    await rm(root, { recursive: true, force: true })
  }
})

it('rejects a stale execution owner instead of replacing a newer administrator configuration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'postgres-execution-stale-'))
  const database = await openTestDatabase(root),
    other = await openTestDatabase(root)
  try {
    const store = new PostgresExecutionConfigurations(database)
    await seedExecutionOwners(database, ['skill:example', 'skill:keep', 'skill:remove'])
    await store.initialize()
    const configuration = { enabled: false, commands: [], variables: [{ name: 'PRIVATE_KEY', secret: true, value: 'fictional-key' }] }
    await store.save('skill:example', configuration)
    const stale = new PostgresExecutionConfigurations(other)
    await stale.initialize()
    const original = (await stale.get('skill:example'))!
    const newer = { ...original, variables: [{ name: 'PRIVATE_KEY', secret: true, value: 'replacement-key' }] }
    await store.save('skill:example', newer)
    await expect(stale.save('skill:example', { ...original, variables: [] })).rejects.toMatchObject({
      kind: 'conflict',
      code: 'platform-configuration-conflict',
    })
    expect(await configurationOf(stale, 'skill:example')).toEqual({ ...configuration, variables: newer.variables })
    const reopened = new PostgresExecutionConfigurations(other)
    await reopened.initialize()
    expect(await configurationOf(reopened, 'skill:example')).toEqual({ ...configuration, variables: newer.variables })
  } finally {
    await Promise.all([database.close(), other.close()])
    await rm(root, { recursive: true, force: true })
  }
})

it('retains a stable execution revision across a reopen and changes it when the configuration changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'postgres-execution-revision-'))
  const database = await openTestDatabase(root),
    other = await openTestDatabase(root)
  try {
    const store = new PostgresExecutionConfigurations(database)
    await seedExecutionOwners(database, ['skill:example', 'skill:keep', 'skill:remove'])
    await store.initialize()
    expect(await store.revision('skill:example')).toBe('none')
    const configuration = { enabled: false, commands: [], variables: [{ name: 'PRIVATE_KEY', secret: true, value: 'fictional-key' }] }
    await store.save('skill:example', configuration)
    const revision = await store.revision('skill:example')
    expect(revision).not.toBe('none')
    const reopened = new PostgresExecutionConfigurations(other)
    await reopened.initialize()
    expect(await reopened.revision('skill:example')).toBe(revision)
    await reopened.save('skill:example', (await reopened.get('skill:example'))!)
    expect(await reopened.revision('skill:example')).toBe(revision)
    await reopened.save('skill:example', {
      ...(await reopened.get('skill:example'))!,
      variables: [{ name: 'PRIVATE_KEY', secret: true, value: 'replacement-key' }],
    })
    expect(await reopened.revision('skill:example')).not.toBe(revision)
  } finally {
    await Promise.all([database.close(), other.close()])
    await rm(root, { recursive: true, force: true })
  }
})
