import { expect, it } from 'vitest'
import { PluginCompatibility } from '../src/use-cases/plugin-compatibility.js'
import { PluginLibrary } from '../src/use-cases/plugin-library.js'
import { PluginPreparationError, type LibraryPlugin, type PreparedPlugin } from '../src/domain/plugin-library.js'

it('rechecks retained bytes once per platform/runtime upgrade, isolates failures, and restores publication on compatible replacement', async () => {
  const prepared: PreparedPlugin = { packageName: 'compatible', version: '1.0.0', integrity: 'sha512-original', artifact: 'artifacts/original', runtimeRevision: 'old', title: 'Plugin', description: '', bundlePatch: '[]', dependencies: {} }
  const rows = new Map(['compatible', 'incompatible'].map(packageName => [packageName, { packageName, version: '1.0.0', current: { ...prepared, packageName }, stage: 'available', published: true } as LibraryPlugin]))
  const store = { list: () => [...rows.values()], save: (row: LibraryPlugin) => { rows.set(row.packageName, row) }, remove: (name: string) => { rows.delete(name) } }
  const calls: string[] = []
  const preparer = { prepare: async (input: import('../src/domain/plugin-library.js').PluginCandidate) => {
    calls.push(input.packageName)
    if (input.version === '1.0.0') expect(input.retainedIntegrity).toBe('sha512-original')
    if (input.packageName === 'incompatible' && input.version === '1.0.0') throw new PluginPreparationError('plugin-precheck-failed')
    return { ...prepared, ...input, integrity: input.version === '1.0.0' ? prepared.integrity : 'sha512-new', runtimeRevision: 'new' }
  } }
  const compatibility = new PluginCompatibility(store, preparer, 'release/new')
  await compatibility.recover()
  expect(rows.get('compatible')).toMatchObject({ stage: 'available', published: true, current: { runtimeRevision: 'new' }, checkedFor: 'release/new' })
  expect(rows.get('incompatible')).toMatchObject({ stage: 'failed', incompatible: true, published: false, restorePublication: true, current: { integrity: 'sha512-original' } })
  await compatibility.recover(); expect(calls).toHaveLength(2)
  const actor = { username: 'admin', spaceId: 'space', sessionEpoch: 0 }
  const library = new PluginLibrary({ get: () => ({ ...actor, admin: true, groupId: 'admin', email: '', disabled: false, createdAt: 0, updatedAt: 0 }) }, store, preparer, undefined,
    { impact: () => ({ groups: 2, members: 3 }), revoke: () => {} }, 'release/new')
  library.replace(actor, { packageName: 'incompatible', version: '2.0.0' }); await library.drain()
  library.select(actor, 'incompatible', library.impact(actor, 'incompatible').revision)
  expect(rows.get('incompatible')).toMatchObject({ stage: 'available', published: true, checkedFor: 'release/new', current: { version: '2.0.0' } })
  expect(rows.get('incompatible')?.incompatible).toBeUndefined()
})

it('resumes interrupted checks, checks candidates too, and rejects changed archive identities', async () => {
  const current = { packageName: 'plugin', version: '1.0.0', integrity: 'pinned', artifact: 'artifacts/pinned', runtimeRevision: 'old', title: '', description: '', bundlePatch: '[]', dependencies: {} }
  let row: LibraryPlugin = { packageName: 'plugin', version: '1.0.0', stage: 'prechecking', current, published: false, restorePublication: true,
    replacement: { packageName: 'plugin', version: '2.0.0', stage: 'available', prepared: { ...current, version: '2.0.0' } } }
  const store = { list: () => [row], save: (value: LibraryPlugin) => { row = value }, remove: () => {} }
  await new PluginCompatibility(store, { prepare: async input => ({ ...current, ...input, integrity: 'changed', runtimeRevision: 'new' }) }, 'release/new').recover()
  expect(row).toMatchObject({ stage: 'failed', incompatible: true, published: false, restorePublication: true, replacement: { stage: 'failed', prepared: null } })
  expect(row.current?.integrity).toBe('pinned')
})

