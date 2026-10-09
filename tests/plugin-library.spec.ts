import { expect, it } from 'vitest'
import { PluginLibrary } from '../src/use-cases/plugin-library.js'
import type { LibraryPlugin } from '../src/domain/plugin-library.js'

it('adds a fixed npm version once, exposes progress and publishes only the prepared metadata', async () => {
  const rows = new Map<string, LibraryPlugin>()
  const actor = { username: 'admin', spaceId: 'admin-space', sessionEpoch: 0 }
  let finish!: () => void
  const ready = new Promise<void>(resolve => { finish = resolve })
  let calls = 0
  const service = new PluginLibrary({ get: () => ({ ...actor, admin: true, groupId: 'admin', email: '', disabled: false, createdAt: 0, updatedAt: 0 }) }, {
    list: () => [...rows.values()], save: row => { rows.set(row.packageName, row) },
  }, { prepare: async (input, progress) => {
    calls++; progress('downloading'); await ready; progress('prechecking')
    return { ...input, integrity: `sha512-${'A'.repeat(86)}==`, artifact: 'artifacts/test', runtimeRevision: 'revision', title: 'Useful plugin', description: 'Package description', bundlePatch: '[{"insert":[]}]', dependencies: {} }
  } })
  expect(() => service.add(actor, { packageName: 'example-plugin', version: 'latest' })).toThrow(expect.objectContaining({ code: 'plugin-identity-invalid' }))
  const first = service.add(actor, { packageName: 'example-plugin', version: '1.2.3' })
  expect(first.currentVersion).toBeNull()
  service.add(actor, { packageName: 'example-plugin', version: '1.2.3' })
  expect(service.list(actor)[0]?.stage).toBe('downloading')
  expect(() => service.add(actor, { packageName: 'example-plugin', version: '1.2.4' })).toThrow(expect.objectContaining({ code: 'plugin-name-in-use' }))
  finish(); await service.drain()
  expect(calls).toBe(1)
  expect(service.list(actor)).toEqual([expect.objectContaining({ packageName: 'example-plugin', currentVersion: '1.2.3', title: 'Useful plugin', description: 'Package description', stage: 'available', published: false })])
  expect(JSON.stringify(service.list(actor))).not.toContain('artifacts/test')
  await service.stop()
})

it('retains failed additions for explicit retry and rechecks the admitted administrator', async () => {
  const rows = new Map<string, LibraryPlugin>()
  const actor = { username: 'admin', spaceId: 'admin-space', sessionEpoch: 0 }
  let admin = true; let attempts = 0
  const store = { list: () => [...rows.values()], save: (row: LibraryPlugin) => { rows.set(row.packageName, row) } }
  const accounts = { get: () => ({ ...actor, admin, groupId: 'admin', email: '', disabled: false, createdAt: 0, updatedAt: 0 }) }
  const service = new PluginLibrary(accounts, store, { prepare: async () => { attempts++; throw new Error('fixture failure with private path') } })
  service.add(actor, { packageName: '@example/tool', version: '1.0.0-beta.1' }); await service.drain()
  expect(service.list(actor)[0]).toMatchObject({ stage: 'failed', currentVersion: null, published: false, failureCode: 'plugin-precheck-failed' })
  expect(JSON.stringify(service.list(actor))).not.toContain('private path')
  service.add(actor, { packageName: '@example/tool', version: '1.0.0-beta.1' }); await service.drain()
  expect(attempts).toBe(1)
  service.add(actor, { packageName: '@example/tool', version: '1.0.0-beta.1' }, true); await service.drain()
  expect(attempts).toBe(2)
  admin = false
  expect(() => service.list(actor)).toThrow(expect.objectContaining({ code: 'admin-required' }))
  expect(() => service.add(actor, { packageName: 'other', version: '1.0.0' })).toThrow(expect.objectContaining({ code: 'admin-required' }))
  admin = true
  expect(() => service.list({ ...actor, sessionEpoch: 1 })).toThrow(expect.objectContaining({ code: 'sign-in-required' }))
  await service.stop()
  expect(() => service.add(actor, { packageName: 'other', version: '1.0.0' })).toThrow(expect.objectContaining({ code: 'plugin-job-interrupted' }))
  store.save({ packageName: 'interrupted', version: '1.0.0', stage: 'installing', current: null, published: false })
  const restarted = new PluginLibrary(accounts, store, { prepare: async () => { throw new Error('not invoked') } })
  expect(restarted.list(actor).find(row => row.packageName === 'interrupted')).toMatchObject({ stage: 'failed', failureCode: 'plugin-job-interrupted' })
  await restarted.stop()
})

