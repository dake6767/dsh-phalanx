import { expect, it, vi } from 'vitest'
import { GroupPluginPreinstalls } from '../src/use-cases/group-plugin-preinstalls.js'
import { MemberPluginPreinstalls } from '../src/use-cases/member-plugin-preinstalls.js'
import type { PluginInstallation } from '../src/ports/plugin-installations.js'
import type { CommunityUserInstance } from '../src/ports/community-runtime.js'

function setup(initialOrigin?: string) {
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
    suiteOrigin = initialOrigin,
    published = false,
    revision = 1,
    deliveries: PluginInstallation[] = []
  const records = {
    get: async () => deliveries,
    save: (_space: string, row: PluginInstallation) => {
      deliveries.push(row)
    },
    resetForSpace: async () => {
      deliveries = deliveries.filter(row => row.source !== 'preinstall')
    },
  }
  const policy = new GroupPluginPreinstalls(
    {
      get: async () => account,
      list: async () => [account],
      listGroups: async () => [{ id: 'members', name: 'Members', kind: 'ordinary', isDefault: true, memberCount: 1 }],
    },
    {
      list: async () => [
        { source: { kind: 'npm' as const }, ...plugin, current: plugin, stage: 'available', published, revision, ...(suiteOrigin ? { suiteOrigin } : {}) },
      ],
    },
    { preinstalls: async () => packages },
    records,
    'revision',
    async () => plugin.integrity,
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
    detach: () => {
      suiteOrigin = undefined
      revision++
    },
    publish: () => {
      published = true
      revision++
    },
  }
}

it('defers a stale first-entry plan when the same archive loses its catalog configuration', async () => {
  const f = setup('suite:fixture')
  const carrier = await f.instance(1)
  const origin = new URL('http://localhost')
  const preinstall = vi.fn(async () => 'succeeded' as const)
  const owner = new MemberPluginPreinstalls(
    f.policy,
    { preinstall, cancelSpace: async () => {} },
    { status: () => ({ state: 'ready', instance: carrier }) },
    f.records,
  )
  f.detach()
  await owner.awaitFirstEntry(carrier, origin)
  expect(preinstall).not.toHaveBeenCalled()
  expect(await owner.listFailures(carrier.preinstallPlan!.actor, carrier)).toEqual([{ packageName: f.plugin.packageName, restartRequired: true }])
  await owner.retry(carrier.preinstallPlan!.actor, carrier, f.plugin.packageName, origin)
  expect(preinstall).not.toHaveBeenCalled()
  await owner.stop()
})

it('keeps a first-entry preinstall current when only App Center publication changes', async () => {
  const f = setup('suite:fixture')
  const carrier = await f.instance(1)
  const plan = carrier.preinstallPlan!
  expect(plan.firstEntry).toEqual([f.plugin.packageName])
  f.publish()
  expect(await f.policy.current(plan, f.plugin)).toBe('ready')
})

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

it('shares one required first-entry delivery across concurrent navigation and leaves the carrier usable after failure', async () => {
  const f = setup()
  const base = await f.instance(1)
  const instance = { ...base, preinstallPlan: { ...base.preinstallPlan!, firstEntry: [f.plugin.packageName] } }
  const origin = new URL('http://localhost')
  let calls = 0
  let start!: () => void, release!: () => void
  const started = new Promise<void>(resolve => {
    start = resolve
  })
  const blocked = new Promise<void>(resolve => {
    release = resolve
  })
  const owner = new MemberPluginPreinstalls(
    f.policy,
    {
      preinstall: async (_actor, plugin) => {
        calls++
        if (calls > 1) {
          await f.records.save('space', { packageName: plugin.packageName, version: plugin.version, source: 'preinstall' })
          return 'succeeded'
        }
        start()
        await blocked
        return 'failed'
      },
      cancelSpace: async () => {},
    },
    { status: () => ({ state: 'ready', instance }) },
    f.records,
  )
  owner.ready(instance, origin)
  expect(owner.firstEntryPending(instance)).toBe(true)
  const one = owner.awaitFirstEntry(instance, origin)
  const two = owner.awaitFirstEntry(instance, origin)
  await started
  expect(one).toBe(two)
  expect(calls).toBe(1)
  release()
  await Promise.all([one, two])
  expect(owner.firstEntryPending(instance)).toBe(false)
  expect(await owner.incompleteMembers('members')).toBe(1)
  const actor = instance.preinstallPlan.actor
  const name = f.plugin.packageName
  expect(await owner.listFailures(actor, instance)).toEqual([{ packageName: name, restartRequired: false }])
  await owner.retry({ ...actor, sessionEpoch: actor.sessionEpoch + 1 }, instance, name, origin)
  expect(calls).toBe(1)
  await Promise.all([owner.retry(actor, instance, name, origin), owner.retry(actor, instance, name, origin)])
  expect(calls).toBe(2)
  expect(await owner.listFailures(actor, instance)).toEqual([])
  expect(await owner.incompleteMembers('members')).toBe(0)
  await owner.stop()
})
