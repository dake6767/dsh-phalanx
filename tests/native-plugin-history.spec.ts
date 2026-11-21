import { expect, it, onTestFinished, vi } from 'vitest'
import type { NativeOptionalBundle, NativePluginHistoryRuntime } from '../src/ports/native-plugin-history.js'
import { NativePluginHistory } from '../src/use-cases/native-plugin-history.js'

it('releases only observed missing or replaced browser deliveries from the active native generation', async () => {
  const instance = {
    userId: 'member',
    spaceId: 'space',
    resourceKey: 'launch',
    origin: 'http://native.example',
    launchUrl: 'http://native.example/launch',
    processId: 1,
  }
  const release = vi.fn(async () => {})
  const history = new NativePluginHistory(
    {
      work: {
        run: async operation =>
          operation({
            actors: { lockMember: async () => {} },
            history: { read: async () => [], remember: async () => [] },
            deliveries: {
              get: async () => [],
              browserDeliveries: async () =>
                ['kept', 'removed', 'replaced', 'unknown'].map(packageName => ({ packageName, version: '1.0.0', integrity: 'signed', revision: packageName })),
              releaseMissingBrowserDeliveries: release,
            },
          }),
      },
    },
    {
      current: () => instance,
      inspect: async () => [],
      inspectInventory: async () => ({
        optional: [],
        installed: new Map([
          ['kept', { version: '1.0.0', integrity: 'signed' }],
          ['replaced', { version: '1.0.0', integrity: null }],
          ['unknown', {}],
        ]),
      }),
    },
  )
  await history.request({ username: 'member', spaceId: 'space' }, 'launch', 'refresh', new AbortController().signal)
  expect(release).toHaveBeenCalledExactlyOnceWith('space', ['removed', 'replaced'], 'launch')
})

it('starts an old member baseline from enabled or installed official optional bundles, then retains observed successful enables', async () => {
  let saved: string[] | undefined
  let bundles = [
    { name: 'enabled', enabled: true, installed: false },
    { name: 'installed', enabled: false, installed: true },
    { name: 'never', enabled: false, installed: false },
  ]
  const instance = {
    userId: 'member',
    spaceId: 'space',
    resourceKey: 'launch',
    origin: 'http://native.example',
    launchUrl: 'http://native.example/launch',
    processId: 1,
  }
  const nativeDigest = 'sha512-native'
  const history = new NativePluginHistory(
    {
      work: {
        run: async operation =>
          operation({
            actors: { lockMember: async () => {} },
            deliveries: {
              get: async spaceId =>
                spaceId === 'space'
                  ? [
                      { packageName: 'ordinary', source: 'selected', version: '1.0.0', integrity: 'sha512-ordinary' },
                      { packageName: 'adapted', source: 'selected', version: '1.0.0', integrity: nativeDigest, serviceOrigin: 'catalog' },
                      { packageName: 'resources', source: 'preinstall', version: '1.0.0', integrity: 'sha512-resource', resourceOrigin: 'catalog' },
                    ]
                  : [],
            },
            history: {
              read: async () => saved,
              remember: async (_space, names) => {
                saved = [...new Set([...(saved ?? []), ...names])].sort()
                return saved
              },
            },
          }),
      },
    },
    { current: () => instance, inspect: async () => bundles },
  )
  const member = { username: 'member', spaceId: 'space' }
  expect(await history.initialize(member, instance, new AbortController().signal)).toEqual(['enabled', 'installed'])
  bundles = bundles.map(row => ({ ...row, enabled: row.name === 'never' }))
  expect(await history.request(member, 'launch', 'refresh', new AbortController().signal)).toEqual(['enabled', 'installed', 'never'])
  bundles = bundles.map(row => ({ ...row, enabled: false, installed: false }))
  expect(await history.request(member, 'launch', 'read', new AbortController().signal)).toEqual(['enabled', 'installed', 'never'])
  const signal = new AbortController().signal
  await expect(history.archiveReserved(member, 'launch', nativeDigest, signal)).resolves.toBe(true)
  await expect(history.archiveReserved(member, 'launch', 'sha512-resource', signal)).resolves.toBe(true)
  await expect(history.archiveReserved(member, 'launch', 'sha512-ordinary', signal)).resolves.toBe(false)
  await expect(history.archiveReserved(member, 'other-launch', nativeDigest, signal)).rejects.toMatchObject({ code: 'native-plugin-instance-stale' })
})

