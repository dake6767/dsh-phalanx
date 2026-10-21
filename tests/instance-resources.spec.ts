import { expect, it } from 'vitest'
import type { CommunityAccountRecord } from '../src/domain/community-account.js'
import type { InstanceResourceState } from '../src/domain/instance-resources.js'
import { UNLIMITED_INSTANCE_RESOURCES } from '../src/domain/instance-resources.js'
import type { CommunityRuntimePort, CommunityUserInstance } from '../src/ports/community-runtime.js'
import { InstanceResources } from '../src/use-cases/instance-resources.js'

function fixture(isolated = true) {
  const admin: CommunityAccountRecord = { username: 'admin', spaceId: 'a'.repeat(32), sessionEpoch: 0, admin: true, disabled: false, groupId: 'admin', email: '', createdAt: 0, updatedAt: 0 }
  const member = { ...admin, username: 'member', spaceId: 'b'.repeat(32), admin: false, groupId: 'ordinary' }
  const second = { ...member, username: 'second', spaceId: 'c'.repeat(32) }
  const accounts = [admin, member, second]
  let state: InstanceResourceState = { revision: 0, defaults: UNLIMITED_INSTANCE_RESOURCES, overrides: {} }
  const make = (username: string): CommunityUserInstance => ({ userId: username, origin: 'http://localhost', launchUrl: 'http://localhost', processId: 1, resourceKey: username + '-first', resourceLimits: { limits: UNLIMITED_INSTANCE_RESOURCES, swapMiB: null } })
  const instances = new Map([['member', make('member')], ['second', make('second')]])
  const applied: string[] = [], closed: string[] = []
  const runtime: Pick<CommunityRuntimePort, 'status' | 'applyResources'> = {
    status: username => { const instance = instances.get(username); return instance ? { state: 'ready', instance } : { state: 'stopped' } },
    applyResources: async (instance, limits) => { applied.push(instance.userId); Object.assign(instance, { resourceLimits: { limits, swapMiB: limits.memoryMiB === null ? null : 0 } }); return { instance, method: 'updated' } },
  }
  const service = new InstanceResources({ get: username => accounts.find(row => row.username === username), list: () => accounts },
    { read: () => structuredClone(state), save: value => { if (value.revision !== state.revision + 1) throw Error('Stale store revision'); state = structuredClone(value) } },
    { read: () => ({ memoryBytes: 4 * 1024 ** 3, cpuCount: 4 }) }, runtime, { closeUser: async username => { closed.push(username) } }, isolated)
  const targets = () => service.settings(admin).pending.map(row => ({ username: row.username, spaceId: row.spaceId, instanceKey: row.instanceKey! }))
  return { admin, member, second, accounts, instances, runtime, applied, closed, service, targets, state: () => state }
}

it('saves defaults separately from application and reports actual capacity and pending members', async () => {
  const f = fixture()
  expect(f.service.settings(f.admin)).toMatchObject({ revision: 0, defaults: UNLIMITED_INSTANCE_RESOURCES, suggested: { cpus: 2, memoryMiB: 2048, pids: 2048 }, capacity: { runningMemoryMiB: 0, runningUnlimited: 2, residentMemoryMiB: 0 }, pending: [] })
  await f.service.saveDefaults(f.admin, { revision: 0, limits: { cpus: 0.5, memoryMiB: 3072, pids: 128 } })
  expect(f.applied).toEqual([])
  expect(f.service.settings(f.admin).capacity).toMatchObject({ runningMemoryMiB: 6144, overcommitted: true })
  expect(f.service.member(f.admin, 'member')).toMatchObject({ source: 'default', pending: true, target: { cpus: 0.5, memoryMiB: 3072, pids: 128 }, current: UNLIMITED_INSTANCE_RESOURCES })
  const result = await f.service.apply(f.admin, { revision: 1, confirmed: true, targets: f.targets() }, new URL('http://localhost'))
  expect(result.results).toHaveLength(2)
  expect(result.results.every(row => row.status === 'applied')).toBe(true)
  expect(f.service.settings(f.admin)).toMatchObject({ pending: [], capacity: { runningMemoryMiB: 6144, overcommitted: true } })
  expect(f.closed).toEqual([])
})

it('replaces all fields for a stable-space override, including explicit unlimited values', async () => {
  const f = fixture()
  await f.service.saveDefaults(f.admin, { revision: 0, limits: { cpus: 1, memoryMiB: 512, pids: 64 } })
  await f.service.saveMember(f.admin, { revision: 1, username: 'member', spaceId: f.member.spaceId, override: { cpus: 2, memoryMiB: null, pids: null } })
  expect(f.service.member(f.admin, 'member')).toMatchObject({ source: 'custom', target: { cpus: 2, memoryMiB: null, pids: null } })
  f.member.spaceId = 'd'.repeat(32)
  expect(f.service.member(f.admin, 'member')).toMatchObject({ source: 'default', target: { cpus: 1, memoryMiB: 512, pids: 64 } })
  await expect(f.service.saveMember(f.admin, { revision: 2, username: 'member', spaceId: 'b'.repeat(32), override: null })).rejects.toThrow()
})

