import { accountState } from './support/account-state.js'
import { expect, it } from 'vitest'
import { ServicePreview } from '../src/use-cases/service-preview.js'
import type { CommunityAccountState } from '../src/domain/community-account.js'
import type { CommunityRuntimeStatus } from '../src/ports/community-runtime.js'
import type { CommunityAccountRegistration } from '../src/ports/community-accounts.js'
import { openTestAccounts } from './support/community-application.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

it('does not register a preview after closing while its account read is pending', async () => {
  const root = await mkdtemp(join(tmpdir(), 'preview-admission-'))
  const store = await openTestAccounts(root)
  try {
    const account = await store.create({ username: 'alice', email: '', password: 'password' })
    let release!: () => void
    const pending = new Promise<void>(resolve => {
      release = resolve
    })
    const accounts = {
      getState: async (username: string) => {
        await pending
        return await store.getState(username)
      },
      withCurrentState: async <T>(username: string, register: CommunityAccountRegistration<T>) => {
        await pending
        return await store.withCurrentState(username, register)
      },
    }
    const instance = { userId: 'alice', containerName: 'owned', processId: 1, origin: 'http://runtime', launchUrl: '' }
    const preview = new ServicePreview(accounts, { status: () => ({ state: 'ready', instance }) }, { now: () => 10 }, [], {
      issue: () => 'fictional-capability',
    })
    const target = { identity: { userId: 'alice', spaceId: account.spaceId, sessionEpoch: 0, key: 'one', expiresAt: 1000 }, instance, port: 4300 }
    const registering = preview.track(target, () => {})
    preview.close()
    release()
    await expect(registering).rejects.toThrow('Preview access changed')
  } finally {
    await store.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('fences targets, revokes live previews and records only explicit gestures', async () => {
  let now = 10
  let account = { username: 'alice', spaceId: 'a', sessionEpoch: 0, disabled: false } as CommunityAccountState
  let state: CommunityRuntimeStatus = {
    state: 'ready',
    instance: { userId: 'alice', containerName: 'owned', processId: 1, origin: 'http://runtime', launchUrl: '' },
  }
  const preview = new ServicePreview(
    accountState(async user => (user === 'alice' ? account : undefined)),
    { status: () => state },
    { now: () => now },
    [4180, 3000],
    { issue: () => 'random-capability' },
  )
  const identity = { userId: 'alice', spaceId: 'a', sessionEpoch: 0, key: 'one', expiresAt: 1000 }
  for (const port of [22, 4180, 3000, 65536, NaN]) await expect(preview.admit(identity, 'a', port)).rejects.toThrow()
  await expect(preview.admit(identity, 'b', 4300)).rejects.toThrow()
  const cap = await preview.issue(identity, 'a', 4300)
  expect((await preview.resolve(cap, 'a', 4300)).identity).toBe(identity)
  await expect(preview.resolve(cap, 'b', 4300)).rejects.toThrow()
  await expect(preview.resolve(cap, 'a', 4301)).rejects.toThrow()
  await expect(preview.resolve(cap, 'a', 4300, { ...identity, key: 'other' })).rejects.toThrow()
  const target = await preview.admit(identity, 'a', 4300)
  let closed = 0
  await preview.track(target, () => {
    closed++
  })
  expect(preview.lastActivity('alice')).toBeUndefined()
  await preview.gesture(target)
  expect(preview.lastActivity('alice')).toBe(10)
  now = 20
  await preview.sweep()
  expect(preview.lastActivity('alice')).toBe(10)
  preview.revoke(identity)
  expect(closed).toBe(1)
  await expect(preview.resolve(cap, 'a', 4300)).rejects.toThrow()
  await expect(preview.track(target, () => {})).rejects.toThrow()
  const other = { ...identity, key: 'two' }
  const second = await preview.admit(other, 'a', 4300)
  await preview.track(second, () => {
    closed++
  })
  account = { ...account, disabled: true }
  await preview.sweep()
  expect(closed).toBe(2)
  account = { ...account, disabled: false }
  const third = await preview.admit(other, 'a', 4300)
  await preview.track(third, () => {
    closed++
  })
  state = { ...state, instance: { ...state.instance, processId: 2 } }
  await preview.sweep()
  expect(closed).toBe(3)
  expect(preview.lastActivity('alice')).toBeUndefined()
  state = { state: 'stopped' }
  await expect(preview.admit(other, 'a', 4300)).rejects.toThrow(/stopped/u)
})
