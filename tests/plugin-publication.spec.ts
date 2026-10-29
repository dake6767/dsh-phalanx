import { expect, it } from 'vitest'
import { PluginLibrary } from '../src/use-cases/plugin-library.js'
import { PluginMarket } from '../src/use-cases/plugin-market.js'
import { KeyedOperations } from '../src/use-cases/support/keyed-operations.js'
import type { LibraryPlugin } from '../src/domain/plugin-library.js'

it('preserves a library edit submitted while publication is clearing old selections', async () => {
  const actor = { username: 'admin', spaceId: 'space', sessionEpoch: 0, admin: true, disabled: false, groupId: 'admins', email: '', createdAt: 0, updatedAt: 0 }
  const current = {
    packageName: 'plugin',
    version: '1.0.0',
    integrity: 'hash',
    artifact: 'artifact',
    runtimeRevision: 'revision',
    title: '',
    description: '',
    bundlePatch: '[]',
    dependencies: {},
  }
  let row: LibraryPlugin = { ...current, current, stage: 'available', published: false, runtimeDependencies: [] }
  const store = {
    list: async () => structuredClone([row]),
    save: async (next: LibraryPlugin) => {
      row = structuredClone(next)
    },
    remove: async () => {},
  }
  const accounts = { get: async () => actor, list: async () => [actor] },
    mutations = new KeyedOperations()
  let entered!: () => void, release!: () => void
  const began = new Promise<void>(resolve => {
      entered = resolve
    }),
    gate = new Promise<void>(resolve => {
      release = resolve
    })
  const library = new PluginLibrary(
    accounts,
    store,
    { prepare: async () => current },
    undefined,
    undefined,
    undefined,
    undefined,
    { readReady: async () => [] },
    mutations,
  )
  const market = new PluginMarket(
    accounts,
    store,
    { list: async () => [] },
    {
      ensure: async () => {
        throw Error('not used')
      },
    },
    {
      get: async () => [],
      set: async () => {},
      members: async () => [],
      retainPackages: async () => {},
      removePackage: async () => {
        entered()
        await gate
      },
    },
    { effective: async () => [], granted: async () => [] },
    'revision',
    undefined,
    undefined,
    undefined,
    undefined,
    mutations,
  )
  const publication = market.publish(actor, 'plugin', true)
  await began
  const edit = library.setRuntimeDependencies(actor, 'plugin', ['new-dependency'])
  // All unblocked in-memory operations finish before this turn; the protected edit stays queued.
  await new Promise<void>(resolve => setImmediate(resolve))
  release()
  await Promise.all([publication, edit])
  expect(row).toMatchObject({ published: true, runtimeDependencies: ['new-dependency'] })
  await library.stop()
})
