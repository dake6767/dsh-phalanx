import { cleanupOwned } from './fixtures/owned-cleanup.js'
import { runtimeCommandLock } from '../src/adapters/advisory-locks.js'
import { runtimeVersion } from './fixtures/runtime-version.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { PostgresRuntimeFacts } from '../src/adapters/postgres-runtime-facts.js'
import { openTestDatabase } from './support/community-application.js'
import { PostgresRuntimeDependencyStore } from '../src/adapters/postgres-runtime-dependencies.js'
import { PostgresRuntimeReferences } from '../src/adapters/postgres-runtime-references.js'
import { PostgresExecutionLimits } from '../src/adapters/postgres-execution-limits.js'
import { PostgresUnitOfWork } from '../src/adapters/postgres-unit-of-work.js'
import { seedExecutionOwners } from './fixtures/execution-owners.js'
import { PostgresExecutionConfigurations } from '../src/adapters/postgres-execution-configurations.js'
import { PostgresPluginLibraryStore } from '../src/adapters/postgres-plugin-library.js'
import { PostgresSkillLibraryStore } from '../src/adapters/postgres-skill-library.js'
import { DEFAULT_EXECUTION_LIMITS } from '../src/domain/execution-control.js'

const dependency = (name: string) => ({
  name,
  prepareCommand: 'mkdir bin',
  pathDirectories: ['bin'],
  source: 'manual' as const,
  stage: 'preparing' as const,
  updatedAt: 1,
  log: '',
  checks: [],
})

