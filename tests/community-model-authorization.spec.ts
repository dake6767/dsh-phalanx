import { accountState } from './support/account-state.js'
import { describe, expect, it } from 'vitest'
import { CommunityModelAuthorization, admitCommunityModel } from '../src/use-cases/community-model-authorization.js'
import type { CommunityAccountState } from '../src/domain/community-account.js'
import type { CommunityAccountRegistration } from '../src/ports/community-accounts.js'
import { openTestAccounts } from './support/community-application.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('community default model authorization', () => {
  it('uses current account state for scoped access, preserving another member', async () => {
    const states = new Map<string, CommunityAccountState>([
      ['alice', { username: 'alice', spaceId: 'space-alice', disabled: false, sessionEpoch: 0 }],
      ['bob', { username: 'bob', spaceId: 'space-bob', disabled: false, sessionEpoch: 0 }],
    ])
    const access = new Map([
      ['opaque-alice', { username: 'alice', spaceId: 'space-alice' }],
      ['opaque-bob', { username: 'bob', spaceId: 'space-bob' }],
    ])
    const authorization = new CommunityModelAuthorization(
      accountState(username => states.get(username)),
      { resolve: token => access.get(token) },
    )
    expect(await authorization.authorize('opaque-alice')).toBe('alice')
    await expect(authorization.authorize(undefined)).rejects.toThrow('Model access is required')
    await expect(authorization.authorize('wrong')).rejects.toThrow('Model access is required')
    states.set('alice', { ...states.get('alice')!, disabled: true })
    await expect(authorization.authorize('opaque-alice')).rejects.toThrow('Model access is unavailable')
    expect(await authorization.authorize('opaque-bob')).toBe('bob')
    states.delete('alice')
    await expect(authorization.authorize('opaque-alice')).rejects.toThrow('Model access is unavailable')
  })
})

it('refuses registration when a token is revoked while the account read is pending', async () => {
  const root = await mkdtemp(join(tmpdir(), 'account-admission-'))
  const store = await openTestAccounts(root)
  try {
    const member = await store.create({ username: 'member', email: '', password: 'password' })
    let release!: () => void
    const pending = new Promise<void>(resolve => {
      release = resolve
    })
    const accounts = {
      getState: store.getState.bind(store),
      get: store.get.bind(store),
      withCurrentState: async <T>(username: string, register: CommunityAccountRegistration<T>) => {
        await pending
        return await store.withCurrentState(username, register)
      },
    }
    let revoked = false,
      connected = false
    const authorization = new CommunityModelAuthorization(accounts, {
      resolve: () => (revoked ? undefined : { username: member.username, spaceId: member.spaceId }),
    })
    const admission = authorization.register('fictional-token', () => {
      connected = true
    })
    revoked = true
    release()
    await expect(admission).rejects.toThrow('Model access is required')
    expect(connected).toBe(false)
  } finally {
    await store.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('rechecks durable state for every boundary without a storage revision cache', async () => {
  let disabled = false
  const authorization = new CommunityModelAuthorization(
    accountState(username => ({ username, spaceId: 'space', disabled, sessionEpoch: 0 })),
    { resolve: () => ({ username: 'alice', spaceId: 'space' }) },
  )
  const admission = await admitCommunityModel(authorization, 'opaque')
  expect(admission.username).toBe('alice')
  expect(await admission.current()).toBe('alice')
  disabled = true
  await expect(admission.current()).rejects.toThrow('Model access is unavailable')
})
