import { describe, expect, it } from 'vitest'
import {
  managedModelCatalog,
  managedModelConfiguration,
  managedModelWatchModule,
  publicSharedModels,
  sharedModelProviderKey,
  sharedModelSelection,
} from '../src/dsh/shared-models.js'
import { knownModelInput, normalizeSharedModelState, type SharedModelState } from '../src/domain/shared-models.js'

const state = (): SharedModelState => ({
  revision: 2,
  defaultModelId: 'flash',
  providers: [
    {
      id: '61626364313233343536373839303132',
      name: 'Shared',
      baseUrl: 'https://models.example.test/anthropic',
      apiFormat: 'anthropic-messages',
      apiKey: 'fixture-key',
      enabled: true,
      models: [
        { id: 'flash', name: 'deepseek-flash', enabled: true, input: 'text+image' },
        { id: 'text', name: 'custom-chat', enabled: true, input: 'text' },
        { id: 'disabled', name: 'disabled-chat', enabled: false, input: 'text+image' },
      ],
    },
    {
      id: '6465666768696a6b6c6d6e6f70717273',
      name: 'Second',
      baseUrl: 'https://second.example.test/anthropic',
      apiFormat: 'anthropic-messages',
      apiKey: 'fixture-key',
      enabled: true,
      models: [{ id: 'chat', name: 'second-chat', enabled: true, input: 'text' }],
    },
    {
      id: '64697361626c65642d70726f766964',
      name: 'Disabled',
      baseUrl: 'https://disabled.example.test/anthropic',
      apiFormat: 'anthropic-messages',
      apiKey: 'fixture-key',
      enabled: false,
      models: [{ id: 'hidden', name: 'hidden-chat', enabled: true, input: 'text+image' }],
    },
  ],
})

describe('shared model DSH input declarations', () => {
  it('names every entry by its model only and keeps enabled models of enabled providers', () => {
    expect(publicSharedModels(state())).toEqual([
      { id: 'flash', name: 'deepseek-flash', input: ['text', 'image'] },
      { id: 'text', name: 'custom-chat', input: ['text'] },
      { id: 'chat', name: 'second-chat', input: ['text'] },
    ])
  })

  it('keeps the explanation route selectable in the entering browser language without image input', () => {
    expect(publicSharedModels({ revision: 0, providers: [], defaultModelId: null }, 'en')).toEqual([
      { id: 'unconfigured', name: 'Shared models not configured', input: ['text'] },
    ])
    expect(publicSharedModels({ revision: 0, providers: [], defaultModelId: null }, 'zh-CN')).toEqual([
      { id: 'unconfigured', name: '共享模型未配置', input: ['text'] },
    ])
  })
})