it('refuses stale launches and rechecks the active space before recording inspected facts', async () => {
  let current = {
    userId: 'member',
    spaceId: 'space',
    resourceKey: 'launch',
    origin: 'http://native.example',
    launchUrl: 'http://native.example/launch',
    processId: 1,
  }
  let revoked = false
  const writes: string[][] = []
  const history = new NativePluginHistory(
    {
      work: {
        run: async operation =>
          operation({
            actors: {
              lockMember: async member => {
                if (revoked || member.spaceId !== 'space') throw new Error('inactive space')
              },
            },
            deliveries: { get: async () => [] },
            history: {
              read: async () => [],
              remember: async (_space, names) => {
                writes.push([...names])
                return names
              },
            },
          }),
      },
    },
    {
      current: () => current,
      inspect: async () => {
        revoked = true
        return [{ name: 'newly-enabled', enabled: true, installed: false }]
      },
    },
  )
  const member = { username: 'member', spaceId: 'space' }
  await expect(history.request(member, 'old-launch', 'refresh', new AbortController().signal)).rejects.toMatchObject({ code: 'native-plugin-instance-stale' })
  await expect(history.request(member, 'launch', 'refresh', new AbortController().signal)).rejects.toThrow('inactive space')
  current = { ...current, userId: 'another-member' }
  await expect(history.initialize(member, current, new AbortController().signal)).rejects.toMatchObject({ code: 'native-plugin-instance-stale' })
  expect(writes).toEqual([])
})

it('checks the launch again after waiting for account locks and never records an uncertain activation', async () => {
  const member = { username: 'member', spaceId: 'space' }
  const instance = {
    userId: 'member',
    spaceId: 'space',
    resourceKey: 'launch',
    origin: 'http://native.example',
    launchUrl: 'http://native.example/launch',
    processId: 1,
  }
  let generation = 'launch',
    moveDuringLock = false,
    moveDuringRead = false
  const saved: string[] = []
  const history = new NativePluginHistory(
    {
      work: {
        run: async operation =>
          operation({
            actors: {
              lockMember: async () => {
                if (moveDuringLock) generation = 'replacement'
              },
            },
            deliveries: { get: async () => [] },
            history: {
              read: async () => {
                if (moveDuringRead) generation = 'replacement'
                return []
              },
              remember: async (_space, names) => {
                saved.push(...names)
                return saved
              },
            },
          }),
      },
    },
    { current: () => ({ ...instance, resourceKey: generation }), inspect: async () => [{ name: 'broken', enabled: true, installed: false, failed: true }] },
  )
  expect(await history.request(member, 'launch', 'refresh', new AbortController().signal)).toEqual([])
  moveDuringLock = true
  await expect(history.request(member, 'launch', 'refresh', new AbortController().signal)).rejects.toMatchObject({ code: 'native-plugin-instance-stale' })
  expect(saved).toEqual([])
  moveDuringLock = false
  moveDuringRead = true
  generation = 'launch'
  await expect(history.request(member, 'launch', 'refresh', new AbortController().signal)).rejects.toMatchObject({ code: 'native-plugin-instance-stale' })
})

const member = { username: 'member', spaceId: 'space' }
const instance = {
  userId: 'member',
  spaceId: 'space',
  resourceKey: 'launch',
  origin: 'http://native.example',
  launchUrl: 'http://native.example/launch',
  processId: 1,
}

function historyFixture(inspect: NativePluginHistoryRuntime['inspect'], controls: { lockMember?: () => Promise<void>; commit?: () => Promise<void> } = {}) {
  const lifetime = new AbortController()
  onTestFinished(() => lifetime.abort())
  let saved: readonly string[] | undefined
  const remember = vi.fn(async (_space: string, names: readonly string[]) => (saved = [...new Set([...(saved ?? []), ...names])].sort()))
  const history = new NativePluginHistory(
    {
      work: {
        run: async operation => {
          const result = await operation({
            actors: { lockMember: controls.lockMember ?? (async () => {}) },
            deliveries: { get: async () => [] },
            history: { read: async () => saved, remember },
          })
          await controls.commit?.()
          return result
        },
      },
    },
    { current: () => instance, inspect },
  )
  return {
    start: () => history.initialize(member, instance, lifetime.signal),
    request: (mode: 'read' | 'refresh') => history.request(member, instance.resourceKey, mode, lifetime.signal),
    stop: () => {
      lifetime.abort()
      return history.drainWrites(instance)
    },
    remember,
  }
}

function holdInventory() {
  let release!: (bundles: readonly NativeOptionalBundle[]) => void
  const result = new Promise<readonly NativeOptionalBundle[]>(resolve => {
    release = resolve
  })
  return { result, release }
}

