import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { PostgresPluginLibraryStore } from '../src/adapters/postgres-plugin-library.js'
import { openTestDatabase } from './support/community-application.js'

it('retains prepared metadata and failed retry state independently from member spaces', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-library-store-'))
  const database = await openTestDatabase(root)
  try {
    const store = new PostgresPluginLibraryStore(database)
    await store.save({
      packageName: '@example/plugin',
      version: '1.0.0',
      current: null,
      stage: 'failed',
      published: false,
      failureCode: 'plugin-precheck-failed',
    })
    const restarted = new PostgresPluginLibraryStore(database)
    expect(await restarted.list()).toEqual(await store.list())
    await restarted.save({
      packageName: '@example/plugin',
      version: '1.0.0',
      stage: 'available',
      published: false,
      current: {
        packageName: '@example/plugin',
        version: '1.0.0',
        integrity: 'sha512-fixture',
        artifact: 'artifacts/fixture',
        runtimeRevision: 'fixture',
        title: 'Example',
        description: 'A plugin',
        bundlePatch: '[]',
        dependencies: { 'example-dependency': '^1.0.0' },
      },
    })
    expect(await new PostgresPluginLibraryStore(database).list()).toEqual(await restarted.list())
    expect(await restarted.list()).toHaveLength(1)
    const current = (await restarted.list())[0]!
    await restarted.save({ ...current, replacement: { packageName: current.packageName, version: '2.0.0', stage: 'prechecking', prepared: null } })
    const replacement = new PostgresPluginLibraryStore(database)
    expect((await replacement.list())[0]).toMatchObject({ current: { version: '1.0.0' }, replacement: { version: '2.0.0', stage: 'prechecking' } })
    await replacement.remove(current.packageName)
    expect(await new PostgresPluginLibraryStore(database).list()).toEqual([])
  } finally {
    try {
      await database.close()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})
