import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { RuntimeDependency } from '../src/domain/runtime-dependency.js'
import { RuntimeDependencyManaged } from '../src/use-cases/runtime-dependency-managed.js'
import { PostgresRuntimeDependencyStore } from '../src/adapters/postgres-runtime-dependencies.js'
import { PostgresSkillLibraryStore } from '../src/adapters/postgres-skill-library.js'
import { PostgresRuntimeReferences } from '../src/adapters/postgres-runtime-references.js'
import { PostgresUnitOfWork } from '../src/adapters/postgres-unit-of-work.js'
import { openTestDatabase } from './support/community-application.js'
import { runtimeVersion } from './fixtures/runtime-version.js'

it('keeps managed registration and promotion side effects outside the shared transaction and preserves rollback facts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'managed-runtime-uow-'))
  const database = await openTestDatabase(root)
  const requests: string[] = [],
    cancellations: string[] = []
  try {
    const rows = new PostgresRuntimeDependencyStore(database),
      references = new PostgresRuntimeReferences(database)
    const managed = new RuntimeDependencyManaged(
      rows,
      {
        isolated: true,
        identity: input => input.prepareCommand,
        recover: async () => {},
        collect: async () => {},
        prepare: async () => {
          throw Error('External preparation must not run in a transaction')
        },
      },
      { now: () => 0 },
      references,
      {
        started: true,
        stopped: false,
        active: () => undefined,
        request: async row => {
          requests.push(row.name)
        },
        supersede: name => {
          cancellations.push(name)
        },
        collect: async () => {},
        changed: async () => {},
      },
    )
    const work = new PostgresUnitOfWork(database, { runtime: tx => new PostgresRuntimeDependencyStore(tx) })
    await expect(
      work.run(async repositories => {
        const scope = managed.transaction(repositories.runtime)
        await scope.mutations.registerManaged('mcp:tool', { name: 'tool', prepareCommand: 'install', pathDirectories: ['bin'] }, 'mcp-catalog')
        throw Error('rollback')
      }),
    ).rejects.toThrow('rollback')
    expect(await rows.list()).toEqual([])
    expect(requests).toEqual([])
    const registered = await work.run(async repositories => {
      const scope = managed.transaction(repositories.runtime)
      await scope.mutations.registerManaged('mcp:tool', { name: 'tool', prepareCommand: 'install', pathDirectories: ['bin'] }, 'mcp-catalog')
      return scope
    })
    expect(requests).toEqual([])
    registered.committed()
    await managed.resume()
    expect(requests).toEqual(['tool'])
    const base = {
      prepareCommand: 'install',
      pathDirectories: ['bin'],
      source: 'mcp-catalog' as const,
      stage: 'ready' as const,
      updatedAt: 0,
      log: '',
      checks: [],
    }
    await rows.save({ ...base, name: 'stable', managedOrigin: 'mcp:stable', current: runtimeVersion('a'), preparationIdentity: 'stable' })
    const initial = (await rows.list()).find(row => row.name === 'stable')!
    await rows.save({ ...initial, log: 'second owner revision' })
    await rows.save({
      ...base,
      name: 'candidate',
      managedOrigin: 'mcp:candidate',
      candidate: true,
      replaces: 'stable',
      current: runtimeVersion('b'),
      preparationIdentity: 'candidate',
    })
    const before = await rows.list()
    await expect(
      work.run(async repositories => {
        const scope = managed.transaction(repositories.runtime)
        await scope.mutations.promoteManaged('candidate', 'stable')
        throw Error('rollback promotion')
      }),
    ).rejects.toThrow('rollback promotion')
    expect(cancellations).toEqual([])
    expect(await rows.list()).toEqual(before)
    const promoted = await work.run(async repositories => {
      const scope = managed.transaction(repositories.runtime)
      await scope.mutations.promoteManaged('candidate', 'stable')
      return scope
    })
    expect(cancellations).toEqual([])
    expect((await rows.list()).find(row => row.name === 'stable')).toMatchObject({ current: runtimeVersion('b'), previous: runtimeVersion('a') })
    promoted.committed()
    expect(cancellations).toEqual(['stable'])
  } finally {
    try {
      await database.close()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})

it('resumes a newly registered managed definition only after startup and without duplicating an active preparation', async () => {
  const rows = new Map<string, RuntimeDependency>()
  let started = false,
    active = false
  const request = vi.fn(async () => {
    active = true
  })
  const managed = new RuntimeDependencyManaged(
    {
      list: async () => structuredClone([...rows.values()]),
      save: async row => {
        rows.set(row.name, structuredClone(row))
      },
      remove: async name => {
        rows.delete(name)
      },
    },
    {
      isolated: true,
      identity: input => input.prepareCommand,
      recover: async () => {},
      collect: async () => {},
      prepare: async () => {
        throw Error('Managed registration only records facts')
      },
    },
    { now: () => 0 },
    { list: async () => [] },
    {
      get started() {
        return started
      },
      stopped: false,
      active: () => (active ? Promise.resolve() : undefined),
      request,
      supersede: () => {},
      collect: async () => {},
      changed: async () => {},
    },
  )
  await managed.registerManaged('mcp:tool', { name: 'tool', prepareCommand: 'install', pathDirectories: ['bin'] }, 'mcp-catalog')
  await managed.resume()
  expect(request).not.toHaveBeenCalled()
  started = true
  await managed.resume()
  await managed.resume()
  expect(request).toHaveBeenCalledTimes(1)
  expect(rows.get('tool')).toMatchObject({ managedOrigin: 'mcp:tool', stage: 'preparing' })
})

it('commits suite runtime changes with bound references and no external callbacks before COMMIT', async () => {
  const root = await mkdtemp(join(tmpdir(), 'suite-runtime-uow-')),
    database = await openTestDatabase(root)
  const external = vi.fn(async () => {}),
    cancellations: string[] = []
  try {
    const rows = new PostgresRuntimeDependencyStore(database),
      references = new PostgresRuntimeReferences(database)
    const managed = new RuntimeDependencyManaged(
      rows,
      {
        isolated: true,
        identity: input => input.prepareCommand,
        recover: external,
        collect: external,
        prepare: async () => {
          throw Error('No external preparation in the transaction')
        },
      },
      { now: () => 1 },
      references,
      {
        started: true,
        stopped: false,
        active: () => undefined,
        request: external,
        supersede: name => {
          cancellations.push(name)
        },
        collect: external,
        changed: external,
      },
    )
    const work = new PostgresUnitOfWork(database, {
      runtime: tx => new PostgresRuntimeDependencyStore(tx),
      library: tx => new PostgresSkillLibraryStore(tx),
      references: tx => new PostgresRuntimeReferences(tx),
    })
    const input = { name: 'suite-tool', prepareCommand: 'prepare', pathDirectories: ['bin'] }
    const commit = () =>
      work.run(async tx => {
        const scope = managed.transaction(tx.runtime, tx.references)
        await scope.mutations.commitManaged('suite:fixture', input, runtimeVersion('a'))
        expect(external).not.toHaveBeenCalled()
        return scope
      })
    await expect(
      work.run(async tx => {
        const scope = managed.transaction(tx.runtime, tx.references)
        await scope.mutations.commitManaged('suite:fixture', input, runtimeVersion('a'))
        throw Error('reject suite')
      }),
    ).rejects.toThrow('reject suite')
    expect(await rows.list()).toEqual([])
    expect(external).not.toHaveBeenCalled()
    await commit()
    const before = await rows.list()
    await expect(
      work.run(async tx => {
        const scope = managed.transaction(tx.runtime, tx.references)
        await scope.mutations.updateManaged('suite:fixture', input.name, input, runtimeVersion('b'))
        throw Error('reject update')
      }),
    ).rejects.toThrow('reject update')
    expect(await rows.list()).toEqual(before)
    await new PostgresSkillLibraryStore(database).save({
      name: 'reader',
      description: 'Reader',
      hash: 'a'.repeat(64),
      importedAt: 1,
      published: false,
      runtimeDependencies: ['suite-tool'],
    })
    const removed = await work.run(async tx => {
      const skill = (await tx.library.list())[0]!
      await tx.library.remove(skill.name, skill.rowRevision)
      const scope = managed.transaction(tx.runtime, tx.references)
      await scope.mutations.removeManaged('suite:fixture')
      expect(external).not.toHaveBeenCalled()
      expect(cancellations).toEqual([])
      return scope
    })
    expect(await rows.list()).toEqual([])
    removed.committed()
    expect(cancellations).toEqual(['suite-tool'])
    expect(external).not.toHaveBeenCalled()
  } finally {
    await database.close()
    await rm(root, { recursive: true, force: true })
  }
})
