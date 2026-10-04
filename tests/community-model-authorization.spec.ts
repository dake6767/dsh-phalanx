import { describe, expect, it } from 'vitest'
import { CommunityModelAuthorization } from '../src/use-cases/community-model-authorization.js'
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
