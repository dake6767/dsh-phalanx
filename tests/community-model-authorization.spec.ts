import { describe, expect, it } from 'vitest'
import { CommunityModelAuthorization, admitCommunityModel } from '../src/use-cases/community-model-authorization.js'
import type { CommunityAccountState } from '../src/domain/community-account.js'

describe('community default model authorization', () => {
  it('uses current account state for scoped access, preserving another member', () => {
    const states = new Map<string, CommunityAccountState>([
      ['alice', { username: 'alice', spaceId: 'space-alice', disabled: false, sessionEpoch: 0 }],
      ['bob', { username: 'bob', spaceId: 'space-bob', disabled: false, sessionEpoch: 0 }],
    ])
    const access = new Map([['opaque-alice', { username: 'alice', spaceId: 'space-alice' }], ['opaque-bob', { username: 'bob', spaceId: 'space-bob' }]])
    const authorization = new CommunityModelAuthorization({ getState: username => states.get(username) },
      { resolve: token => access.get(token) })
    expect(authorization.authorize('opaque-alice')).toBe('alice')
    expect(() => authorization.authorize(undefined)).toThrow('Model access is required')
    expect(() => authorization.authorize('wrong')).toThrow('Model access is required')
    states.set('alice', { ...states.get('alice')!, disabled: true })
    expect(() => authorization.authorize('opaque-alice')).toThrow('Model access is unavailable')
    expect(authorization.authorize('opaque-bob')).toBe('bob')
    states.delete('alice')
    expect(() => authorization.authorize('opaque-alice')).toThrow('Model access is unavailable')
  })
})


it('reuses an admitted token while authorization versions are unchanged and rechecks changed state', () => {
  let revision = 0, disabled = false, resolved = 0
  const authorization = new CommunityModelAuthorization({ version: () => revision,
    getState: username => ({ username, spaceId: 'space', disabled, sessionEpoch: 0 }) },
    { version: () => 0, resolve: () => { resolved++; return { username: 'alice', spaceId: 'space' } } })
  const admission = admitCommunityModel(authorization, 'opaque')
  expect(admission.username).toBe('alice')
  admission.current(); admission.current()
  expect(resolved).toBe(1)
  revision++; disabled = true
  expect(() => admission.current()).toThrow('Model access is unavailable')
  expect(resolved).toBe(2)
})
