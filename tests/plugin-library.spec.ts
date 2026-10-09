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
    list: () => [...rows.values()], remove: (name: string) => { rows.delete(name) }, save: row => { rows.set(row.packageName, row) },
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
  const store = { list: () => [...rows.values()], remove: (name: string) => { rows.delete(name) }, save: (row: LibraryPlugin) => { rows.set(row.packageName, row) } }
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
    list: () => row ? [row] : [], remove: () => { row = undefined }, save: next => { row = next },
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
    list: () => row ? [row] : [], remove: () => { row = undefined }, save: next => { row = next },
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
    list: () => [...rows.values()], remove: (name: string) => { rows.delete(name) }, save: next => { if (next.packageName === 'broken' && next.stage === 'failed') throw new Error('Disk full'); rows.set(next.packageName, next) },
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

it('adds uploaded packages idempotently by content and rejects changed bytes at the same version', async () => {
  const rows = new Map<string, LibraryPlugin>()
  const actor = { username: 'admin', spaceId: 'admin-space', sessionEpoch: 0 }
  const discarded: string[] = []
  let serial = 0; let integrity = 'sha512-original'; let calls = 0
  const service = new PluginLibrary({ get: () => ({ ...actor, admin: true, groupId: 'admin', email: '', disabled: false, createdAt: 0, updatedAt: 0 }) }, {
    list: () => [...rows.values()], remove: (name: string) => { rows.delete(name) }, save: next => { rows.set(next.packageName, next) },
  }, { prepare: async input => { calls++; return { ...input, integrity: 'sha512-original', runtimeRevision: 'fixture', artifact: 'artifacts/original', title: 'Private plugin', description: 'Private', bundlePatch: '[]', dependencies: {} } } }, {
    accept: async () => ({ packageName: '@example/private', version: '1.0.0', archive: `archive-${++serial}`, integrity }),
    discard: async archive => { discarded.push(archive) },
  })
  async function* bytes() { yield new Uint8Array([1, 2, 3]) }
  await service.upload(actor, 'private.tgz', bytes(), new AbortController().signal); await service.drain()
  expect(service.list(actor)[0]).toMatchObject({ source: 'upload', currentVersion: '1.0.0', stage: 'available' })
  await service.upload(actor, 'same.tgz', bytes(), new AbortController().signal)
  expect(calls).toBe(1); expect(discarded).toEqual(['archive-2'])
  integrity = 'sha512-changed'
  await expect(service.upload(actor, 'changed.tgz', bytes(), new AbortController().signal)).rejects.toMatchObject({ code: 'plugin-version-conflict' })
  expect(discarded).toEqual(['archive-2', 'archive-3'])
  expect(service.list(actor)[0]).toMatchObject({ currentVersion: '1.0.0', integrity: 'sha512-original' })
  await service.stop()
})

it('recovers containers before reconciling uploaded originals with durable library references', async () => {
  const events: string[] = []
  const row: LibraryPlugin = { packageName: 'private-plugin', version: '1.0.0', stage: 'installing', current: null, published: false,
    upload: { archive: 'archives/retained.tgz', integrity: 'sha512-fixture' } }
  const service = new PluginLibrary({ get: () => undefined }, { list: () => [row], remove: () => {}, save: () => {} }, {
    prepare: async () => { throw new Error('not invoked') }, recover: async () => { events.push('containers') },
  }, {
    accept: async () => { throw new Error('not invoked') }, discard: async () => {},
    recover: async retained => { events.push('archives'); expect(retained).toEqual(['archives/retained.tgz']) },
  })
  await service.recover()
  expect(events).toEqual(['containers', 'archives'])
})

