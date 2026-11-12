import { expect, it } from 'vitest'
import { nativeFeatureInput } from '../src/inbound/native-feature-route.js'

it('accepts the closed revision and disabled-id contract, refusing extra fields and malformed selections', () => {
  expect(nativeFeatureInput({ revision: 'opaque', disabledIds: ['terminal'] })).toEqual({ revision: 'opaque', disabledIds: ['terminal'] })
  expect(nativeFeatureInput({ revision: 'opaque', showAppCenter: true })).toEqual({ revision: 'opaque', showAppCenter: true })
  expect(nativeFeatureInput({ revision: 'opaque', disabledIds: [], showAppCenter: false })).toEqual({
    revision: 'opaque',
    disabledIds: [],
    showAppCenter: false,
  })
  for (const value of [
    null,
    [],
    {},
    { revision: 'x' },
    { revision: '', disabledIds: [] },
    { revision: 'x', disabledIds: [1] },
    { revision: 'x', disabledIds: ['terminal', 'terminal'] },
    { revision: 'x', disabledIds: [], groupId: 'other' },
    { revision: 'x', disabledIds: [], showAppCenter: 'true' },
    { revision: 'x', disabledIds: [], showAppCenter: null },
    { revision: 'x', disabledIds: ['../terminal'] },
  ])
    expect(() => nativeFeatureInput(value)).toThrow(expect.objectContaining({ code: 'native-features-invalid' }))
})
