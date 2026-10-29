import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { PostgresExecutionConfigurations } from '../src/adapters/postgres-execution-configurations.js'
import { PostgresRuntimeDependencyStore } from '../src/adapters/postgres-runtime-dependencies.js'
import { PostgresRuntimeReferences } from '../src/adapters/postgres-runtime-references.js'
import { PostgresUnitOfWork } from '../src/adapters/postgres-unit-of-work.js'
import { createRuntimeStorage } from '../src/composition/runtime-storage.js'
import { ExecutionAdministration } from '../src/use-cases/execution-administration.js'
import { seedExecutionOwners } from './fixtures/execution-owners.js'
import { cleanupOwned } from './fixtures/owned-cleanup.js'
import { openTestDatabase } from './support/community-application.js'

it('reads execution variables encrypted with the independent original table, record and field spelling', async () => {
  const root = await mkdtemp(join(tmpdir(), 'execution-old-aad-'))
  const database = await openTestDatabase(root)
  const store = new PostgresExecutionConfigurations(database)
  try {
    await seedExecutionOwners(database, ['skill:legacy'])
    // These literals are frozen independently of every execution-store writer and context helper.
    const value = database.cipher().encrypt({ table: 'execution_variables', recordId: '["skill:legacy","TOKEN"]', field: 'value' }, 'original-execution-value')
    await database.query('INSERT INTO dsh_phalanx.execution_configurations(owner,revision,configuration,source_skill) VALUES($1,$2,$3,$4)', [
      'skill:legacy',
      'old-revision',
      JSON.stringify({
        enabled: false,
        commands: [],
        variables: [
          { name: 'TOKEN', secret: true },
          { name: 'REGION', secret: false, value: 'region' },
        ],
      }),
      'legacy',
    ])
    await database.query('INSERT INTO dsh_phalanx.execution_variables(owner,name,value) VALUES($1,$2,$3)', ['skill:legacy', 'TOKEN', JSON.stringify(value)])
    await store.initialize()
    expect((await store.get('skill:legacy'))?.variables).toEqual([
      { name: 'TOKEN', secret: true, value: 'original-execution-value' },
      { name: 'REGION', secret: false, value: 'region' },
    ])
  } finally {
    try {
      await store.close()
    } finally {
      try {
        await database.close()
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  }
})

it('changes only its owner and changed variables, keeps references atomic and refuses a stale owner version', async () => {
  const root = await mkdtemp(join(tmpdir(), 'execution-row-writes-'))
  const database = await openTestDatabase(root)
  const store = new PostgresExecutionConfigurations(database),
    other = new PostgresExecutionConfigurations(database)
  try {
    await seedExecutionOwners(database, ['skill:one', 'skill:two', 'skill:first-command', 'skill:second-command'])
    await store.initialize()
    await other.initialize()
    await new PostgresRuntimeDependencyStore(database).save({
      name: 'tools',
      prepareCommand: 'mkdir bin',
      pathDirectories: ['bin'],
      source: 'manual',
      stage: 'preparing',
      updatedAt: 0,
      checks: [],
      log: '',
    })
    await store.save('skill:one', {
      enabled: false,
      commands: [],
      runtimeDependencies: ['tools'],
      variables: [{ name: 'TOKEN', secret: true, value: 'retained-value' }],
    })
    const before = await store.get('skill:one')
    expect(before?.rowRevision).toBeTypeOf('string')
    const envelope = await database.query('SELECT value FROM dsh_phalanx.execution_variables WHERE owner=$1 AND name=$2', ['skill:one', 'TOKEN'])
    await other.save('skill:two', { enabled: false, commands: [], variables: [] })
    await store.save('skill:one', { ...before!, commands: [{ command: 'one', blocked: [] }] })
    expect(await database.query('SELECT value FROM dsh_phalanx.execution_variables WHERE owner=$1 AND name=$2', ['skill:one', 'TOKEN'])).toEqual(envelope)
    expect(await new PostgresRuntimeReferences(database).list('tools')).toEqual([{ kind: 'execution', name: 'skill:one' }])
    await expect(store.save('skill:one', { ...before!, enabled: true, commands: [{ command: 'stale', blocked: [] }] })).rejects.toMatchObject({
      code: 'platform-configuration-conflict',
    })
    const shared = (await store.get('skill:one'))!
    const contenders = await Promise.allSettled([
      store.save('skill:one', { ...shared, variables: [{ name: 'TOKEN', secret: true, value: 'first-writer' }], runtimeDependencies: [] }),
      other.save('skill:one', { ...shared, variables: [{ name: 'TOKEN', secret: true, value: 'second-writer' }], runtimeDependencies: ['tools'] }),
    ])
    expect(contenders.filter(row => row.status === 'fulfilled')).toHaveLength(1)
    expect(contenders.filter(row => row.status === 'rejected').map(row => row.reason)).toEqual([
      expect.objectContaining({ code: 'platform-configuration-conflict' }),
    ])
    const winner = (await store.get('skill:one'))!
    expect(winner.variables[0]?.value).toBe(contenders[0]?.status === 'fulfilled' ? 'first-writer' : 'second-writer')
    expect(winner.runtimeDependencies).toEqual(contenders[0]?.status === 'fulfilled' ? [] : ['tools'])
    const owners = ['skill:first-command', 'skill:second-command']
    const delegation = await Promise.allSettled(
      owners.map(owner =>
        store.save(owner, {
          enabled: true,
          commands: [{ command: 'shared-command', blocked: [] }],
          variables: [],
        }),
      ),
    )
    expect(delegation.filter(row => row.status === 'fulfilled')).toHaveLength(1)
    expect(delegation.filter(row => row.status === 'rejected').map(row => row.reason)).toEqual([expect.objectContaining({ code: 'execution-config-invalid' })])
    expect((await store.list()).filter(row => owners.includes(row.owner))).toHaveLength(1)
    const current = (await other.get('skill:one'))!
    await other.remove('skill:one', current.rowRevision)
    expect(await store.get('skill:one')).toBeUndefined()
    expect(await store.get('skill:two')).toBeDefined()
    expect(await new PostgresRuntimeReferences(database).list('tools')).toEqual([])
  } finally {
    try {
      await Promise.all([store.close(), other.close()])
    } finally {
      try {
        await database.close()
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  }
})

it('rolls configuration, variable and reference changes back in a shared unit of work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'execution-row-uow-'))
  const database = await openTestDatabase(root)
  const store = new PostgresExecutionConfigurations(database)
  try {
    await seedExecutionOwners(database, ['skill:one'])
    await store.initialize()
    await new PostgresRuntimeDependencyStore(database).save({
      name: 'tools',
      prepareCommand: 'mkdir bin',
      pathDirectories: ['bin'],
      source: 'manual',
      stage: 'preparing',
      updatedAt: 0,
      checks: [],
      log: '',
    })
    await store.save('skill:one', { enabled: false, commands: [], variables: [{ name: 'TOKEN', secret: true, value: 'before' }] })
    const before = await store.get('skill:one')
    const work = new PostgresUnitOfWork(database, { execution: tx => new PostgresExecutionConfigurations(tx) })
    await expect(
      work.run(async rows => {
        await rows.execution.save('skill:one', { ...before!, runtimeDependencies: ['tools'], variables: [{ name: 'TOKEN', secret: true, value: 'after' }] })
        throw Error('rollback')
      }),
    ).rejects.toThrow('rollback')
    expect(await store.get('skill:one')).toEqual(before)
    expect(await new PostgresRuntimeReferences(database).list('tools')).toEqual([])
  } finally {
    try {
      await store.close()
    } finally {
      try {
        await database.close()
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  }
})

it('cannot create execution configuration or references after its source skill was deleted during admission', async () => {
  const root = await mkdtemp(join(tmpdir(), 'execution-owner-deletion-'))
  const database = await openTestDatabase(root)
  const store = new PostgresExecutionConfigurations(database)
  let release!: () => void
  let deleting: Promise<void> | undefined, saving: Promise<void> | undefined
  try {
    await seedExecutionOwners(database, ['skill:removed'])
    await store.initialize()
    await new PostgresRuntimeDependencyStore(database).save({
      name: 'tools',
      prepareCommand: 'mkdir bin',
      pathDirectories: ['bin'],
      source: 'manual',
      stage: 'preparing',
      updatedAt: 0,
      log: '',
      checks: [],
    })
    let entered!: () => void
    const began = new Promise<void>(resolve => {
      entered = resolve
    })
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    deleting = database.transaction(async sql => {
      await sql.query('DELETE FROM dsh_phalanx.skills WHERE name=$1', ['removed'])
      entered()
      await gate
    })
    await began
    saving = store.save('skill:removed', {
      enabled: false,
      commands: [],
      runtimeDependencies: ['tools'],
      variables: [{ name: 'TOKEN', secret: true, value: 'must-not-survive' }],
    })
    const refused = expect(saving).rejects.toMatchObject({ code: 'skill-unavailable' })
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
    release()
    await deleting
    await refused
    expect(await store.get('skill:removed')).toBeUndefined()
    expect(await database.query('SELECT * FROM dsh_phalanx.execution_variables')).toEqual([])
    expect(await new PostgresRuntimeReferences(database).list('tools')).toEqual([])
    await seedExecutionOwners(database, ['skill:survivor'])
    await store.save('skill:survivor', {
      enabled: false,
      commands: [],
      runtimeDependencies: ['tools'],
      variables: [{ name: 'TOKEN', secret: true, value: 'retire-with-owner' }],
    })
    await database.query('DELETE FROM dsh_phalanx.skills WHERE name=$1', ['survivor'])
    expect(await store.get('skill:survivor')).toBeUndefined()
    expect(await database.query('SELECT * FROM dsh_phalanx.execution_variables')).toEqual([])
    expect(await new PostgresRuntimeReferences(database).list('tools')).toEqual([])
  } finally {
    release?.()
    await Promise.allSettled([deleting, saving])
    try {
      await store.close()
    } finally {
      try {
        await database.close()
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  }
})

it('rolls a multi-owner suite takeover back when the target configuration fails at COMMIT', async () => {
  const root = await mkdtemp(join(tmpdir(), 'execution-takeover-uow-'))
  const database = await openTestDatabase(root),
    storage = createRuntimeStorage(database)
  const changed = vi.fn(async () => {})
  try {
    await seedExecutionOwners(database, ['skill:manual', 'skill:target', 'skill:unrelated'])
    await storage.initialize()
    const owner = (id: string) => ({ id, version: 'fixture-version' })
    const administration = new ExecutionAdministration(
      { get: async () => undefined },
      { get: owner, owns: async () => true },
      storage.execution,
      changed,
      undefined,
      undefined,
      undefined,
      storage.work,
    )
    await storage.execution.save('skill:manual', {
      enabled: true,
      commands: [{ command: 'shared', blocked: [] }],
      variables: [{ name: 'TOKEN', secret: true, value: 'manual-token' }],
    })
    await storage.execution.save('skill:unrelated', { enabled: true, commands: [{ command: 'other', blocked: [] }], variables: [] })
    const before = await storage.execution.list(),
      replacement = (await administration.suiteExecutionSnapshot('skill:manual'))!
    await database.query(`CREATE TABLE dsh_phalanx.reject_execution_parent(id integer PRIMARY KEY);
      CREATE TABLE dsh_phalanx.reject_execution_child(id integer REFERENCES dsh_phalanx.reject_execution_parent DEFERRABLE INITIALLY DEFERRED);
      CREATE FUNCTION dsh_phalanx.reject_execution() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN INSERT INTO dsh_phalanx.reject_execution_child VALUES(1); RETURN NULL; END $$;
      CREATE TRIGGER reject_execution AFTER INSERT ON dsh_phalanx.execution_configurations FOR EACH ROW
        WHEN (NEW.owner='skill:target') EXECUTE FUNCTION dsh_phalanx.reject_execution();`)
    const template = { commands: [{ command: 'shared', blocked: [] }], variables: ['TOKEN'], runtimeDependencies: [] }
    await expect(administration.commitSuiteExecution('suite:fixture', 'skill:target', template, {}, [replacement])).rejects.toMatchObject({ sqlState: '23503' })
    expect(await storage.execution.list()).toEqual(before)
    expect(changed).not.toHaveBeenCalled()
    await database.query('DROP TRIGGER reject_execution ON dsh_phalanx.execution_configurations')
    await administration.commitSuiteExecution('suite:fixture', 'skill:target', template, {}, [replacement])
    expect(await storage.execution.get('skill:manual')).toMatchObject({ enabled: false, suiteOrigin: 'suite:fixture' })
    expect(await storage.execution.get('skill:target')).toMatchObject({
      enabled: true,
      suiteOrigin: 'suite:fixture',
      variables: [{ name: 'TOKEN', value: 'manual-token' }],
    })
    expect(await storage.execution.get('skill:unrelated')).toEqual(before.find(row => row.owner === 'skill:unrelated')?.configuration)
    expect(changed).toHaveBeenCalledTimes(1)
  } finally {
    await cleanupOwned(
      () => storage.close(),
      () => database.close(),
      () => rm(root, { recursive: true, force: true }),
    )
  }
})

it('lets a source deletion finish after a transaction reads its configuration, then refuses the late save without a lock cycle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'execution-read-delete-order-'))
  const database = await openTestDatabase(root),
    storage = createRuntimeStorage(database)
  let read!: () => void, continueSave!: () => void, parentLocked!: () => void, continueDelete!: () => void
  const reading = new Promise<void>(resolve => {
      read = resolve
    }),
    saveGate = new Promise<void>(resolve => {
      continueSave = resolve
    }),
    locked = new Promise<void>(resolve => {
      parentLocked = resolve
    }),
    deleteGate = new Promise<void>(resolve => {
      continueDelete = resolve
    })
  let updating: Promise<void> | undefined, deleting: Promise<void> | undefined
  try {
    await seedExecutionOwners(database, ['skill:ordered'])
    await storage.initialize()
    await storage.execution.save('skill:ordered', { enabled: false, commands: [], variables: [] })
    updating = storage.work.run(async rows => {
      const snapshot = (await rows.execution.get('skill:ordered'))!
      read()
      await saveGate
      await rows.execution.save('skill:ordered', { ...snapshot, enabled: true })
    })
    const updated = Promise.allSettled([updating])
    await reading
    deleting = database.transaction(async sql => {
      await sql.query("SELECT name FROM dsh_phalanx.skills WHERE name='ordered' FOR UPDATE")
      parentLocked()
      await deleteGate
      await sql.query("DELETE FROM dsh_phalanx.skills WHERE name='ordered'")
    })
    await locked
    continueSave()
    await expect
      .poll(async () =>
        Number(
          (
            await database.query<{ count: string }>(
              "SELECT count(*) AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'",
            )
          )[0]!.count,
        ),
      )
      .toBeGreaterThan(0)
    continueDelete()
    await expect(deleting).resolves.toBeUndefined()
    expect(await updated).toMatchObject([{ status: 'rejected', reason: { code: 'skill-unavailable' } }])
    expect(await storage.execution.get('skill:ordered')).toBeUndefined()
  } finally {
    continueSave?.()
    continueDelete?.()
    await Promise.allSettled([...(updating ? [updating] : []), ...(deleting ? [deleting] : [])])
    await cleanupOwned(
      () => storage.close(),
      () => database.close(),
      () => rm(root, { recursive: true, force: true }),
    )
  }
})
it('rejects a stale writer waiting on a configuration lock before decoding a newly added secret', async () => {
  const root = await mkdtemp(join(tmpdir(), 'execution-revision-lock-wait-'))
  const database = await openTestDatabase(root),
    storage = createRuntimeStorage(database)
  let entered!: () => void, release!: () => void
  const locked = new Promise<void>(resolve => {
      entered = resolve
    }),
    gate = new Promise<void>(resolve => {
      release = resolve
    })
  let writer: Promise<void> | undefined, stale: Promise<void> | undefined
  try {
    await seedExecutionOwners(database, ['skill:secret-wait'])
    await storage.initialize()
    await storage.execution.save('skill:secret-wait', { enabled: false, commands: [], variables: [] })
    const before = (await storage.execution.get('skill:secret-wait'))!
    writer = storage.work.run(async rows => {
      await rows.execution.save('skill:secret-wait', { ...before, variables: [{ name: 'NEW_TOKEN', secret: true, value: 'new-private-value' }] })
      entered()
      await gate
    })
    await locked
    stale = storage.execution.save('skill:secret-wait', { ...before, enabled: true })
    const rejected = expect(stale).rejects.toMatchObject({ code: 'platform-configuration-conflict' })
    await expect
      .poll(async () =>
        Number(
          (
            await database.query<{ count: string }>(
              "SELECT count(*) AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'",
            )
          )[0]!.count,
        ),
      )
      .toBeGreaterThan(0)
    release()
    await writer
    await rejected
    expect(await storage.execution.get('skill:secret-wait')).toMatchObject({ enabled: false, variables: [{ name: 'NEW_TOKEN', value: 'new-private-value' }] })
  } finally {
    release?.()
    await Promise.allSettled([...(writer ? [writer] : []), ...(stale ? [stale] : [])])
    await cleanupOwned(
      () => storage.close(),
      () => database.close(),
      () => rm(root, { recursive: true, force: true }),
    )
  }
})

it('does not overwrite a first configuration created between an absent-row lock query and the following read', async () => {
  const root = await mkdtemp(join(tmpdir(), 'execution-first-writer-gap-'))
  const database = await openTestDatabase(root),
    storage = createRuntimeStorage(database)
  let entered!: () => void, release!: () => void
  const absent = new Promise<void>(resolve => {
      entered = resolve
    }),
    gate = new Promise<void>(resolve => {
      release = resolve
    })
  let pending: Promise<void> | undefined
  try {
    await seedExecutionOwners(database, ['skill:new-race'])
    await storage.initialize()
    const work = new PostgresUnitOfWork(database, {
      execution: tx =>
        new PostgresExecutionConfigurations({
          cipher: tx.cipher,
          sql: {
            query: async <Row extends import('pg').QueryResultRow>(text: string, values: readonly unknown[] = []) => {
              const rows = await tx.sql.query<Row>(text, values)
              if (text === 'SELECT revision FROM dsh_phalanx.execution_configurations WHERE owner=$1 FOR UPDATE' && !rows.length) {
                entered()
                await gate
              }
              return rows
            },
          },
        }),
    })
    pending = work.run(rows => rows.execution.save('skill:new-race', { enabled: false, commands: [], variables: [] }))
    const rejected = expect(pending).rejects.toMatchObject({ code: 'platform-configuration-conflict' })
    await absent
    await storage.execution.save('skill:new-race', {
      enabled: true,
      commands: [{ command: 'winning', blocked: [] }],
      variables: [{ name: 'TOKEN', secret: true, value: 'winning-value' }],
    })
    release()
    await rejected
    expect(await storage.execution.get('skill:new-race')).toMatchObject({ enabled: true, variables: [{ name: 'TOKEN', value: 'winning-value' }] })
  } finally {
    release?.()
    await Promise.allSettled(pending ? [pending] : [])
    await cleanupOwned(
      () => storage.close(),
      () => database.close(),
      () => rm(root, { recursive: true, force: true }),
    )
  }
})
