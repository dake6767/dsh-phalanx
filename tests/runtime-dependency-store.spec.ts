import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { FileRuntimeDependencyStore } from '../src/adapters/runtime-dependency-store.js'
it('persists private dependency definitions independently of caller mutations and removes them durably', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dependency-store-')), path = join(root, 'library.json')
  try {
    const store = new FileRuntimeDependencyStore(path)
    const row = { name: 'example', prepareCommand: 'install-pinned', pathDirectories: ['bin'], source: 'manual' as const, stage: 'preparing' as const, log: 'full log', checks: [], updatedAt: 1 }
    const initial = store.version()
    store.save(row); row.pathDirectories.push('changed')
    expect(new FileRuntimeDependencyStore(path).list()[0]?.pathDirectories).toEqual(['bin'])
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    const saved = store.version(); expect(saved).not.toBe(initial)
    store.remove('example'); expect(store.version()).not.toBe(saved); expect(new FileRuntimeDependencyStore(path).list()).toEqual([])
  } finally { await rm(root, { recursive: true, force: true }) }
})
