import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { RuntimeDependencyPreparation } from '../src/use-cases/runtime-dependency-preparation.js'
import { PostgresRuntimeDependencyStore } from '../src/adapters/postgres-runtime-dependencies.js'
import { PostgresRuntimeReferences } from '../src/adapters/postgres-runtime-references.js'
import type { RuntimeDependencyPreparerPort } from '../src/ports/runtime-dependencies.js'
import type { RuntimeDependency, RuntimeDependencyVersion } from '../src/domain/runtime-dependency.js'
import { openTestDatabase } from './support/community-application.js'
import { runtimeVersion } from './fixtures/runtime-version.js'

it('refuses progress and results after a different preparation ownership commits before local cancellation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runtime-preparation-owner-'))
  const database = await openTestDatabase(root)
  let release!: (version: RuntimeDependencyVersion) => void, entered!: () => void
  let progress!: Parameters<RuntimeDependencyPreparerPort['prepare']>[1]
  const began = new Promise<void>(resolve => {
    entered = resolve
  })
  const retained: string[][] = []
  const rows = new PostgresRuntimeDependencyStore(database)
  const preparation = new RuntimeDependencyPreparation(
    rows,
    {
      isolated: true,
      identity: () => 'old-preparation',
      recover: async () => {},
      collect: async names => {
        retained.push([...names])
      },
      prepare: async (_input, output) => {
        progress = output
        entered()
        return new Promise(resolve => {
          release = resolve
        })
      },
    },
    { now: () => 0 },
    new PostgresRuntimeReferences(database),
    async () => {},
  )
  let pending: Promise<void> | undefined
  try {
    await rows.save({
      name: 'tool',
      prepareCommand: 'install',
      pathDirectories: ['bin'],
      source: 'manual',
      stage: 'ready',
      current: runtimeVersion('a'),
      updatedAt: 0,
      checks: [],
      log: '',
      preparationIdentity: 'before',
    })
    pending = preparation.request((await rows.list())[0]!)
    await began
    await rows.save({
      ...(await rows.list())[0]!,
      stage: 'ready',
      current: runtimeVersion('b'),
      preparationIdentity: 'promoted-preparation',
      log: 'promoted summary',
    })
    await expect(progress('obsolete preparation output')).rejects.toMatchObject({ name: 'AbortError' })
    release(runtimeVersion('a'))
    await pending
    expect((await rows.list())[0]).toMatchObject({
      stage: 'ready',
      current: runtimeVersion('b'),
      preparationIdentity: 'promoted-preparation',
      log: 'promoted summary',
    })
    expect(retained.at(-1)).toContain('b'.repeat(64))
  } finally {
    release?.(runtimeVersion('a'))
    await Promise.allSettled([pending])
    try {
      await preparation.stop()
    } finally {
      try {
        await database.close()
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  }
})

it('retains its active owner until the committed ready result has finished publishing to consumers', async () => {
  let row: RuntimeDependency = {
    name: 'tool',
    prepareCommand: 'install',
    pathDirectories: ['bin'],
    source: 'manual',
    stage: 'ready',
    current: runtimeVersion('a'),
    updatedAt: 0,
    checks: [],
    log: '',
    preparationIdentity: 'old',
  }
  let published!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => {
      published = resolve
    }),
    gate = new Promise<void>(resolve => {
      release = resolve
    })
  const preparation = new RuntimeDependencyPreparation(
    {
      list: async () => [structuredClone(row)],
      save: async value => {
        row = structuredClone(value)
      },
      remove: async () => {},
    },
    {
      isolated: true,
      identity: () => 'new',
      recover: async () => {},
      collect: async () => {},
      prepare: async (_input, progress) => {
        await progress('ready output')
        return runtimeVersion('b')
      },
    },
    { now: () => 0 },
    { list: async () => [] },
    async () => {
      published()
      await gate
    },
  )
  const pending = preparation.request(row)
  try {
    await entered
    expect(row).toMatchObject({ stage: 'ready', current: runtimeVersion('b') })
    expect(preparation.activePromise('tool')).toBeDefined()
    release()
    await pending
    expect(preparation.activePromise('tool')).toBeUndefined()
  } finally {
    release()
    await pending
    await preparation.stop()
  }
})