describe('per-provider DSH catalog', () => {
  const rows = () =>
    JSON.parse(managedModelCatalog(state(), 'en')) as Array<{ id: string; config: { providers: Record<string, unknown> } & Record<string, unknown> }>

  it('writes each supplier protocol as the DSH provider api value', () => {
    const protocols: SharedModelState = {
      revision: 1,
      defaultModelId: 'messages',
      providers: [
        {
          id: '0123456789abcdef0123456789abcdef',
          name: 'Messages supplier',
          baseUrl: 'https://messages.example.test',
          apiFormat: 'anthropic-messages',
          apiKey: 'fixture-key',
          enabled: true,
          models: [{ id: 'messages', name: 'messages-model', enabled: true, input: 'text' }],
        },
        {
          id: 'fedcba9876543210fedcba9876543210',
          name: 'Completions supplier',
          baseUrl: 'https://completions.example.test/v1',
          apiFormat: 'openai-completions',
          apiKey: 'fixture-key',
          enabled: true,
          models: [{ id: 'completions', name: 'completions-model', enabled: true, input: 'text' }],
        },
        {
          id: '00112233445566778899aabbccddeeff',
          name: 'Responses supplier',
          baseUrl: 'https://responses.example.test/v1',
          apiFormat: 'openai-responses',
          apiKey: 'fixture-key',
          enabled: true,
          models: [{ id: 'responses', name: 'responses-model', enabled: true, input: 'text' }],
        },
      ],
    }
    const catalog = JSON.parse(managedModelCatalog(protocols, 'en')) as Array<{
      id: string
      config: { providers: Record<string, { api: string; displayName: string }> }
    }>
    const providers = catalog.find(row => row.id === 'phalanx-shared-models')!.config.providers
    expect(providers['phalanx-0123456789abcdef0123456789abcdef']).toMatchObject({ displayName: 'Messages supplier', api: 'anthropic-messages' })
    expect(providers['phalanx-fedcba9876543210fedcba9876543210']).toMatchObject({ displayName: 'Completions supplier', api: 'openai-completions' })
    expect(providers['phalanx-00112233445566778899aabbccddeeff']).toMatchObject({ displayName: 'Responses supplier', api: 'openai-responses' })
    const include = JSON.parse(managedModelConfiguration(protocols, '/dsh-phalanx/managed-models', { adapter: '@deepseek-ai/dsh-llm-pi-ai' })) as Array<{
      id: string
      config: { providers: Record<string, { api: string }> }
    }>
    const adapter = include.find(row => row.id === 'phalanx-shared-models')!.config.providers
    expect(adapter['phalanx-0123456789abcdef0123456789abcdef']!.api).toBe('anthropic-messages')
    expect(adapter['phalanx-fedcba9876543210fedcba9876543210']!.api).toBe('openai-completions')
    expect(adapter['phalanx-00112233445566778899aabbccddeeff']!.api).toBe('openai-responses')
  })

  it('retains DeepSeek wire compatibility behind an opaque model gateway without affecting other suppliers', () => {
    const compatibility = (baseUrl: string, apiFormat: SharedModelState['providers'][number]['apiFormat'] = 'openai-completions') => {
      const provider = state().providers[0]!
      const supplied = { ...state(), providers: [{ ...provider, baseUrl, apiFormat, models: [{ ...provider.models[0]!, reasoning: true }] }] }
      const catalog = JSON.parse(managedModelCatalog(supplied, 'en'))
      const route = catalog[0].config.providers[sharedModelProviderKey(provider.id)]
      expect(JSON.stringify(route)).not.toContain(baseUrl)
      expect(JSON.stringify(route)).not.toContain(provider.apiKey)
      return route.compat
    }
    const expected = {
      supportsStore: false,
      supportsDeveloperRole: false,
      maxTokensField: 'max_tokens',
      requiresReasoningContentOnAssistantMessages: true,
      thinkingFormat: 'deepseek',
    }
    expect(compatibility('https://api.deepseek.com')).toEqual(expected)
    expect(compatibility('https://api.deepseek.com/v1')).toEqual(expected)
    expect(compatibility('https://api.deepseek.com/anthropic', 'anthropic-messages')).toBeUndefined()
    expect(compatibility('https://api.deepseek.com/v1', 'openai-responses')).toBeUndefined()
    expect(compatibility('https://api.openai.com/v1')).toBeUndefined()
    expect(compatibility('https://api.deepseek.com.example.test/v1')).toBeUndefined()
    expect(compatibility('https://models.example.test/api.deepseek.com')).toBeUndefined()
  })

  it('keeps the Anthropic Messages protocol on the explanation provider', () => {
    const catalog = JSON.parse(managedModelCatalog({ revision: 0, providers: [], defaultModelId: null }, 'en')) as Array<{
      id: string
      config: { providers: Record<string, { api: string }> }
    }>
    const providers = catalog.find(row => row.id === 'phalanx-shared-models')!.config.providers
    expect(providers['phalanx-unconfigured']).toMatchObject({ api: 'anthropic-messages' })
  })

  it('writes one provider entry per enabled supplier named by the supplier, without the fixed shared title', () => {
    const providers = rows().find(row => row.id === 'phalanx-shared-models')!.config.providers
    expect(Object.keys(providers)).toEqual(['phalanx-61626364313233343536373839303132', 'phalanx-6465666768696a6b6c6d6e6f70717273'])
    expect(providers['phalanx-61626364313233343536373839303132']).toMatchObject({
      displayName: 'Shared',
      api: 'anthropic-messages',
      apiKeyEnv: 'DSH_PHALANX_MODEL_GATEWAY_ACCESS_TOKEN',
      models: [
        { id: 'flash', name: 'deepseek-flash', input: ['text', 'image'] },
        { id: 'text', name: 'custom-chat', input: ['text'] },
      ],
    })
    expect(providers['phalanx-6465666768696a6b6c6d6e6f70717273']).toMatchObject({ displayName: 'Second', models: [{ id: 'chat', name: 'second-chat' }] })
  })

  it('expresses the default selection through the provider that owns the model', () => {
    expect(rows().find(row => row.id === 'phalanx-default-model')!.config).toEqual({
      provider: 'phalanx-61626364313233343536373839303132',
      model: 'flash',
    })
  })

  it('derives a stable provider key from the supplier identity', () => {
    expect(sharedModelProviderKey('61626364313233343536373839303132')).toBe('phalanx-61626364313233343536373839303132')
    expect(sharedModelSelection(state(), 'chat')).toEqual({ provider: 'phalanx-6465666768696a6b6c6d6e6f70717273', model: 'chat' })
    expect(sharedModelSelection({ revision: 0, providers: [], defaultModelId: null }, 'flash')).toEqual({
      provider: 'phalanx-unconfigured',
      model: 'unconfigured',
    })
  })

  it('keeps no fixed shared title when suppliers exist and refreshes every managed key in the watcher', () => {
    const catalog = managedModelCatalog(state(), 'en')
    expect(catalog).not.toContain('Shared models')
    // The generated watcher refreshes every provider key and refuses managed keys whose model list is gone.
    expect(managedModelWatchModule).toContain('for (const provider of Object.values(next.config.providers)) provider.baseURL')
    expect(managedModelWatchModule).toContain("String(request.provider).startsWith('phalanx-')")
    expect(managedModelWatchModule).toContain('(provider === undefined || !provider.models.some(model => model.id === request.model))')
  })

  it('keeps the explanation entry when an enabled supplier has no enabled model', () => {
    const enabledWithoutModels: SharedModelState = {
      revision: 1,
      defaultModelId: null,
      providers: [
        {
          id: '61626364313233343536373839303132',
          name: 'Shared',
          baseUrl: 'https://models.example.test/anthropic',
          apiFormat: 'anthropic-messages',
          apiKey: 'fixture-key',
          enabled: true,
          models: [{ id: 'off', name: 'disabled-chat', enabled: false, input: 'text' }],
        },
      ],
    }
    expect(publicSharedModels(enabledWithoutModels, 'en')).toEqual([{ id: 'unconfigured', name: 'Shared models not configured', input: ['text'] }])
    const providers = JSON.parse(managedModelCatalog(enabledWithoutModels, 'en'))[0].config.providers
    expect(Object.keys(providers)).toEqual(['phalanx-unconfigured'])
  })

  it('writes every provider into the shared adapter include with the gateway base URL', () => {
    const include = JSON.parse(managedModelConfiguration(state(), '/dsh-phalanx/managed-models', { adapter: '@deepseek-ai/dsh-llm-pi-ai' })) as Array<{
      id: string
      name: string
      config: { providers: Record<string, { baseURL: unknown }> }
    }>
    const adapter = include.find(row => row.id === 'phalanx-shared-models')!
    expect(adapter.name).toBe('@deepseek-ai/dsh-llm-pi-ai')
    expect(Object.keys(adapter.config.providers)).toEqual(['phalanx-61626364313233343536373839303132', 'phalanx-6465666768696a6b6c6d6e6f70717273'])
    for (const row of Object.values(adapter.config.providers)) expect(row.baseURL).toEqual({ __jsExpr: 'process.env.DSH_PHALANX_MODEL_GATEWAY_URL' })
  })
})

