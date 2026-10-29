import { expect, it, vi } from 'vitest'
import { CommunityInstanceLifecycle } from '../src/use-cases/community-instance-lifecycle.js'
import type { CommunityRuntimeDriverPort } from '../src/ports/community-runtime-driver.js'

function fixture() {
  const launches: string[] = [],
    releases = new Map<string, () => void>()
  const driver: CommunityRuntimeDriverPort = {
    rebuild: async () => [],
    alive: async () => true,
    stop: async () => {},
    detach: async () => {},
    start: async (userId, _origin, _access, signal) => {
      launches.push(userId)
      await new Promise<void>((resolve, reject) => {
        releases.set(userId, resolve)
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
      signal.throwIfAborted()
      return { userId, processId: launches.length, origin: 'http://127.0.0.1:4100', launchUrl: 'http://127.0.0.1:4100/launch' }
    },
  }
  const ready = vi.fn()
  const runtime = new CommunityInstanceLifecycle(driver, async () => ({ url: 'http://127.0.0.1:3081', token: 'fixture' }), ready)
  return { runtime, launches, releases, ready }
}
const origin = 'https://community.example/'

it('limits automatic starts to two, promotes navigation and joins its queued attempt', async () => {
  const { runtime, launches, releases, ready } = fixture()
  const tasks = ['alice', 'bob', 'carol', 'dave'].map(user => runtime.queueStart(user, origin, async () => true))
  await vi.waitFor(() => expect(launches).toEqual(['alice', 'bob']))
  expect(runtime.status('dave')).toEqual({ state: 'starting', stage: 'preparing' })
  const navigation = runtime.ensure('dave', origin)
  releases.get('alice')!()
  await tasks[0]
  await vi.waitFor(() => expect(launches).toEqual(['alice', 'bob', 'dave']))
  releases.get('dave')!()
  expect(await navigation).toBe(await tasks[3])
  await vi.waitFor(() => expect(launches).toEqual(['alice', 'bob', 'dave', 'carol']))
  releases.get('bob')!()
  releases.get('carol')!()
  await Promise.all(tasks)
  expect(ready.mock.calls.map(args => args[0]).sort()).toEqual(['alice', 'bob', 'carol', 'dave'])
  await runtime.stopAll()
})

it('rechecks queued eligibility, cancels maintenance and drains shutdown without starting peers', async () => {
  const { runtime, launches } = fixture()
  const tasks = ['alice', 'bob', 'carol', 'dave'].map(user => runtime.queueStart(user, origin, async () => true).catch(error => error))
  await runtime.terminate('carol')
  expect(await tasks[2]).toMatchObject({ reason: 'start-cancelled' })
  await runtime.stopAll()
  await vi.waitFor(() => expect(launches).toEqual(['alice', 'bob']))
  expect(await tasks[3]).toMatchObject({ reason: 'start-cancelled' })
  expect(await tasks[0]).toMatchObject({ reason: 'start-cancelled' })
  expect(await tasks[1]).toMatchObject({ reason: 'start-cancelled' })
})

it('rejects a stale queued space before launch and keeps the queue moving', async () => {
  const { runtime, launches, releases } = fixture()
  const alice = runtime.queueStart('alice', origin, async () => true),
    bob = runtime.queueStart('bob', origin, async () => true)
  let eligible = true
  const stale = runtime.queueStart('carol', origin, async () => eligible).catch(error => error)
  const dave = runtime.queueStart('dave', origin, async () => true)
  await vi.waitFor(() => expect(releases.has('alice')).toBe(true))
  eligible = false
  releases.get('alice')!()
  await alice
  expect(await stale).toMatchObject({ reason: 'start-cancelled' })
  await vi.waitFor(() => expect(launches).toEqual(['alice', 'bob', 'dave']))
  releases.get('bob')!()
  releases.get('dave')!()
  await Promise.all([bob, dave])
  await runtime.stopAll()
})

it('settles queued work after a fatal cleanup failure and never admits another automatic start', async () => {
  const { CommunityRuntimeCleanupError } = await import('../src/ports/community-runtime-driver.js')
  let reject!: (error: Error) => void
  const gate = new Promise<never>((_resolve, fail) => {
      reject = fail
    }),
    launches: string[] = []
  const driver: CommunityRuntimeDriverPort = {
    rebuild: async () => [],
    alive: async () => false,
    stop: async () => {},
    detach: async () => {},
    start: async (user, _origin, _access, signal) => {
      launches.push(user)
      if (user === 'alice') return await gate
      return await new Promise<never>((_resolve, fail) => signal.addEventListener('abort', () => fail(signal.reason), { once: true }))
    },
  }
  const runtime = new CommunityInstanceLifecycle(driver, async () => ({ url: origin, token: 'fixture' }))
  const tasks = ['alice', 'bob', 'carol'].map(user => runtime.queueStart(user, origin, async () => true).catch(error => error))
  reject(new CommunityRuntimeCleanupError('fixture incomplete removal'))
  expect(await tasks[0]).toMatchObject({ reason: 'shutdown' })
  expect(await tasks[2]).toMatchObject({ reason: 'start-cancelled' })
  await runtime.stopAll()
  expect(await tasks[1]).toMatchObject({ reason: 'start-cancelled' })
  await vi.waitFor(() => expect(launches).toEqual(['alice', 'bob']))
})

it('does not stop an already-starting joined navigation when residency is removed, but rejects a replaced account', async () => {
  const { runtime, releases } = fixture()
  let resident = true,
    current = true
  const alice = runtime.queueStart(
    'alice',
    origin,
    async () => resident,
    async () => current,
  )
  const joined = runtime.ensure('alice', origin)
  await vi.waitFor(() => expect(releases.has('alice')).toBe(true))
  resident = false
  runtime.cancelQueued('alice')
  releases.get('alice')!()
  expect(await alice).toBe(await joined)
  expect(runtime.status('alice').state).toBe('ready')
  const bob = runtime
    .queueStart(
      'bob',
      origin,
      async () => true,
      async () => current,
    )
    .catch(error => error)
  await vi.waitFor(() => expect(releases.has('bob')).toBe(true))
  current = false
  releases.get('bob')!()
  expect(await bob).toMatchObject({ reason: 'start-cancelled' })
  expect(runtime.status('bob').state).toBe('stopped')
  await runtime.stopAll()
})