it('reads dependency rows on demand, rejects stale updates and persists limits without a file carrier', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-rows-'))
  const database = await openTestDatabase(root)
  try {
    const store = new PostgresRuntimeDependencyStore(database),
      limits = new PostgresExecutionLimits(database)
    expect(await limits.get()).toEqual(DEFAULT_EXECUTION_LIMITS)
    await store.save(dependency('tools'))
    const previous = (await store.list())[0]!
    await new PostgresRuntimeDependencyStore(database).save({ ...previous, log: 'updated' })
    expect((await store.list())[0]?.log).toBe('updated')
    await expect(store.save({ ...previous, log: 'stale' })).rejects.toMatchObject({ code: 'runtime-dependency-unavailable' })
    await limits.save({ ...DEFAULT_EXECUTION_LIMITS, platformConcurrency: 3 })
    expect((await new PostgresExecutionLimits(database).get()).platformConcurrency).toBe(3)
    await store.remove('tools')
    expect(await new PostgresRuntimeDependencyStore(database).list()).toEqual([])
  } finally {
    try {
      await database.close()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})

it('rejects referenced dependency deletion with all owner names and permits deletion only after references retire', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-restrict-'))
  const database = await openTestDatabase(root)
  try {
    const store = new PostgresRuntimeDependencyStore(database),
      references = new PostgresRuntimeReferences(database)
    await store.save(dependency('tools'))
    await seedExecutionOwners(database, ['skill:skill-owner', 'skill:execution-owner'])
    const execution = new PostgresExecutionConfigurations(database)
    await execution.initialize()
    await execution.save('skill:execution-owner', { enabled: false, commands: [], variables: [] })
    const plugins = new PostgresPluginLibraryStore(database)
    await plugins.save({ packageName: '@fixture/plugin-owner', version: '1.0.0', stage: 'resolving', published: false, current: null })
    await database.query('INSERT INTO dsh_phalanx.mcp_services(name,configuration,generation,row_revision) VALUES($1,$2,1,$3)', [
      'p-mcp-owner',
      '{}',
      'fixture',
    ])
    const owners = [
      { kind: 'skill', name: 'skill-owner' },
      { kind: 'plugin', name: '@fixture/plugin-owner' },
      { kind: 'mcp', name: 'p-mcp-owner' },
      { kind: 'execution', name: 'skill:execution-owner' },
    ] as const
    for (const owner of owners) await references.replace(owner, ['tools'])
    await references.replace({ kind: 'mcp', name: 'p-mcp-owner' }, ['tools'], 'candidate')
    const before = await store.list()
    await expect(store.remove('tools')).rejects.toMatchObject({
      code: 'runtime-dependency-referenced',
      params: { references: expect.stringContaining('mcp: p-mcp-owner') },
    })
    expect(await store.list()).toEqual(before)
    expect(await references.list('tools')).toHaveLength(4)
    await new PostgresSkillLibraryStore(database).remove('skill-owner')
    await plugins.remove('@fixture/plugin-owner')
    await database.query('DELETE FROM dsh_phalanx.mcp_services WHERE name=$1', ['p-mcp-owner'])
    await execution.remove('skill:execution-owner')
    await execution.close()
    expect(await references.list('tools')).toEqual([])
    await store.remove('tools')
    expect(await store.list()).toEqual([])
    await store.save(dependency('other'))
    await expect(references.replace({ kind: 'skill', name: 'missing-parent' }, ['other'])).rejects.toMatchObject({ code: 'runtime-dependency-unavailable' })
    expect(await references.list('other')).toEqual([])
    expect(await references.list('tools')).toEqual([])
  } finally {
    try {
      await database.close()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})

it('rolls dependency metadata, references and execution limits back together', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-uow-'))
  const database = await openTestDatabase(root)
  try {
    const store = new PostgresRuntimeDependencyStore(database),
      references = new PostgresRuntimeReferences(database),
      limits = new PostgresExecutionLimits(database)
    await store.save(dependency('tools'))
    const before = await store.list()
    await seedExecutionOwners(database, ['skill:one'])
    const work = new PostgresUnitOfWork(database, {
      dependencies: tx => new PostgresRuntimeDependencyStore(tx),
      references: tx => new PostgresRuntimeReferences(tx),
      limits: tx => new PostgresExecutionLimits(tx),
    })
    await expect(
      work.run(async rows => {
        await rows.dependencies.save({ ...(await rows.dependencies.list())[0]!, log: 'uncommitted' })
        await rows.references.replace({ kind: 'skill', name: 'one' }, ['tools'])
        await rows.limits.save({ ...DEFAULT_EXECUTION_LIMITS, platformConcurrency: 3 })
        throw Error('rollback')
      }),
    ).rejects.toThrow('rollback')
    expect(await store.list()).toEqual(before)
    expect(await references.list('tools')).toEqual([])
    expect(await limits.get()).toEqual(DEFAULT_EXECUTION_LIMITS)
  } finally {
    try {
      await database.close()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})

it('publishes synchronous runtime fences before write returns, retains rollback facts and fails closed after publication failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-committed-facts-'))
  const database = await openTestDatabase(root)
  const facts = new PostgresRuntimeFacts(database)
  const rows = new PostgresRuntimeDependencyStore(database)
  let failedPublication: ReturnType<typeof vi.spyOn> | undefined
  try {
    await facts.initialize()
    const initial = facts.version()
    await rows.save({
      name: 'tools',
      prepareCommand: 'mkdir bin',
      pathDirectories: ['bin'],
      source: 'manual',
      stage: 'preparing',
      updatedAt: 0,
      checks: [],
      log: '',
    })
    expect(facts.list().map(row => row.name)).toEqual(['tools'])
    expect(facts.version()).not.toBe(initial)
    const committed = facts.version()
    await expect(
      database.transaction(async sql => {
        await new PostgresRuntimeDependencyStore({ sql, cipher: database.cipher() }).remove('tools')
        throw Error('rollback')
      }),
    ).rejects.toThrow('rollback')
    expect(facts.version()).toBe(committed)
    expect(facts.list()).toHaveLength(1)
    const beforePublication = (await rows.list())[0]!
    failedPublication = vi.spyOn(PostgresRuntimeDependencyStore.prototype, 'list').mockRejectedValueOnce(Error('publication unavailable'))
    await expect(rows.save({ ...beforePublication, log: 'committed update' })).rejects.toThrow('publication unavailable')
    expect(() => facts.list()).toThrow(expect.objectContaining({ code: 'unavailable' }))
    failedPublication.mockRestore()
    failedPublication = undefined
    expect((await rows.list())[0]?.log).toBe('committed update')
    await facts.initialize()
    expect(facts.list()[0]?.log).toBe('committed update')
  } finally {
    failedPublication?.mockRestore()
    try {
      await facts.close()
    } finally {
      try {
        await database.close()
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  }
})

it('serializes competing runtime command publications in PostgreSQL and preserves the shared Python exception', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-command-publication-'))
  const database = await openTestDatabase(root),
    rows = new PostgresRuntimeDependencyStore(database)
  let entered!: () => void, release!: () => void
  const locked = new Promise<void>(resolve => {
      entered = resolve
    }),
    gate = new Promise<void>(resolve => {
      release = resolve
    })
  let holder: Promise<void> | undefined, writes: PromiseSettledResult<void>[] | undefined
  const pending: Promise<void>[] = []
  try {
    await rows.save(dependency('one'))
    await rows.save(dependency('two'))
    const before = await rows.list()
    holder = database.transaction(async sql => {
      await sql.query(runtimeCommandLock, ['tool'])
      entered()
      await gate
    })
    await locked
    for (const row of before) pending.push(rows.save({ ...row, stage: 'ready', current: runtimeVersion(row.name === 'one' ? 'a' : 'b') }))
    const settled = Promise.allSettled(pending)
    await expect
      .poll(async () =>
        Number(
          (
            await database.query<{ count: string }>("SELECT count(*) AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory'")
          )[0]!.count,
        ),
      )
      .toBe(2)
    release()
    await holder
    writes = await settled
    expect(writes.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(writes.filter(result => result.status === 'rejected')).toMatchObject([{ reason: { code: 'command-conflict' } }])
    expect((await rows.list()).filter(row => row.current)).toHaveLength(1)
    const python = (name: string) => ({
      ...runtimeVersion('c'),
      commands: ['python3'],
      commandPaths: { python3: 'venv/bin/python3' },
      python: { name, interpreter: 'venv/bin/python3' as const, sitePackages: 'venv/lib/python3.11/site-packages', abi: 'cpython-311' },
    })
    await Promise.all(
      ['py-one', 'py-two'].map(name =>
        rows.save({ ...dependency(name), type: 'python-library', packages: ['fixture==1.0.0'], stage: 'ready', current: python(name) }),
      ),
    )
    expect((await rows.list()).filter(row => row.current?.python)).toHaveLength(2)
  } finally {
    release?.()
    await Promise.allSettled([...(holder ? [holder] : []), ...pending])
    await cleanupOwned(
      () => database.close(),
      () => rm(root, { recursive: true, force: true }),
    )
  }
})