it('shares a pending observation with operation refreshes and checks inventory again after the mutation', async () => {
  const first = holdInventory()
  const inspect = vi
    .fn()
    .mockReturnValueOnce(first.result)
    .mockResolvedValue([{ name: 'enabled', enabled: true, installed: true }])
  const history = historyFixture(inspect)
  const initial = history.start()
  const firstRefresh = history.request('refresh')
  const secondRefresh = history.request('refresh')
  const callsWhilePending = inspect.mock.calls.length
  first.release([])
  expect(await initial).toEqual([])
  await expect(Promise.all([firstRefresh, secondRefresh])).resolves.toEqual([['enabled'], ['enabled']])
  expect(callsWhilePending).toBe(1)
  expect(inspect).toHaveBeenCalledTimes(2)
})

it('keeps an uninitialized baseline through timeout and failure, then records what the same launch returns', async () => {
  vi.useFakeTimers()
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  onTestFinished(() => {
    warn.mockRestore()
    vi.useRealTimers()
  })
  const inspect = vi
    .fn()
    .mockRejectedValueOnce(new DOMException('fixture deadline', 'TimeoutError'))
    .mockRejectedValueOnce(new Error('fixture failure'))
    .mockResolvedValueOnce([{ name: 'disabled', enabled: false, installed: true }])
  const history = historyFixture(inspect)
  await expect(history.start()).rejects.toMatchObject({ name: 'TimeoutError' })
  await expect(history.request('read')).rejects.toMatchObject({ code: 'native-plugin-history-unavailable' })
  expect(inspect).toHaveBeenCalledTimes(1)
  await vi.advanceTimersToNextTimerAsync()
  await expect(history.request('read')).rejects.toMatchObject({ code: 'native-plugin-history-unavailable' })
  await vi.advanceTimersToNextTimerAsync()
  await expect(history.request('read')).resolves.toEqual(['disabled'])
  expect(inspect).toHaveBeenCalledTimes(3)
  expect(warn.mock.calls).toEqual([['Native plugin history observation timed out'], ['Native plugin history observation failed']])
})

it('does not write a result returned after stop even if the inventory ignores cancellation', async () => {
  const pending = holdInventory()
  const history = historyFixture(() => pending.result)
  const initial = history.start()
  await history.stop()
  pending.release([])
  await expect(initial).rejects.toMatchObject({ name: 'AbortError' })
  expect(history.remember).not.toHaveBeenCalled()
})

it('waits for an already submitted history transaction before retiring the launch', async () => {
  let finishCommit!: () => void, enteredCommit!: () => void
  const commit = new Promise<void>(resolve => {
      finishCommit = resolve
    }),
    entered = new Promise<void>(resolve => {
      enteredCommit = resolve
    })
  const events: string[] = []
  const history = historyFixture(async () => [], {
    commit: async () => {
      enteredCommit()
      await commit
      events.push('committed')
    },
  })
  const initial = history.start()
  await entered
  const stopped = history.stop().then(() => events.push('retired'))
  await Promise.resolve()
  finishCommit()
  await Promise.all([initial, stopped])
  expect(events).toEqual(['committed', 'retired'])
})

it('wakes the same observation during maximum backoff after a plugin operation', async () => {
  vi.useFakeTimers()
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  onTestFinished(() => {
    warn.mockRestore()
    vi.useRealTimers()
  })
  let enabled = false
  const inspect = vi.fn().mockResolvedValueOnce([])
  for (let i = 0; i < 6; i++) inspect.mockRejectedValueOnce(new Error('fixture failure'))
  inspect.mockImplementation(async () => {
    await new Promise<void>(resolve => setTimeout(resolve, 10_000))
    return [{ name: 'optional', enabled, installed: true }]
  })
  const history = historyFixture(inspect)
  await expect(history.start()).resolves.toEqual([])
  await expect(history.request('refresh')).rejects.toThrow('fixture failure')
  for (let i = 0; i < 5; i++) await vi.advanceTimersToNextTimerAsync()
  expect(inspect).toHaveBeenCalledTimes(7)
  enabled = true
  const mutation = history.request('refresh').then(() => {
    enabled = false
  })
  await expect(history.request('read')).resolves.toEqual([])
  expect(enabled).toBe(true)
  expect(inspect).toHaveBeenCalledTimes(8)
  await vi.advanceTimersByTimeAsync(10_000)
  await mutation
  await expect(history.request('read')).resolves.toEqual(['optional'])
})

it('does not delay retirement for an observation still waiting on the member lock', async () => {
  let unlock!: () => void, locked!: () => void
  const waiting = new Promise<void>(resolve => {
      unlock = resolve
    }),
    entered = new Promise<void>(resolve => {
      locked = resolve
    })
  const history = historyFixture(async () => [], {
    lockMember: async () => {
      locked()
      await waiting
    },
  })
  const initial = history.start()
  await entered
  await history.stop()
  unlock()
  await expect(initial).rejects.toMatchObject({ name: 'AbortError' })
  expect(history.remember).not.toHaveBeenCalled()
})
