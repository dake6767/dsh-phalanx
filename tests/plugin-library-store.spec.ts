import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { FilePluginLibraryStore } from '../src/adapters/plugin-library-store.js'

it('retains prepared metadata and failed retry state independently from member spaces', () => {
  const root = mkdtempSync(join(tmpdir(), 'plugin-library-store-'))
  try {
    const path = join(root, 'plugins', 'library.json')
    const store = new FilePluginLibraryStore(path)
    store.save({ packageName: '@example/plugin', version: '1.0.0', current: null, stage: 'failed', published: false, failureCode: 'plugin-precheck-failed' })
    const restarted = new FilePluginLibraryStore(path)
    expect(restarted.list()).toEqual(store.list())
    restarted.save({ packageName: '@example/plugin', version: '1.0.0', stage: 'available', published: false,
      current: { packageName: '@example/plugin', version: '1.0.0', integrity: 'sha512-fixture', artifact: 'artifacts/fixture', runtimeRevision: 'fixture', title: 'Example', description: 'A plugin', bundlePatch: '[]', dependencies: { 'example-dependency': '^1.0.0' } } })
    expect(new FilePluginLibraryStore(path).list()).toEqual(restarted.list())
    expect(restarted.list()).toHaveLength(1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
