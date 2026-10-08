import { expect, it } from 'vitest'
import { SharedModelAdministration } from '../src/use-cases/shared-model-administration.js'
import type { SharedModelState } from '../src/domain/shared-models.js'

it('protects default supply, prevents stale writes and rechecks administrator authority', () => {
  let state: SharedModelState = { revision: 0, providers: [], defaultModelId: null }
  let id = 0; let admin = true
  const actor = { username: 'admin', spaceId: 'admin-space', sessionEpoch: 0 }
  const service = new SharedModelAdministration({ get: () => ({ ...actor, admin, email: '', disabled: false, createdAt: 0, updatedAt: 0 }) }, {
    read: () => state, save: next => { state = next }, newId: () => `id-${++id}`,
  })
  const provider = { name: 'Custom', baseUrl: 'https://messages.example.test/path', apiFormat: 'anthropic-messages' as const,
    apiKey: 'fixture-key', enabled: true, models: [{ name: 'same-name', enabled: true }, { name: 'second', enabled: true }] }
  const first = service.execute(actor, { revision: 0, action: 'save-provider', provider })
  expect(first.defaultModelId).toBe(first.providers[0]!.models[0]!.id)
  expect(JSON.stringify(first)).not.toContain('fixture-key')
  expect(() => service.execute(actor, { revision: 0, action: 'save-provider', provider })).toThrow(expect.objectContaining({ code: 'model-revision-conflict', params: { expectedRevision: 1, receivedRevision: 0 } }))
  const saved = first.providers[0]!
  expect(() => service.execute(actor, { revision: 1, action: 'save-provider', provider: { ...saved, enabled: false } })).toThrow('replacement default')
  const second = service.execute(actor, { revision: 1, action: 'save-provider', provider: { ...provider, name: 'Other' } })
  expect(second.providers[1]!.models[0]!.id).not.toBe(saved.models[0]!.id)
  const next = service.execute(actor, { revision: 2, action: 'delete-provider', providerId: saved.id,
    defaultModelId: second.providers[1]!.models[0]!.id })
  expect(next.providers).toHaveLength(1)
  admin = false
  expect(() => service.list(actor)).toThrow('Administrator')
  expect(() => service.execute(actor, { revision: 3, action: 'set-default', defaultModelId: next.defaultModelId })).toThrow('Administrator')
})