it('waits for cancellation before shutdown and never exposes a stopped job as available', async () => {
  let row: LibraryPlugin | undefined
  const actor = { username: 'admin', spaceId: 'admin-space', sessionEpoch: 0 }
  let cancelled = false
  const service = new PluginLibrary({ get: () => ({ ...actor, admin: true, groupId: 'admin', email: '', disabled: false, createdAt: 0, updatedAt: 0 }) }, {
    list: () => row ? [row] : [], save: next => { row = next },
  }, { prepare: async (_input, _progress, signal) => {
    await new Promise<void>((_, reject) => signal.addEventListener('abort', () => { cancelled = true; reject(signal.reason) }, { once: true }))
    throw new Error('unreachable')
  } })
  service.add(actor, { packageName: 'plugin', version: '1.0.0' })
  await service.stop()
  expect(cancelled).toBe(true)
  expect(service.list(actor)[0]).toMatchObject({ stage: 'failed', currentVersion: null, failureCode: 'plugin-job-interrupted' })
})

it('rejects non-registry dependencies even when a peer repeats the same package name', async () => {
  let row: LibraryPlugin | undefined
  const actor = { username: 'admin', spaceId: 'admin-space', sessionEpoch: 0 }
  const service = new PluginLibrary({ get: () => ({ ...actor, admin: true, groupId: 'admin', email: '', disabled: false, createdAt: 0, updatedAt: 0 }) }, {
    list: () => row ? [row] : [], save: next => { row = next },
  }, { prepare: async input => ({ ...input, integrity: 'sha512-fixture', runtimeRevision: 'fixture', artifact: 'artifacts/fixture', title: 'Example', description: '', bundlePatch: '[]',
    dependencies: { hidden: 'https://example.test/hidden.tgz' }, peerDependencies: { hidden: '*' } }) })
  service.add(actor, { packageName: 'plugin', version: '1.0.0' }); await service.drain()
  expect(service.list(actor)[0]).toMatchObject({ stage: 'failed', currentVersion: null, failureCode: 'plugin-dependency-invalid' })
  await service.stop()
})

it('waits for every preparation to settle even when recording another failure is impossible', async () => {
  const rows = new Map<string, LibraryPlugin>()
  const actor = { username: 'admin', spaceId: 'admin-space', sessionEpoch: 0 }
  let finishCleanup!: () => void
  let cleanupStarted!: () => void
  const started = new Promise<void>(resolve => { cleanupStarted = resolve })
  const cleanup = new Promise<void>(resolve => { finishCleanup = resolve })
  const service = new PluginLibrary({ get: () => ({ ...actor, admin: true, groupId: 'admin', email: '', disabled: false, createdAt: 0, updatedAt: 0 }) }, {
    list: () => [...rows.values()], save: next => { if (next.packageName === 'broken' && next.stage === 'failed') throw new Error('Disk full'); rows.set(next.packageName, next) },
  }, { prepare: async (input, _progress, signal) => {
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
    if (input.packageName === 'slow') { cleanupStarted(); await cleanup }
    throw new Error('Cancelled')
  } })
  service.add(actor, { packageName: 'broken', version: '1.0.0' }); service.add(actor, { packageName: 'slow', version: '1.0.0' })
  let stopped = false
  const stopping = service.stop().finally(() => { stopped = true })
  const assertion = expect(stopping).rejects.toThrow('Plugin preparation tasks failed')
  await started
  await new Promise(resolve => setImmediate(resolve))
  expect(stopped).toBe(false)
  finishCleanup(); await assertion
})
