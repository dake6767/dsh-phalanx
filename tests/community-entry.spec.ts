import { describe, expect, it } from 'vitest'
import { CommunityEntry } from '../src/use-cases/community-entry.js'
import type { CommunityAccountRecord } from '../src/domain/community-account.js'
import { CommunityRuntimeUnavailableError, type CommunityRuntimePort } from '../src/ports/community-runtime.js'

const account: CommunityAccountRecord = { username: 'member', email: 'member@example.test', admin: false,
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
    expect(await entry.signIn('member', 'password', new URL('http://localhost'))).toEqual({ account: admin, cookies: [] })
    await expect(entry.openSpace(admin, new URL('http://localhost'))).rejects.toMatchObject({ reason: 'startup-unavailable' })
  })
  it('refuses to issue a login after the account epoch changes during DSH startup', async () => {
    let current = account
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const entry = new CommunityEntry({ getState: () => current, authenticate: async () => current }, runtime,
      { exchangeLaunchToken: async () => { entered(); await gate; return ['fixture_cookie=accepted'] } })
    const signIn = entry.signIn('member', 'password', new URL('http://127.0.0.1:3080'))
    const refused = expect(signIn).rejects.toMatchObject({ reason: 'authorization-unavailable' })
    await started
    current = { ...current, sessionEpoch: 1 }
    release()
    await refused
  })
})

it('admits valid member credentials to recovery when its DSH cannot start, while preserving authentication revocation', async () => {
  let current = account
  const entry = new CommunityEntry({ getState: () => current, authenticate: async () => account },
    { ...runtime, ensure: async () => { throw new CommunityRuntimeUnavailableError('profile-unavailable', 'Bad fixture profile') } },
    { exchangeLaunchToken: async () => [] })
  expect(await entry.signIn('member', 'password', new URL('http://localhost'))).toEqual({ account, cookies: [], recovery: true })
  current = { ...account, sessionEpoch: 1 }
  await expect(entry.signIn('member', 'password', new URL('http://localhost'))).rejects.toMatchObject({ reason: 'authorization-unavailable' })
})
