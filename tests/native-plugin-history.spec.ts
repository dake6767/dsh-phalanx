import { expect, it } from 'vitest'
import { NativePluginHistory } from '../src/use-cases/native-plugin-history.js'

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
    moveDuringLock = false
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
              read: async () => [],
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
})