it('prechecks a replacement without changing the current version and confirms fresh impact before selection or removal', async () => {
  const actor = { username: 'admin', spaceId: 'admin-space', sessionEpoch: 0 }
  const prepared = (version: string) => ({ packageName: 'plugin', version, integrity: `sha512-${version}`, artifact: 'artifacts/test', runtimeRevision: 'revision', title: 'Plugin', description: '', bundlePatch: '[]', dependencies: {} })
  let row: LibraryPlugin | undefined = { packageName: 'plugin', version: '1.0.0', current: prepared('1.0.0'), stage: 'available', published: true }
  let complete!: () => void; let gate = new Promise<void>(resolve => { complete = resolve }); let fail = false; let members = 2; let revoked = false
  const service = new PluginLibrary({ get: () => ({ ...actor, admin: true, groupId: 'admin', email: '', disabled: false, createdAt: 0, updatedAt: 0 }) }, {
    list: () => row ? [row] : [], save: next => { row = next }, remove: () => { row = undefined },
  }, { prepare: async input => { await gate; if (fail) throw Error('Not compatible'); return prepared(input.version) } }, undefined,
  { impact: () => ({ groups: 2, members }), revoke: () => { revoked = true } })
  service.replace(actor, { packageName: 'plugin', version: '2.0.0' })
  expect(row).toMatchObject({ stage: 'available', current: { version: '1.0.0' }, published: true })
  expect(() => service.select(actor, 'plugin', service.impact(actor, 'plugin').revision)).toThrow(expect.objectContaining({ code: 'plugin-candidate-unavailable' }))
  complete(); await service.drain()
  const impact = service.impact(actor, 'plugin'); expect(impact).toMatchObject({ groups: 2, members: 2 })
  members = 3
  expect(() => service.select(actor, 'plugin', impact.revision)).toThrow(expect.objectContaining({ code: 'plugin-impact-changed' }))
  service.select(actor, 'plugin', service.impact(actor, 'plugin').revision)
  expect(row).toMatchObject({ version: '2.0.0', current: { version: '2.0.0' }, published: true }); expect(row?.replacement).toBeUndefined()
  fail = true; gate = Promise.resolve()
  service.replace(actor, { packageName: 'plugin', version: '3.0.0' }); await service.drain()
  expect(row).toMatchObject({ current: { version: '2.0.0' }, replacement: { stage: 'failed' }, published: true })
  expect(() => service.select(actor, 'plugin', service.impact(actor, 'plugin').revision)).toThrow(expect.objectContaining({ code: 'plugin-candidate-unavailable' }))
  service.remove(actor, 'plugin', service.impact(actor, 'plugin').revision)
  expect(row).toBeUndefined(); expect(revoked).toBe(true)
  await service.stop()
})

it('prepares a private uploaded replacement while retaining both archive references until selection', async () => {
  const actor = { username: 'admin', spaceId: 'admin-space', sessionEpoch: 0 }
  const prepared = { packageName: 'private', version: '1.0.0', integrity: 'sha512-old', artifact: 'artifacts/old', runtimeRevision: 'revision', title: 'Private', description: '', bundlePatch: '[]', dependencies: {} }
  let row: LibraryPlugin = { ...prepared, upload: { archive: 'old.tgz', integrity: prepared.integrity }, current: prepared, stage: 'available', published: true }
  let retained: readonly string[] = []
  const service = new PluginLibrary({ get: () => ({ ...actor, admin: true, groupId: 'admin', email: '', disabled: false, createdAt: 0, updatedAt: 0 }) }, {
    list: () => [row], save: value => { row = value }, remove: () => {},
  }, { prepare: async input => ({ ...prepared, version: input.version, integrity: input.upload!.integrity }) }, {
    accept: async () => ({ packageName: 'private', version: '2.0.0', archive: 'new.tgz', integrity: 'sha512-new' }),
    discard: async () => { throw Error('Accepted archive must remain referenced') }, recover: async paths => { retained = paths },
  }, { impact: () => ({ groups: 1, members: 1 }), revoke: () => {} })
  async function* bytes() { yield new Uint8Array([1]) }
  await service.upload(actor, 'new.tgz', bytes(), new AbortController().signal, 'private'); await service.drain()
  expect(row).toMatchObject({ current: { version: '1.0.0' }, replacement: { version: '2.0.0', upload: { archive: 'new.tgz' }, stage: 'available' } })
  await service.recover(); expect(retained).toEqual(['old.tgz', 'new.tgz'])
  service.select(actor, 'private', service.impact(actor, 'private').revision)
  expect(row).toMatchObject({ current: { version: '2.0.0' }, upload: { archive: 'new.tgz' }, published: true })
  await service.stop()
})

