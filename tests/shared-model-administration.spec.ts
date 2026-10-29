import { expect, it } from 'vitest'
import { SharedModelAdministration } from '../src/use-cases/shared-model-administration.js'
import type { SharedModelState } from '../src/domain/shared-models.js'
import type { CommunityAccountActor } from '../src/domain/community-account.js'

const actor: CommunityAccountActor = { username: 'admin', spaceId: 'admin-space', sessionEpoch: 0 }
function bench() {
  let state: SharedModelState = { revision: 0, providers: [], defaultModelId: null }
  let id = 0
  let admin = true
  const service = new SharedModelAdministration(
    { get: async () => ({ ...actor, admin, groupId: admin ? 'admin' : 'default', email: '', disabled: false, createdAt: 0, updatedAt: 0 }) },
    {
      read: () => state,
      save: async next => {
        state = next
      },
      newId: () => `id-${++id}`,
    },
  )
  const provider = {
    name: 'Custom',
    baseUrl: 'https://messages.example.test/path',
    apiFormat: 'anthropic-messages' as const,
    apiKey: 'fixture-key',
    enabled: true,
    models: [
      { name: 'same-name', enabled: true },
      { name: 'second', enabled: true },
    ],
  }
  return {
    service,
    provider,
    setAdmin: (value: boolean) => {
      admin = value
    },
    state: () => state,
  }
}

it('protects default supply, prevents stale writes and rechecks administrator authority', async () => {
  const { service, provider, setAdmin } = bench()
  const first = await service.execute(actor, { revision: 0, action: 'save-provider', provider })
  expect(first.defaultModelId).toBe(first.providers[0]!.models[0]!.id)
  expect(JSON.stringify(first)).not.toContain('fixture-key')
  expect(first.providers[0]!.apiKey).toEqual({ configured: true, last4: '-key' })
  await expect(service.execute(actor, { revision: 0, action: 'save-provider', provider })).rejects.toThrow(
    expect.objectContaining({ code: 'model-revision-conflict', params: { expectedRevision: 1, receivedRevision: 0 } }),
  )
  const saved = first.providers[0]!
  await expect(service.execute(actor, { revision: 1, action: 'save-provider', provider: { ...saved, apiKey: '', enabled: false } })).rejects.toThrow(
    'replacement default',
  )
  const second = await service.execute(actor, { revision: 1, action: 'save-provider', provider: { ...provider, name: 'Other' } })
  expect(second.providers[1]!.models[0]!.id).not.toBe(saved.models[0]!.id)
  const next = await service.execute(actor, {
    revision: 2,
    action: 'delete-provider',
    providerId: saved.id,
    defaultModelId: second.providers[1]!.models[0]!.id,
  })
  expect(next.providers).toHaveLength(1)
  setAdmin(false)
  await expect(service.list(actor)).rejects.toThrow('Administrator')
  await expect(service.execute(actor, { revision: 3, action: 'set-default', defaultModelId: next.defaultModelId })).rejects.toThrow('Administrator')
})

it('defaults only a new model from the known model table and preserves a stored declaration', async () => {
  const { service, provider } = bench()
  const saved = await service.execute(actor, {
    revision: 0,
    action: 'save-provider',
    provider: {
      ...provider,
      models: [
        { name: 'deepseek-flash', enabled: true },
        { name: 'custom-chat', enabled: true },
        { name: 'custom-image', enabled: true, input: 'text+image' },
        { name: 'custom-text', enabled: true, input: 'text' },
      ],
    },
  })
  const stored = saved.providers[0]!
  expect(stored.models.map(model => [model.name, model.input])).toEqual([
    ['deepseek-flash', 'text+image'],
    ['custom-chat', 'text'],
    ['custom-image', 'text+image'],
    ['custom-text', 'text'],
  ])
  // An older client omitted input; a stored row keeps the administrator's explicit declaration.
  const explicit = await service.execute(actor, {
    revision: 1,
    action: 'save-provider',
    provider: {
      ...provider,
      id: stored.id,
      models: stored.models.map(model => ({
        id: model.id,
        name: model.name,
        enabled: model.enabled,
        ...(model.name === 'deepseek-flash' ? { input: 'text' as const } : {}),
      })),
    },
  })
  expect(explicit.providers[0]!.models.find(model => model.name === 'deepseek-flash')!.input).toBe('text')
  const omitted = await service.execute(actor, {
    revision: 2,
    action: 'save-provider',
    provider: { ...provider, id: stored.id, models: explicit.providers[0]!.models.map(({ id, name, enabled }) => ({ id, name, enabled })) },
  })
  expect(omitted.providers[0]!.models.map(model => [model.name, model.input])).toEqual([
    ['deepseek-flash', 'text'],
    ['custom-chat', 'text'],
    ['custom-image', 'text+image'],
    ['custom-text', 'text'],
  ])
  await expect(
    service.execute(actor, {
      revision: 3,
      action: 'save-provider',
      provider: { ...provider, id: stored.id, models: [{ name: 'invalid-input', enabled: true, input: 'audio' as never }] },
    }),
  ).rejects.toThrow(expect.objectContaining({ code: 'model-input-invalid', params: undefined }))
})
