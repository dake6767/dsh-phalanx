import { describe, expect, it } from 'vitest'
import { webToolsCredential } from '../src/domain/shared-models.js'
import { DEEPSEEK_WEB_TOOLS_HOST } from '../src/dsh/web-tools.js'
import type { SharedModelState, SharedProvider } from '../src/domain/shared-models.js'

const provider = (id: string, overrides: Partial<SharedProvider> = {}): SharedProvider => ({
  id, name: id, baseUrl: 'https://api.deepseek.com/anthropic', apiFormat: 'anthropic-messages', apiKey: `key-${id}`, enabled: true,
  models: [{ id: 'deepseek-chat', name: 'deepseek-chat', enabled: true, input: 'text' }], ...overrides,
})
const state = (providers: SharedProvider[], defaultModelId: string | null): SharedModelState => ({ revision: 1, providers, defaultModelId })

describe('platform retrieval credential selection', () => {
  it('uses the default model provider when it is an enabled DeepSeek provider', () => {
    const first = provider('first'); const second = provider('second')
    expect(webToolsCredential(state([first, second], 'deepseek-chat'), DEEPSEEK_WEB_TOOLS_HOST)).toEqual({ apiKey: first.apiKey })
    const prefersSecond = state([first, second], null)
    expect(webToolsCredential(prefersSecond, DEEPSEEK_WEB_TOOLS_HOST)).toEqual({ apiKey: first.apiKey })
  })

  it('falls back to the first enabled DeepSeek provider when the default model is elsewhere', () => {
    const custom = provider('custom', { baseUrl: 'https://models.example.test/anthropic' })
    const deepseek = provider('deepseek')
    expect(webToolsCredential(state([custom, deepseek], 'deepseek-chat'), DEEPSEEK_WEB_TOOLS_HOST)).toEqual({ apiKey: deepseek.apiKey })
  })

  it('ignores disabled, keyless and non-DeepSeek providers', () => {
    expect(webToolsCredential(state([
      provider('disabled', { enabled: false }),
      provider('keyless', { apiKey: '' }),
      provider('proxy', { baseUrl: 'https://models.example.test/anthropic' }),
    ], null), DEEPSEEK_WEB_TOOLS_HOST)).toBeUndefined()
    expect(webToolsCredential(state([], null), DEEPSEEK_WEB_TOOLS_HOST)).toBeUndefined()
  })

  it('honours the host supplied by the retrieval seam owner', () => {
    const custom = provider('custom', { baseUrl: 'https://models.example.test/anthropic' })
    expect(webToolsCredential(state([custom], null), 'models.example.test')).toEqual({ apiKey: custom.apiKey })
    expect(webToolsCredential(state([custom], null), DEEPSEEK_WEB_TOOLS_HOST)).toBeUndefined()
  })

  it('prefers the default model provider among several DeepSeek providers', () => {
    const first = provider('first', { models: [{ id: 'one', name: 'one', enabled: true, input: 'text' }] })
    const second = provider('second', { models: [{ id: 'two', name: 'two', enabled: true, input: 'text' }] })
    expect(webToolsCredential(state([first, second], 'two'), DEEPSEEK_WEB_TOOLS_HOST)).toEqual({ apiKey: second.apiKey })
  })
})