describe('known model input table', () => {
  it('defaults known image models to text and image and everything else to text', () => {
    expect(knownModelInput('deepseek-flash')).toBe('text+image')
    expect(knownModelInput('deepseek-v4-pro')).toBe('text')
    expect(knownModelInput('custom-chat')).toBe('text')
  })

  it('fills missing declarations on load and keeps an already complete state unchanged', () => {
    const legacy = {
      revision: 3,
      providers: [
        {
          id: 'provider',
          name: 'Shared',
          baseUrl: 'https://models.example.test/anthropic',
          apiFormat: 'anthropic-messages',
          apiKey: 'fixture-key',
          enabled: true,
          models: [
            { id: 'flash', name: 'deepseek-flash', enabled: true },
            { id: 'custom', name: 'custom-chat', enabled: true },
          ],
        },
      ],
      defaultModelId: 'flash',
    } as unknown as SharedModelState
    const normalized = normalizeSharedModelState(legacy)
    expect(normalized.providers[0]!.models).toEqual([
      { id: 'flash', name: 'deepseek-flash', enabled: true, input: 'text+image', reasoning: false },
      { id: 'custom', name: 'custom-chat', enabled: true, input: 'text', reasoning: false },
    ])
    expect(normalizeSharedModelState(normalized)).toEqual(normalized)
  })

  it('repairs an unrecognized stored declaration to text instead of granting image input', () => {
    const corrupt = {
      revision: 1,
      providers: [
        {
          id: 'provider',
          name: 'Shared',
          baseUrl: 'https://models.example.test/anthropic',
          apiFormat: 'anthropic-messages',
          apiKey: 'fixture-key',
          enabled: true,
          models: [{ id: 'flash', name: 'deepseek-flash', enabled: true, input: 'audio' }],
        },
      ],
      defaultModelId: 'flash',
    } as unknown as SharedModelState
    expect(normalizeSharedModelState(corrupt).providers[0]!.models[0]!.input).toBe('text')
  })
})

describe('shared model reasoning capability', () => {
  it('declares only opted-in model efforts and leaves platform defaults unset', () => {
    const source = state()
    const enabled = {
      ...source,
      providers: source.providers.map(provider => ({ ...provider, models: provider.models.map(model => ({ ...model, reasoning: model.id === 'flash' })) })),
    }
    const catalog = JSON.parse(managedModelCatalog(enabled))
    const models = catalog[0].config.providers['phalanx-61626364313233343536373839303132'].models
    expect(models[0].reasoningEfforts).toEqual({ off: null, low: 'low', medium: 'medium', high: 'high' })
    expect(models[1].reasoningEfforts ?? false).toBe(false)
    expect(publicSharedModels(enabled)[0]).toHaveProperty('reasoningEfforts', { off: null, low: 'low', medium: 'medium', high: 'high' })
    expect(catalog[1].config).toEqual({ provider: 'phalanx-61626364313233343536373839303132', model: 'flash' })
  })
})
