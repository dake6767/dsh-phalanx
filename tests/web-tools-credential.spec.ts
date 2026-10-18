import { describe, expect, it } from 'vitest'
import { webToolsCredential } from '../src/domain/shared-models.js'
import type { SharedModelState, SharedProvider } from '../src/domain/shared-models.js'

const provider = (id: string, overrides: Partial<SharedProvider> = {}): SharedProvider => ({
  id, name: id, baseUrl: 'https://api.deepseek.com/anthropic', apiFormat: 'anthropic-messages', apiKey: `key-${id}`, enabled: true,
  models: [{ id: 'deepseek-chat', name: 'deepseek-chat', enabled: true }], ...overrides,
})
const state = (providers: SharedProvider[], defaultModelId: string | null): SharedModelState => ({ revision: 1, providers, defaultModelId })

describe('platform retrieval credential selection', () => {
  it('uses the default model provider when it is an enabled DeepSeek provider', () => {
    const first = provider('first'); const second = provider('second')
    expect(webToolsCredential(state([first, second], 'deepseek-chat'))).toEqual({ apiKey: first.apiKey })
    const prefersSecond = state([first, second], null)
    expect(webToolsCredential(prefersSecond)).toEqual({ apiKey: first.apiKey })
  })

  it('falls back to the first enabled DeepSeek provider when the default model is elsewhere', () => {
    const custom = provider('custom', { baseUrl: 'https://models.example.test/anthropic' })
    const deepseek = provider('deepseek')
    expect(webToolsCredential(state([custom, deepseek], 'deepseek-chat'))).toEqual({ apiKey: deepseek.apiKey })
  })

  it('ignores disabled, keyless and non-DeepSeek providers', () => {
    expect(webToolsCredential(state([
      provider('disabled', { enabled: false }),
      provider('keyless', { apiKey: '' }),
      provider('proxy', { baseUrl: 'https://models.example.test/anthropic' }),
    ], null))).toBeUndefined()
    expect(webToolsCredential(state([], null))).toBeUndefined()
  })

  it('prefers the default model provider among several DeepSeek providers', () => {
    const first = provider('first', { models: [{ id: 'one', name: 'one', enabled: true }] })
    const second = provider('second', { models: [{ id: 'two', name: 'two', enabled: true }] })
    expect(webToolsCredential(state([first, second], 'two'))).toEqual({ apiKey: second.apiKey })
  })
})
