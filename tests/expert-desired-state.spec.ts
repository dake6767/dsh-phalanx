import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { PostgresExpertStateQuery } from '../src/adapters/postgres-expert-state-query.js'
import type { PlatformDatabase } from '../src/adapters/platform-database.js'
import type { Expert } from '../src/domain/expert.js'
import { createExpertStorage } from '../src/composition/expert-storage.js'
import { openTestDatabase } from './support/community-application.js'
import { seedMcpParents } from './fixtures/mcp-parents.js'
import { cleanupOwned } from './fixtures/owned-cleanup.js'

it('invalidates authorization snapshots for every committed expert holding change', async () => {
  const root = await mkdtemp(join(tmpdir(), 'expert-authorization-version-'))
  let database: PlatformDatabase | undefined, store: ReturnType<typeof createExpertStorage> | undefined
  try {
    database = await openTestDatabase(root)
    store = createExpertStorage(database)
    await seedMcpParents(database, { groups: ['team'] })
    await store.initialize()
    const initial = store.view.version()
    await store.update(await store.read(), { revision: 0, experts: [], grants: { team: [] }, selections: {} })
    const granted = store.view.version()
    expect(granted).not.toBe(initial)
    expect((await store.read()).grants).toHaveProperty('team', [])
    await store.update(await store.read(), { revision: 0, experts: [], grants: {}, selections: {} })
    expect(store.view.version()).not.toBe(granted)
  } finally {
    await cleanupOwned(
      async () => store?.close(),
      async () => database?.close(),
      () => rm(root, { recursive: true, force: true }),
    )
  }
})

it('commits unrelated expert edits from the same snapshot and refuses a stale edit without overwriting the other owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'expert-independent-'))
  let database: PlatformDatabase | undefined, store: ReturnType<typeof createExpertStorage> | undefined
  try {
    database = await openTestDatabase(root)
    store = createExpertStorage(database)
    await store.initialize()
    const initial = await store.read(),
      definition: Expert = {
        id: 'first',
        name: 'First',
        description: 'Reports',
        icon: 'W',
        persona: 'Write.',
        revision: 1,
        published: true,
        skills: [],
        skillPacks: [],
        plugins: [],
        mcp: [],
        examples: [],
        model: null,
      }
    await store.update(initial, { ...initial, experts: [definition, { ...definition, id: 'second', name: 'Second' }] })
    const original = await store.read()
    const active = store
    await Promise.all(
      ['first', 'second'].map(id =>
        active.update(original, {
          ...original,
          experts: original.experts.map(row => (row.id === id ? { ...row, description: 'Edited ' + id, revision: 2 } : row)),
        }),
      ),
    )
    expect((await store.read()).experts).toMatchObject([
      { id: 'first', description: 'Edited first' },
      { id: 'second', description: 'Edited second' },
    ])
    await expect(
      store.update(original, { ...original, experts: original.experts.map(row => (row.id === 'first' ? { ...row, description: 'Stale' } : row)) }),
    ).rejects.toMatchObject({ code: 'expert-stale' })
    expect((await store.read()).experts[1]!.description).toBe('Edited second')
  } finally {
    await cleanupOwned(
      async () => store?.close(),
      async () => database?.close(),
      () => rm(root, { recursive: true, force: true }),
    )
  }
})

it('purges current selections on unpublish and rejects a late selection instead of reviving it on republish', async () => {
  const root = await mkdtemp(join(tmpdir(), 'expert-unpublish-'))
  let database: PlatformDatabase | undefined, store: ReturnType<typeof createExpertStorage> | undefined
  try {
    database = await openTestDatabase(root)
    store = createExpertStorage(database)
    await seedMcpParents(database, { spaces: ['member-space'] })
    await store.initialize()
    const initial = await store.read(),
      definition: Expert = {
        id: 'writer',
        name: 'Writer',
        description: 'Reports',
        icon: 'W',
        persona: 'Write.',
        revision: 1,
        published: true,
        skills: [],
        skillPacks: [],
        plugins: [],
        mcp: [],
        examples: [],
        model: null,
      }
    await store.update(initial, { ...initial, experts: [definition], selections: { 'member-space': [] } })
    const beforeChoice = await store.read()
    await store.update(beforeChoice, { ...beforeChoice, selections: { 'member-space': ['writer'] } })
    const published = await store.read()
    await store.update(published, { ...published, experts: published.experts.map(row => ({ ...row, revision: 2, published: false })) })
    expect((await store.read()).selections['member-space']).toEqual([])
    const late = { ...beforeChoice, selections: { 'member-space': ['writer'] } }
    await expect(store.update(beforeChoice, late)).rejects.toMatchObject({ code: 'expert-stale' })
    const current = await store.read()
    await store.update(current, { ...current, experts: current.experts.map(row => ({ ...row, revision: 3, published: true })) })
    expect((await store.read()).selections['member-space']).toEqual([])
  } finally {
    await cleanupOwned(
      async () => store?.close(),
      async () => database?.close(),
      () => rm(root, { recursive: true, force: true }),
    )
  }
})

it('fails the synchronous authorization view closed after a real committed publication fails, then reloads the committed facts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'expert-view-failure-'))
  let database: PlatformDatabase | undefined, store: ReturnType<typeof createExpertStorage> | undefined
  try {
    database = await openTestDatabase(root)
    store = createExpertStorage(database)
    await seedMcpParents(database, { groups: ['team'] })
    await store.initialize()
    const previous = store.view.version(),
      read = vi.spyOn(PostgresExpertStateQuery.prototype, 'read').mockRejectedValueOnce(Error('expert publication refused'))
    try {
      await expect(database.query("UPDATE dsh_phalanx.groups SET name='Renamed' WHERE id='team'")).rejects.toThrow('expert publication refused')
    } finally {
      read.mockRestore()
    }
    const view = store.view
    expect(() => view.read()).toThrow()
    expect(() => view.version()).toThrow()
    await store.initialize()
    // The group label is not a permission fact; reloading still restores a usable current fence.
    expect(store.view.version()).toBe(previous)
    expect(store.view.read()).toEqual(await store.read())
  } finally {
    await cleanupOwned(
      async () => store?.close(),
      async () => database?.close(),
      () => rm(root, { recursive: true, force: true }),
    )
  }
})