it('persists removal intent before revoking grants and resumes it after an interrupted write', async () => {
  const actor = { username: 'admin', spaceId: 'admin-space', sessionEpoch: 0 }
  let row: LibraryPlugin | undefined = { packageName: 'plugin', version: '1.0.0', stage: 'failed', current: null, published: true }
  let fail = true; let revoked = false
  const store = { list: () => row ? [row] : [], save: (value: LibraryPlugin) => { row = value }, remove: () => { row = undefined } }
  const accounts = { get: () => ({ ...actor, admin: true, groupId: 'admin', email: '', disabled: false, createdAt: 0, updatedAt: 0 }) }
  const preparer = { prepare: async () => { throw Error('Not needed') } }
  const membership = { impact: () => ({ groups: 2, members: 3 }), revoke: () => { if (fail) throw Error('Interrupted grant write'); revoked = true } }
  const service = new PluginLibrary(accounts, store, preparer, undefined, membership)
  expect(() => service.remove(actor, 'plugin', service.impact(actor, 'plugin').revision)).toThrow('Interrupted grant write')
  expect(row).toMatchObject({ removing: true, published: false })
  fail = false
  const restarted = new PluginLibrary(accounts, store, preparer, undefined, membership)
  await restarted.recover(); expect(revoked).toBe(true); expect(row).toBeUndefined()
})

it('rejects changed bytes for failed, candidate and previously selected upload versions', async () => {
  const actor = { username: 'admin', spaceId: 'admin-space', sessionEpoch: 0 }
  let row: LibraryPlugin = { packageName: 'private', version: '1.0.0', upload: { archive: 'old', integrity: 'sha512-old' }, stage: 'failed', current: null, published: false }
  let version = '1.0.0'; let integrity = 'sha512-changed'; let discarded = 0
  const service = new PluginLibrary({ get: () => ({ ...actor, admin: true, groupId: 'admin', email: '', disabled: false, createdAt: 0, updatedAt: 0 }) }, {
    list: () => [row], save: value => { row = value }, remove: () => {},
  }, { prepare: async input => ({ packageName: input.packageName, version: input.version, integrity: input.upload!.integrity, artifact: 'artifacts/test', runtimeRevision: 'revision', title: 'Private', description: '', bundlePatch: '[]', dependencies: {} }) }, {
    accept: async () => ({ packageName: 'private', version, integrity, archive: integrity }), discard: async () => { discarded++ },
  }, { impact: () => ({ groups: 1, members: 1 }), revoke: () => {} })
  async function* bytes() { yield new Uint8Array([1]) }
  const upload = () => service.upload(actor, 'candidate.tgz', bytes(), new AbortController().signal, 'private')
  await expect(upload()).rejects.toMatchObject({ code: 'plugin-version-conflict' })
  version = '2.0.0'; integrity = 'sha512-new'; await upload(); await service.drain()
  integrity = 'sha512-different'; await expect(upload()).rejects.toMatchObject({ code: 'plugin-version-conflict' })
  service.select(actor, 'private', service.impact(actor, 'private').revision)
  version = '1.0.0'; await expect(upload()).rejects.toMatchObject({ code: 'plugin-version-conflict' })
  expect(discarded).toBe(3); expect(row.current?.version).toBe('2.0.0'); await service.stop()
})
