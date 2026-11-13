import { expect, it, vi } from 'vitest'
import type { LibraryPlugin, PreparedPlugin } from '../src/domain/plugin-library.js'
import type { PluginPreparerPort } from '../src/ports/plugin-library.js'
import { PluginLibrary } from '../src/use-cases/plugin-library.js'

it.each([false, true])('keeps catalog preparation private and removes only the committed origin (archive=%s)', async fromArchive => {
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
  const signal = new AbortController().signal
  const archive = { url: 'https://github.com/fixture/editor/releases/download/v1.0.0/editor.tgz' }
  const item = {
    packageName: 'example',
    version: '1.0.0',
    integrity: 'sha512-example',
    ...(fromArchive ? { archive } : {}),
  }
  const uploaded = { ...item, archive: 'staged-original.tgz' }
  const load = vi.fn(async () => uploaded)
  const discard = vi.fn(async () => {})
  const prepare = vi.fn<PluginPreparerPort['prepare']>(async () => prepared)
  const library = new PluginLibrary(
    { get: async () => undefined },
    store,
    { prepare },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { run: async operation => operation({ library: store }) },
    undefined,
    { load, discard },
  )
  if (fromArchive) {
    load.mockResolvedValueOnce({ ...uploaded, version: '2.0.0' })
    await expect(library.prepareSuitePlugin('catalog', item, async () => {}, signal)).rejects.toMatchObject({ code: 'plugin-package-invalid' })
    expect(prepare).not.toHaveBeenCalled()
    expect(discard).toHaveBeenCalledWith(uploaded.archive)
    discard.mockClear()
  }
  await library.prepareSuitePlugin('catalog', item, async () => {}, signal)
  expect(prepare.mock.calls[0]?.[0]).toEqual({
    packageName: item.packageName,
    version: item.version,
    ...(fromArchive ? { upload: uploaded } : {}),
  })
  if (fromArchive) {
    expect(load).toHaveBeenLastCalledWith(archive.url, item.integrity, signal)
    expect(discard).toHaveBeenCalledExactlyOnceWith(uploaded.archive)
  } else {
    expect(load).not.toHaveBeenCalled()
  }
  expect(await store.list()).toEqual([])
  await library.commitSuitePlugin('catalog', { ...item, access: { environment: [], entriesYaml: '' } }, prepared, [])
  expect(await library.suitePluginRow('catalog')).toMatchObject({
    suiteOrigin: 'catalog',
    current: fromArchive ? { ...prepared, catalogArchiveUrl: archive.url } : prepared,
    source: { kind: fromArchive ? 'upload' : 'npm' },
  })
  await library.removeSuitePlugin('other')
  expect(await store.list()).toHaveLength(1)
  await library.removeSuitePlugin('catalog')
  expect(await store.list()).toEqual([])
})
