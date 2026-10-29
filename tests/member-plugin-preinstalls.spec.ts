import { expect, it, vi } from 'vitest'
import { GroupPluginPreinstalls } from '../src/use-cases/group-plugin-preinstalls.js'
import { MemberPluginPreinstalls } from '../src/use-cases/member-plugin-preinstalls.js'
import type { PluginInstallation } from '../src/ports/plugin-installations.js'
import type { CommunityUserInstance } from '../src/ports/community-runtime.js'

function setup() {
  const account = {
    username: 'alice',
    spaceId: 'space',
    sessionEpoch: 0,
    groupId: 'members',
    disabled: false,
    email: '',
    admin: false,
    createdAt: 0,
    updatedAt: 0,
  }
  const plugin = {
    packageName: 'example',
    version: '1.0.0',
    integrity: 'sha512-fixture',
    artifact: 'artifacts/fixture',
    runtimeRevision: 'revision',
    title: '',
    description: '',
    bundlePatch: '[]',
    dependencies: {},
  }
  let packages = ['example'],
    deliveries: PluginInstallation[] = []
  const records = {
    get: async () => deliveries,
    save: (_space: string, row: PluginInstallation) => {
      deliveries.push(row)
    },
    clearPreinstalls: async () => {
      deliveries = deliveries.filter(row => row.source !== 'preinstall')
    },
  }
  const policy = new GroupPluginPreinstalls(
    {
      get: async () => account,
      list: async () => [account],
      listGroups: async () => [{ id: 'members', name: 'Members', kind: 'ordinary', isDefault: true, memberCount: 1 }],
    },
    { list: async () => [{ ...plugin, current: plugin, stage: 'available', published: false }] },
    { preinstalls: async () => packages },
    records,
    'revision',
  )
  const instance = async (processId: number): Promise<CommunityUserInstance> => ({
    userId: 'alice',
    processId,
    origin: 'http://localhost',
    launchUrl: 'http://localhost',
    preinstallPlan: (await policy.plan('alice', []))!,
  })
  return {
    account,
    plugin,
    records,
    policy,
    instance,
    packages: (value: string[]) => {
      packages = value
    },
  }
}

it('dispatches once per ready carrier without blocking entry, retries a real failure only at the next start, and counts distinct members', async () => {
  const f = setup(),
    first = await f.instance(1)
  let active = first,
    calls = 0,
    release!: () => void,
    entered!: () => void
  const pending = new Promise<void>(resolve => {
      release = resolve
    }),
    started = new Promise<void>(resolve => {
      entered = resolve
    })
  const owner = new MemberPluginPreinstalls(
    f.policy,
    {
      preinstall: async (_actor, plugin, _instance, _origin, current) => {
        calls++
        entered()
        await pending
        if (!(await current())) return 'cancelled'
        if (calls === 1) return 'failed'
        f.records.save('space', { packageName: plugin.packageName, version: plugin.version, source: 'preinstall' })
        return 'succeeded'
      },
      cancelSpace: async () => {},
    },
    { status: () => ({ state: 'ready', instance: active }) },
    f.records,
  )
  expect(owner.ready(first, new URL('http://localhost'))).toBeUndefined()
  await started
  expect(await owner.incompleteMembers('members')).toBe(0)
  owner.ready(first, new URL('http://localhost'))
  expect(calls).toBe(1)
  release()
  await owner.drain()
  expect(await owner.incompleteMembers('members')).toBe(1)
  owner.ready(first, new URL('http://localhost'))
  await owner.drain()
  expect(calls).toBe(1)
  f.account.groupId = 'other'
  expect(await owner.incompleteMembers('members')).toBe(0)
  f.account.groupId = 'members'
  f.account.disabled = true
  expect(await owner.incompleteMembers('members')).toBe(0)
  f.account.disabled = false
  active = await f.instance(2)
  owner.ready(active, new URL('http://localhost'))
  await owner.drain()
  expect(calls).toBe(2)
  expect(await owner.incompleteMembers('members')).toBe(0)
  active = await f.instance(3)
  owner.ready(active, new URL('http://localhost'))
  await owner.drain()
  expect(calls).toBe(2)
  f.records.save('space', { packageName: 'chosen', version: '1.0.0', source: 'selected' })
  await owner.beforeReset('space')
  await owner.afterReset('space')
  expect(await f.records.get()).toEqual([{ packageName: 'chosen', version: '1.0.0', source: 'selected' }])
  await owner.stop()
})

it('rejects a replaced carrier and ignores failure counts after the list is removed', async () => {
  const f = setup(),
    first = await f.instance(1),
    plan = first.preinstallPlan!
  let current = first,
    check: (() => Promise<boolean>) | undefined,
    release!: () => void
  const pending = new Promise<void>(resolve => {
    release = resolve
  })
  const owner = new MemberPluginPreinstalls(
    f.policy,
    {
      preinstall: async (_actor, _plugin, _instance, _origin, eligible) => {
        check = eligible
        await pending
        return (await eligible()) ? 'failed' : 'cancelled'
      },
      cancelSpace: async () => {},
    },
    { status: () => ({ state: 'draining', instance: current }) },
    f.records,
  )
  owner.ready(first, new URL('http://localhost'))
  await vi.waitFor(() => expect(check).toBeTypeOf('function'))
  expect(await check?.()).toBe(true)
  current = await f.instance(2)
  expect(await check?.()).toBe(false)
  release()
  await owner.drain()
  expect(await owner.incompleteMembers('members')).toBe(0)
  const failed = { ...current, preinstallPlan: { ...plan, blocked: ['example'] } }
  current = failed
  owner.ready(failed, new URL('http://localhost'))
  await owner.drain()
  expect(await owner.incompleteMembers('members')).toBe(1)
  f.packages([])
  expect(await owner.incompleteMembers('members')).toBe(0)
  await owner.stop()
})
