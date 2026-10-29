import { expect, it } from 'vitest'
import type { LibraryPlugin, PreparedPlugin } from '../src/domain/plugin-library.js'
import { PluginLibrary } from '../src/use-cases/plugin-library.js'

it('keeps catalog preparation private and removes only the committed origin', async () => {
  const prepared: PreparedPlugin = {
    packageName: 'example',
    version: '1.0.0',
    integrity: 'sha512-example',
    artifact: 'artifacts/example',
    runtimeRevision: 'rev',
    title: 'Example',
    description: '',
    bundlePatch: '',
    dependencies: {},
  }
  const rows = new Map<string, LibraryPlugin>()
  const store = {
    list: async () => [...rows.values()],
    save: async (row: LibraryPlugin) => {
      rows.set(row.packageName, row)
    },
    remove: async (name: string) => {
      rows.delete(name)
    },
  }
  const library = new PluginLibrary(
    { get: async () => undefined },
    store,
    { prepare: async () => prepared },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { run: async operation => operation({ library: store }) },
  )
  await library.prepareSuitePlugin(
    'catalog',
    { packageName: 'example', version: '1.0.0', integrity: 'sha512-example' },
    async () => {},
    new AbortController().signal,
  )
  expect(await store.list()).toEqual([])
  await library.commitSuitePlugin(
    'catalog',
    { packageName: 'example', version: '1.0.0', integrity: 'sha512-example', access: { environment: [], entriesYaml: '' } },
    prepared,
    [],
  )
  expect(await library.suitePluginRow('catalog')).toMatchObject({ suiteOrigin: 'catalog', current: prepared })
  await library.removeSuitePlugin('other')
  expect(await store.list()).toHaveLength(1)
  await library.removeSuitePlugin('catalog')
  expect(await store.list()).toEqual([])
})