it('does not bypass historical identities when a failed candidate is checked after upgrading', async () => {
  const prepared = { packageName: 'plugin', version: '1.0.0', integrity: 'original', artifact: 'artifacts/original', runtimeRevision: 'old', title: '', description: '', bundlePatch: '[]', dependencies: {} }
  let row: LibraryPlugin = { packageName: 'plugin', version: '1.0.0', current: prepared, stage: 'available', published: false, identities: { '2.0.0': 'known-candidate' }, replacement: { packageName: 'plugin', version: '2.0.0', stage: 'failed', prepared: null } }
  await new PluginCompatibility({ list: () => [row], save: value => { row = value }, remove: () => {} }, { prepare: async input => ({ ...prepared, ...input, integrity: input.version === '2.0.0' ? 'changed' : 'original' }) }, 'new').recover()
  expect(row.replacement).toMatchObject({ stage: 'failed', prepared: null })
  expect(row.identities?.['2.0.0']).toBe('known-candidate')
})

it('propagates cleanup failures and waits for a cancelled precheck before shutdown', async () => {
  let row: LibraryPlugin = { packageName: 'plugin', version: '1.0.0', current: null, stage: 'failed', published: false }
  const store = { list: () => [row], save: (value: LibraryPlugin) => { row = value }, remove: () => {} }
  const broken = new PluginCompatibility(store, { prepare: async () => { throw new PluginPreparationError('plugin-cleanup-failed') } }, 'new')
  await expect(broken.recover()).rejects.toMatchObject({ code: 'plugin-cleanup-failed' })
  expect(row.checkedFor).toBeUndefined()
  let started!: () => void; const begin = new Promise<void>(resolve => { started = resolve })
  let cleaned = false
  const running = new PluginCompatibility(store, { prepare: async (_input, _progress, signal) => {
    started(); await new Promise<void>(resolve => signal.addEventListener('abort', () => { cleaned = true; resolve() }, { once: true }))
    signal.throwIfAborted(); throw Error('unreachable')
  } }, 'new')
  const result = running.recover().catch(error => error)
  await begin; await running.stop()
  expect(cleaned).toBe(true); expect((await result).name).toBe('AbortError')
  expect(row.checkedFor).toBeUndefined()
})

it('preserves cancellation of automatic publication during retry progress and completion', async () => {
  const prepared = { packageName: 'plugin', version: '1.0.0', integrity: 'original', artifact: 'artifacts/original', runtimeRevision: 'old', title: '', description: '', bundlePatch: '[]', dependencies: {} }
  let row: LibraryPlugin = { packageName: 'plugin', version: '1.0.0', current: prepared, stage: 'failed', published: false, incompatible: true, restorePublication: true }
  let finish!: () => void; const ready = new Promise<void>(resolve => { finish = resolve })
  const actor = { username: 'admin', spaceId: 'space', sessionEpoch: 0 }
  const library = new PluginLibrary({ get: () => ({ ...actor, admin: true, groupId: 'admin', email: '', disabled: false, createdAt: 0, updatedAt: 0 }) },
    { list: () => [row], save: value => { row = value }, remove: () => {} }, { prepare: async (_input, progress) => { await ready; progress('prechecking'); return prepared } })
  library.add(actor, { packageName: 'plugin', version: '1.0.0' }, true)
  row = { ...row, restorePublication: false }
  finish(); await library.drain()
  expect(row).toMatchObject({ published: false, restorePublication: false, stage: 'available' })
})

it('reports persistence failures through shutdown instead of treating them as cancellation', async () => {
  const failure = new Error('disk unavailable')
  const compatibility = new PluginCompatibility({ list: () => [{ packageName: 'plugin', version: '1.0.0', stage: 'failed', current: null, published: false }], save: () => { throw failure }, remove: () => {} }, { prepare: async () => { throw Error('not reached') } }, 'new')
  await expect(compatibility.recover()).rejects.toBe(failure)
  await expect(compatibility.stop()).rejects.toBe(failure)
})
