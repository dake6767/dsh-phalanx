import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { FileInstanceResourceStore } from '../src/adapters/instance-resource-store.js'
import { UNLIMITED_INSTANCE_RESOURCES } from '../src/domain/instance-resources.js'

it('imports deployment defaults once, persists overrides and rejects stale revisions', () => {
  const root = mkdtempSync(join(tmpdir(), 'instance-resources-')), path = join(root, 'settings.json')
  let imports = 0
  try {
    const store = new FileInstanceResourceStore(path, () => { imports++; return { cpus: 0.5, memoryMiB: 512, pids: 64 } })
    expect(imports).toBe(1)
    expect(store.read()).toEqual({ revision: 0, defaults: { cpus: 0.5, memoryMiB: 512, pids: 64 }, overrides: {}, idleSeconds: 1800, residents: {} })
    const next = { ...store.read(), revision: 1, defaults: UNLIMITED_INSTANCE_RESOURCES, overrides: { ['a'.repeat(32)]: { cpus: 2, memoryMiB: 2048, pids: 256 } } }
    store.save(next)
    expect(() => store.save({ ...next, defaults: { cpus: 1, memoryMiB: 1024, pids: 128 } })).toThrow()
    expect(store.read()).toEqual(next)
    expect(() => { (store.read().defaults as { cpus: number | null }).cpus = 7 }).toThrow()
    expect(store.read()).toEqual(next)
    expect(new FileInstanceResourceStore(path, () => { throw Error('Must not reimport changed deployment defaults') }).read()).toEqual(next)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(next)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('does not advance state when persistence or validation fails', () => {
  const root = mkdtempSync(join(tmpdir(), 'instance-resources-')), path = join(root, 'settings.json')
  try {
    const store = new FileInstanceResourceStore(path, () => UNLIMITED_INSTANCE_RESOURCES), current = store.read()
    expect(() => store.save({ ...current, revision: 1, overrides: { '../../another-space': UNLIMITED_INSTANCE_RESOURCES } })).toThrow()
    expect(store.read()).toEqual(current)
    rmSync(root, { recursive: true })
    expect(() => store.save({ ...current, revision: 1, defaults: { cpus: 1, memoryMiB: 1024, pids: 128 } })).toThrow()
    expect(store.read()).toEqual(current)
  } finally { rmSync(root, { recursive: true, force: true }) }
})


it('imports idle seconds into existing resource settings once and preserves explicit zero', () => {
  const root = mkdtempSync(join(tmpdir(), 'instance-settings-migrate-')), path = join(root, 'settings.json')
  try {
    const previous = { revision: 7, defaults: { cpus: 0.5, memoryMiB: 512, pids: 64 }, overrides: {} }
    writeFileSync(path, JSON.stringify(previous))
    const imported = new FileInstanceResourceStore(path, () => { throw Error('Resource defaults must not be imported again') }, 0)
    expect(imported.read()).toEqual({ ...previous, idleSeconds: 0, residents: {} })
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(imported.read())
    expect(new FileInstanceResourceStore(path, () => UNLIMITED_INSTANCE_RESOURCES, 60).read()).toEqual(imported.read())
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('persists idle and stable-space residency with resource settings and rejects invalid updates', () => {
  const root = mkdtempSync(join(tmpdir(), 'instance-settings-')), path = join(root, 'settings.json'), space = 'a'.repeat(32)
  try {
    const store = new FileInstanceResourceStore(path, () => UNLIMITED_INSTANCE_RESOURCES)
    expect(store.read()).toMatchObject({ idleSeconds: 1800, residents: {} })
    store.save({ ...store.read(), revision: 1, idleSeconds: 15, residents: { [space]: true } })
    store.save({ ...store.read(), revision: 2, defaults: { cpus: 1, memoryMiB: 512, pids: 64 } })
    const current = store.read()
    expect(new FileInstanceResourceStore(path, () => UNLIMITED_INSTANCE_RESOURCES, 600).read()).toEqual(current)
    expect(current).toMatchObject({ idleSeconds: 15, residents: { [space]: true } })
    for (const change of [{ idleSeconds: -1 }, { idleSeconds: 1.5 }, { residents: { '../another-space': true } }, { residents: { [space]: 'yes' } }]) {
      expect(() => store.save({ ...current, revision: 3, ...change } as typeof current)).toThrow()
      expect(store.read()).toBe(current)
    }
    expect(() => { (current.residents as Record<string, boolean>)[space] = false }).toThrow()
  } finally { rmSync(root, { recursive: true, force: true }) }
})