it('rejects stale revisions, missing confirmation and ordinary-member management', async () => {
  const f = fixture()
  await f.service.saveDefaults(f.admin, { revision: 0, limits: { cpus: 1, memoryMiB: 512, pids: 64 } })
  await expect(f.service.saveDefaults(f.admin, { revision: 0, limits: UNLIMITED_INSTANCE_RESOURCES })).rejects.toThrow(expect.objectContaining({ code: 'instance-resource-revision-conflict' }))
  await expect(f.service.apply(f.admin, { revision: 1, confirmed: false, targets: f.targets() }, new URL('http://localhost'))).rejects.toThrow(expect.objectContaining({ code: 'instance-resource-confirmation-required' }))
  expect(() => f.service.settings(f.member)).toThrow(expect.objectContaining({ code: 'admin-required' }))
  await expect(f.service.saveDefaults(f.member, { revision: 1, limits: UNLIMITED_INSTANCE_RESOURCES })).rejects.toThrow(expect.objectContaining({ code: 'admin-required' }))
  expect(f.applied).toEqual([])
})

it('does not apply a stale confirmation to a replacement instance or recreated account', async () => {
  const f = fixture()
  await f.service.saveDefaults(f.admin, { revision: 0, limits: { cpus: 1, memoryMiB: 512, pids: 64 } })
  const targets = f.targets()
  f.instances.set('member', { ...f.instances.get('member')!, resourceKey: 'replacement' })
  f.second.spaceId = 'e'.repeat(32)
  expect((await f.service.apply(f.admin, { revision: 1, confirmed: true, targets }, new URL('http://localhost'))).results.map(row => row.status)).toEqual(['changed', 'changed'])
  expect(f.applied).toEqual([])
})

it('allows saving in development mode but never applies to development processes', async () => {
  const f = fixture(false)
  await f.service.saveDefaults(f.admin, { revision: 0, limits: { cpus: 1, memoryMiB: 512, pids: 64 } })
  expect(f.service.settings(f.admin)).toMatchObject({ isolated: false, pending: [] })
  await expect(f.service.apply(f.admin, { revision: 1, confirmed: true, targets: [] }, new URL('http://localhost'))).rejects.toThrow(expect.objectContaining({ code: 'instance-resource-development' }))
  expect(f.applied).toEqual([])
})

it('serializes saves behind an in-flight application so a fallback restart uses the confirmed target', async () => {
  const f = fixture()
  await f.service.saveDefaults(f.admin, { revision: 0, limits: { cpus: 1, memoryMiB: 512, pids: 64 } })
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
  f.runtime.applyResources = async (instance, limits, _origin, beforeRestart) => { entered(); await gate; expect(f.service.forSpace(f.member.spaceId)).toEqual(limits); await beforeRestart(); Object.assign(instance, { resourceLimits: { limits, swapMiB: 0 } }); return { instance, method: 'restarted' } }
  const applying = f.service.apply(f.admin, { revision: 1, confirmed: true, targets: [f.targets()[0]!] }, new URL('http://localhost'))
  await started
  const saving = f.service.saveDefaults(f.admin, { revision: 1, limits: { cpus: 2, memoryMiB: 1024, pids: 256 } })
  expect(f.state().revision).toBe(1)
  release(); await applying; await saving
  expect(f.closed).toEqual(['member'])
  expect(f.service.member(f.admin, 'member')).toMatchObject({ pending: true, current: { cpus: 1, memoryMiB: 512, pids: 64 }, target: { cpus: 2, memoryMiB: 1024, pids: 256 } })
})

it('retains per-member failures while applying the remaining confirmed targets', async () => {
  const f = fixture()
  await f.service.saveDefaults(f.admin, { revision: 0, limits: { cpus: 1, memoryMiB: 512, pids: 64 } })
  const original = f.runtime.applyResources!
  f.runtime.applyResources = async (...args) => { if (args[0].userId === 'member') throw Error('Private host cause'); return original(...args) }
  expect((await f.service.apply(f.admin, { revision: 1, confirmed: true, targets: f.targets() }, new URL('http://localhost'))).results).toEqual([
    { username: 'member', status: 'failed', code: 'instance-resource-apply-failed' }, { username: 'second', status: 'applied', method: 'updated' },
  ])
  expect(f.service.settings(f.admin).pending.map(row => row.username)).toEqual(['member'])
})

it('rechecks the administrator after asynchronous application before touching the next target', async () => {
  const f = fixture()
  await f.service.saveDefaults(f.admin, { revision: 0, limits: { cpus: 1, memoryMiB: 512, pids: 64 } })
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }), reached = new Promise<void>(resolve => { entered = resolve })
  f.runtime.applyResources = async instance => { f.applied.push(instance.userId); entered(); await gate; return { instance, method: 'updated' } }
  const applying = f.service.apply(f.admin, { revision: 1, confirmed: true, targets: f.targets() }, new URL('http://localhost'))
  const rejected = expect(applying).rejects.toMatchObject({ code: 'sign-in-required' })
  await reached; Object.assign(f.admin, { disabled: true }); release(); await rejected
  expect(f.applied).toEqual(['member'])
})
