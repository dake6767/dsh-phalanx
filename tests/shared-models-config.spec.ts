import { describe, expect, it } from 'vitest'
import { publicSharedModels, managedModelCatalog } from '../src/dsh/shared-models.js'
import { knownModelInput, normalizeSharedModelState, type SharedModelState } from '../src/domain/shared-models.js'

const state = (): SharedModelState => ({
  revision: 2,
  defaultModelId: 'flash',
  providers: [
    {
      id: 'provider',
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
      id: 'disabled-provider',
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
  it('declares image input only on models the administrator marked as supporting images', () => {
    expect(publicSharedModels(state())).toEqual([
      { id: 'flash', name: 'Shared / deepseek-flash', input: ['text', 'image'] },
      { id: 'text', name: 'Shared / custom-chat', input: ['text'] },
    ])
  })

  it('keeps the explanation route selectable without declaring image input', () => {
    expect(publicSharedModels({ revision: 0, providers: [], defaultModelId: null })).toEqual([
      { id: 'unconfigured', name: 'Shared models not configured', input: ['text'] },
    ])
  })

  it('writes the same declarations into the generated managed model catalog', () => {
    const rows = JSON.parse(managedModelCatalog(state())) as Array<{ id: string; config: { providers: Record<string, { models: unknown[] }> } }>
    expect(rows.find(row => row.id === 'phalanx-shared-models')!.config.providers['deepseek-official']!.models).toEqual(publicSharedModels(state()))
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
      { id: 'flash', name: 'deepseek-flash', enabled: true, input: 'text+image' },
      { id: 'custom', name: 'custom-chat', enabled: true, input: 'text' },
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
