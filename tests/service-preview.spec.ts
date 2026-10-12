import { expect, it } from 'vitest'
import { ServicePreview } from '../src/use-cases/service-preview.js'
import type { CommunityAccountState } from '../src/domain/community-account.js'
import type { CommunityRuntimeStatus } from '../src/ports/community-runtime.js'

it('fences targets, revokes live previews and records only explicit gestures', () => {
  let now = 10
  let account = { username: 'alice', spaceId: 'a', sessionEpoch: 0, disabled: false } as CommunityAccountState
  let state: CommunityRuntimeStatus = { state: 'ready', instance: { userId: 'alice', containerName: 'owned', processId: 1, origin: 'http://runtime', launchUrl: '' } }
  const preview = new ServicePreview({ getState: user => user === 'alice' ? account : undefined }, { status: () => state }, { now: () => now }, [4180, 3000], { issue: () => 'random-capability' })
  const identity = { userId: 'alice', spaceId: 'a', sessionEpoch: 0, key: 'one', expiresAt: 1000 }
  for (const port of [22, 4180, 3000, 65536, NaN]) expect(() => preview.admit(identity, 'a', port)).toThrow()
  expect(() => preview.admit(identity, 'b', 4300)).toThrow()
  const cap = preview.issue(identity, 'a', 4300)
  expect(preview.resolve(cap, 'a', 4300).identity).toBe(identity)
  expect(() => preview.resolve(cap, 'b', 4300)).toThrow()
  expect(() => preview.resolve(cap, 'a', 4301)).toThrow()
  expect(() => preview.resolve(cap, 'a', 4300, { ...identity, key: 'other' })).toThrow()
  const target = preview.admit(identity, 'a', 4300)
  let closed = 0; preview.track(target, () => { closed++ })
  expect(preview.lastActivity('alice')).toBeUndefined()
  preview.gesture(target); expect(preview.lastActivity('alice')).toBe(10)
  now = 20; preview.sweep(); expect(preview.lastActivity('alice')).toBe(10)
  preview.revoke(identity); expect(closed).toBe(1)
  expect(() => preview.resolve(cap, 'a', 4300)).toThrow()
  expect(() => preview.track(target, () => {})).toThrow()
  const other = { ...identity, key: 'two' }
  const second = preview.admit(other, 'a', 4300); preview.track(second, () => { closed++ })
  account = { ...account, disabled: true }; preview.sweep(); expect(closed).toBe(2)
  account = { ...account, disabled: false }
  const third = preview.admit(other, 'a', 4300); preview.track(third, () => { closed++ })
  state = { ...state, instance: { ...state.instance, processId: 2 } }; preview.sweep()
  expect(closed).toBe(3); expect(preview.lastActivity('alice')).toBeUndefined()
  state = { state: 'stopped' }; expect(() => preview.admit(other, 'a', 4300)).toThrow(/stopped/u)
})
