import { expect, it, vi } from 'vitest'
import { ResidentInstances } from '../src/use-cases/resident-instances.js'
import { CommunityInstanceLifecycle } from '../src/use-cases/community-instance-lifecycle.js'
import type { CommunityAccountRecord } from '../src/domain/community-account.js'
import { UNLIMITED_INSTANCE_RESOURCES } from '../src/domain/instance-resources.js'

it('boots only enabled resident spaces, locks automatic failures, clears them on foreground success and restarts confirmed crashes', async () => {
  const member: CommunityAccountRecord = {
    username: 'member',
    spaceId: 'a'.repeat(32),
    admin: false,
    disabled: false,
    sessionEpoch: 0,
    email: '',
    groupId: 'ordinary',
    createdAt: 0,
    updatedAt: 0,
  }
  let accounts = [member],
    residents = { [member.spaceId]: true as const },
    fail = true,
    alive = true,
    launches = 0,
    now = 123
  const runtime: CommunityInstanceLifecycle = new CommunityInstanceLifecycle(
    {
      rebuild: async () => [],
      alive: async () => alive,
      stop: async () => {},
      detach: async () => {},
      start: async userId => {
        launches++
        if (fail) throw Error('private fixture')
        return { userId, processId: launches, origin: 'http://localhost', launchUrl: 'http://localhost' }
      },
    },
    async () => ({ url: 'http://localhost/model', token: 'fixture' }),
    async user => await monitor.ready(user),
  )
  const monitor: ResidentInstances = new ResidentInstances(
    { get: async username => accounts.find(row => row.username === username), list: async () => accounts },
    { read: async () => ({ revision: 0, defaults: UNLIMITED_INSTANCE_RESOURCES, overrides: {}, idleSeconds: 1800, residents }) },
    runtime,
    { now: () => now },
    () => new URL('https://community.example/'),
  )
  await monitor.scan()
  await monitor.drain()
  expect(monitor.failure(member.spaceId)).toEqual({ at: 123 })
  await monitor.scan()
  await monitor.drain()
  expect(launches).toBe(1)
  fail = false
  await runtime.ensure('member', 'https://community.example/')
  expect(monitor.failure(member.spaceId)).toBeUndefined()
  alive = false
  await runtime.refresh()
  now = 456
  await monitor.scan()
  await monitor.drain()
  expect(launches).toBe(3)
  accounts = [{ ...member, disabled: true }]
  await runtime.terminate('member')
  await monitor.settingsChanged()
  await monitor.drain()
  expect(launches).toBe(3)
  accounts = [member]
  await monitor.settingsChanged()
  await monitor.drain()
  expect(launches).toBe(4)
  accounts = [{ ...member, spaceId: 'b'.repeat(32) }]
  await runtime.terminate('member')
  await monitor.settingsChanged()
  await monitor.drain()
  expect(launches).toBe(4)
  residents = {}
  await monitor.settingsChanged()
  expect(monitor.failure(member.spaceId)).toBeUndefined()
  await runtime.stopAll()
})

it('defers boot and queued starts behind upgrade maintenance, then resumes without a failure lock', async () => {
  const accounts: CommunityAccountRecord[] = ['alice', 'bob', 'carol', 'dave'].map((username, index) => ({
    username,
    spaceId: String(index + 1).repeat(32),
    admin: false,
    disabled: false,
    sessionEpoch: 0,
    email: '',
    groupId: 'ordinary',
    createdAt: 0,
    updatedAt: 0,
  }))
  const releases = new Map<string, () => void>(),
    launches: string[] = []
  let open = false
  const runtime: CommunityInstanceLifecycle = new CommunityInstanceLifecycle(
    {
      rebuild: async () => [],
      alive: async () => true,
      stop: async () => {},
      detach: async () => {},
      start: async userId => {
        launches.push(userId)
        await new Promise<void>(resolve => {
          releases.set(userId, resolve)
        })
        return { userId, processId: launches.length, origin: 'http://localhost', launchUrl: 'http://localhost' }
      },
    },
    async () => ({ url: 'http://localhost/model', token: 'fixture' }),
  )
  const service = new ResidentInstances(
    { get: async username => accounts.find(row => row.username === username), list: async () => accounts },
    {
      read: async () => ({
        revision: 0,
        defaults: UNLIMITED_INSTANCE_RESOURCES,
        overrides: {},
        idleSeconds: 0,
        residents: Object.fromEntries(accounts.map(row => [row.spaceId, true as const])),
      }),
    },
    runtime,
    { now: () => 123 },
    () => new URL('https://community.example/'),
    () => open,
  )
  await service.scan()
  expect(launches).toEqual([])
  open = true
  await service.scan()
  await vi.waitFor(() => expect(launches).toEqual(['alice', 'bob']))
  open = false
  releases.get('alice')!()
  releases.get('bob')!()
  await service.drain()
  expect(launches).toEqual(['alice', 'bob'])
  for (const account of accounts) expect(service.failure(account.spaceId)).toBeUndefined()
  open = true
  await service.scan()
  await vi.waitFor(() => expect(launches).toEqual(['alice', 'bob', 'alice', 'bob']))
  releases.get('alice')!()
  releases.get('bob')!()
  await expect.poll(() => launches.length).toBe(6)
  releases.get('carol')!()
  releases.get('dave')!()
  await service.drain()
  await runtime.stopAll()
})

it('observes a failed background account check immediately and reports it when drained', async () => {
  const account = {
    username: 'member',
    spaceId: 'space',
    groupId: 'members',
    sessionEpoch: 0,
    admin: false,
    disabled: false,
    email: '',
    createdAt: 0,
    updatedAt: 0,
  }
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const service = new ResidentInstances(
    {
      get: async () => {
        throw Error('Account lookup unavailable')
      },
      list: async () => [account],
    },
    { read: async () => ({ revision: 0, defaults: UNLIMITED_INSTANCE_RESOURCES, overrides: {}, idleSeconds: 0, residents: { space: true } }) },
    {
      status: () => ({ state: 'stopped' }),
      queueStart: async () => {
        throw Error('Startup failed')
      },
    },
    { now: () => 0 },
    () => new URL('http://localhost'),
  )
  try {
    await service.scan()
    await new Promise<void>(resolve => {
      setImmediate(resolve)
    })
    await expect(service.drain()).rejects.toThrow('Resident instance checks failed')
    expect(warning).toHaveBeenCalledWith('Resident instance eligibility check failed')
  } finally {
    warning.mockRestore()
  }
})
