import { describe, expect, it } from 'vitest'
import { CommunityEntry } from '../src/use-cases/community-entry.js'
import type { CommunityAccountRecord } from '../src/domain/community-account.js'
import { CommunityRuntimeUnavailableError, type CommunityRuntimePort } from '../src/ports/community-runtime.js'

const account: CommunityAccountRecord = { username: 'member', email: 'member@example.test', admin: false, groupId: 'default',
  spaceId: 'fixture-space', disabled: false, sessionEpoch: 0, createdAt: 0, updatedAt: 0 }
const instance = { userId: 'member', origin: 'http://127.0.0.1:4000', launchUrl: 'http://127.0.0.1:4000/?token=fixture', processId: 4000 }
const runtime: CommunityRuntimePort = { ensure: async () => instance, status: () => ({ state: 'ready', instance }),
  recover: async () => { throw new Error('Unexpected recovery') }, restart: async () => { throw new Error('Not used') }, reclaim: async () => 'not-running', terminate: async () => {}, stopAll: async () => {},
  reconcileStartupContainers: async () => ({ adopted: [], swept: [] }) }

describe('community entry identity', () => {
  it('uses the fresh durable space and passes the complete browser origin to startup', async () => {
    let current = account
    let authority: string | undefined
    const entry = new CommunityEntry({ getState: () => current, authenticate: async () => current },
      { ...runtime, ensure: async (_user, origin) => { authority = origin; return instance } },
      { exchangeLaunchToken: async () => [] })
    expect(entry.spacePath('member')).toBe('/app/fixture-space/')
    await entry.ensure('member', new URL('https://example.test:18443'))
    expect(authority).toBe('https://example.test:18443/')
    current = { ...account, spaceId: 'replacement-space' }
    expect(entry.spacePath('member')).toBe('/app/replacement-space/')
    current = { ...current, disabled: true }
    expect(() => entry.spacePath('member')).toThrow('Account is no longer active')
  })
  it('admits administrators to management without starting DSH', async () => {
    const admin = { ...account, admin: true }
    const entry = new CommunityEntry({ getState: () => admin, authenticate: async () => admin },
      { ...runtime, ensure: async () => { throw new Error('DSH unavailable') } },
      { exchangeLaunchToken: async () => { throw new Error('DSH unavailable') } })
    expect(await entry.signIn('member', 'password')).toEqual({ account: admin, cookies: [] })
    await expect(entry.openSpace(admin, new URL('http://localhost'))).rejects.toMatchObject({ reason: 'startup-unavailable' })
  })
  it('refuses launch cookies after the account epoch changes during DSH startup', async () => {
    let current = account
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const entry = new CommunityEntry({ getState: () => current, authenticate: async () => current }, runtime,
      { exchangeLaunchToken: async () => { entered(); await gate; return ['fixture_cookie=accepted'] } })
    const signIn = entry.openSpace(account, new URL('http://127.0.0.1:3080'))
    const refused = expect(signIn).rejects.toMatchObject({ reason: 'authorization-unavailable' })
    await started
    current = { ...current, sessionEpoch: 1 }
    release()
    await refused
  })
})

it('authenticates independently of DSH availability while preserving authentication revocation', async () => {
  let current = account
  const entry = new CommunityEntry({ getState: () => current, authenticate: async () => account },
    { ...runtime, ensure: async () => { throw new CommunityRuntimeUnavailableError('profile-unavailable', 'Bad fixture profile') } },
    { exchangeLaunchToken: async () => [] })
  expect(await entry.signIn('member', 'password')).toEqual({ account, cookies: [] })
  current = { ...account, sessionEpoch: 1 }
  await expect(entry.signIn('member', 'password')).rejects.toMatchObject({ reason: 'authorization-unavailable' })
})

it('authenticates a member without starting DSH or exchanging launch cookies', async () => {
  let starts = 0, exchanges = 0
  const entry = new CommunityEntry({ getState: () => account, authenticate: async () => account },
    { ...runtime, ensure: async () => { starts++; throw new Error('Fixture startup must not run during login') } },
    { exchangeLaunchToken: async () => { exchanges++; return ['fixture_cookie=accepted'] } })
  expect(await entry.signIn('member', 'password')).toEqual({ account, cookies: [] })
  expect(starts).toBe(0)
  expect(exchanges).toBe(0)
})

it('shares a background start and exposes only its current product stage or safe failure code', async () => {
  let release!: () => void, entered!: () => void, starts = 0
  const gate = new Promise<void>(resolve => { release = resolve })
  const began = new Promise<void>(resolve => { entered = resolve })
  let phase: 'stopped' | 'starting' | 'ready' = 'stopped'
  let stage: 'preparing' | 'starting' | 'connecting' = 'preparing'
  const entry = new CommunityEntry({ getState: () => account, authenticate: async () => account },
    { ...runtime, status: () => phase === 'ready' ? { state: 'ready', instance } : phase === 'starting' ? { state: 'starting', stage } : { state: 'stopped' },
      ensure: async () => { starts++; phase = 'starting'; entered(); await gate; phase = 'ready'; return instance } },
    { exchangeLaunchToken: async () => [] })
  const first = entry.start('member', new URL('http://localhost'))
  const second = entry.start('member', new URL('http://localhost'))
  await began
  expect(starts).toBe(1)
  expect(entry.startup('member')).toEqual({ state: 'preparing' })
  stage = 'starting'; expect(entry.startup('member')).toEqual({ state: 'starting' })
  stage = 'connecting'; expect(entry.startup('member')).toEqual({ state: 'connecting' })
  release(); await Promise.all([first, second])
  expect(entry.startup('member')).toEqual({ state: 'ready' })
  phase = 'stopped'
  const failed = new CommunityEntry({ getState: () => account, authenticate: async () => account },
    { ...runtime, status: () => ({ state: 'stopped' }), ensure: async () => { throw new Error('/private/fixture secret=must-not-leak') } },
    { exchangeLaunchToken: async () => [] })
  await failed.start('member', new URL('http://localhost'))
  expect(failed.startup('member')).toEqual({ state: 'failed', code: 'runtime-startup-unavailable' })
})

it('reports a safe failed stage when private storage cannot be reached', () => {
  const entry = new CommunityEntry({ getState: () => account, authenticate: async () => account }, runtime,
    { exchangeLaunchToken: async () => [] }, { assertAvailable: () => { throw new CommunityRuntimeUnavailableError('storage-unavailable', 'PRIVATE_HOST_PATH') } })
  expect(entry.startup('member')).toEqual({ state: 'failed', code: 'runtime-storage-unavailable' })
})

it('keeps exchanged cookies paired with the exact carrier when replacement wins the continuation boundary', async () => {
  const replacement = { ...instance, processId: 5000, origin: 'http://127.0.0.1:5000' }
  let current = instance
  const entry = new CommunityEntry({ getState: () => account, authenticate: async () => account },
    { ...runtime, status: () => { const snapshot = current; queueMicrotask(() => { current = replacement }); return { state: 'ready', instance: snapshot } } },
    { exchangeLaunchToken: async () => ['fixture_session=carrier-4000'] })
  const admitted = await entry.navigate('member', new URL('http://localhost'), undefined)
  expect(admitted).toEqual({ instance, cookies: ['fixture_session=carrier-4000'] })
})
