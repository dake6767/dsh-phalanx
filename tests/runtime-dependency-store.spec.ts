import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { runtimeDependencyInput } from '../src/domain/runtime-dependency.js'
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


it('retains Python definitions after restart and rejects an invalid stored package lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'python-store-')), path = join(root, 'library.json')
  try {
    const store = new FileRuntimeDependencyStore(path)
    const definition = runtimeDependencyInput({ name: 'python-library', type: 'python-library', packages: ['six==1.17.0'] })
    const row = { ...definition, source: 'manual' as const, stage: 'preparing' as const, updatedAt: 1, log: '', checks: [] }
    store.save(row)
    expect(new FileRuntimeDependencyStore(path).list()[0]).toMatchObject({ type: 'python-library', packages: ['six==1.17.0'] })
    store.save({ ...row, type: 'python-library', packages: ['six>=1.0'] })
    expect(() => new FileRuntimeDependencyStore(path)).toThrow()
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('preserves a resource category and its empty PATH after restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'resource-store-')), path = join(root, 'library.json')
  try {
    const definition = runtimeDependencyInput({ name: 'office-sdk', type: 'resource', prepareCommand: 'mkdir sdk; printf READY > sdk/data' })
    const store = new FileRuntimeDependencyStore(path)
    store.save({ ...definition, source: 'manual', stage: 'preparing', updatedAt: 1, log: '', checks: [] })
    expect(new FileRuntimeDependencyStore(path).list()[0]).toMatchObject({ type: 'resource', pathDirectories: [] })
  } finally { await rm(root, { recursive: true, force: true }) }
})
