import { expect, it } from 'vitest'
import { BusinessRuleError } from '../src/domain/business-error.js'
import { InitialModelSetup } from '../src/use-cases/initial-model-setup.js'
import { SharedModelAdministration } from '../src/use-cases/shared-model-administration.js'
import type { SharedModelState } from '../src/domain/shared-models.js'
import type { CommunityAccountActor } from '../src/domain/community-account.js'

const actor: CommunityAccountActor = { username: 'admin', spaceId: 'admin-space', sessionEpoch: 0 }
function bench(failPublication = false) {
  let state: SharedModelState = { revision: 0, providers: [], defaultModelId: null }
  let serial = 0
  let admin = true
  let publishedRevision = 0
  const accounts = { get: async () => ({ ...actor, admin, groupId: 'admin', email: '', disabled: false, createdAt: 0, updatedAt: 0 }) }
  const models = new SharedModelAdministration(accounts, {
    read: () => state,
    save: async next => {
      state = next
      if (failPublication) throw new BusinessRuleError('conflict', 'Publication pending', 'model-projection-pending')
      publishedRevision = next.revision
    },
    newId: () => `model-id-${++serial}`,
  })
  const setup = new InitialModelSetup(
    models,
    { read: () => ({ status: 'ready', values: { name: 'Preset provider', apiKey: 'fictional-preset-key' } }) },
    {
      retry: async revision => {
        publishedRevision = revision
      },
    },
  )
  return {
    setup,
    models,
    persisted: () => state,
    published: () => publishedRevision,
    setAdmin: (value: boolean) => {
      admin = value
    },
  }
}
it('keeps the preset key on the server and saves one enabled default model with an administrator session', async () => {
  const { setup, models } = bench()
  const view = await setup.view(actor)
  expect(view.defaults.name).toBe('Preset provider')
  expect(view.defaults.apiKey).toEqual({ configured: true })
  expect(JSON.stringify(view)).not.toContain('fictional-preset-key')
  const input = {
    revision: 0,
    name: 'Chosen provider',
    baseUrl: 'https://models.example.test',
    apiFormat: 'openai-responses' as const,
    model: 'chosen-model',
    apiKey: '',
  }
  const saved = await setup.save(actor, input)
  expect(saved.providers).toHaveLength(1)
  expect(saved.providers[0]!.models).toHaveLength(1)
  expect(saved.defaultModelId).toBe(saved.providers[0]!.models[0]!.id)
  expect(saved.providers[0]!.enabled).toBe(true)
  expect(saved.providers[0]!.models[0]!.enabled).toBe(true)
  expect(saved.providers[0]!.apiKey.configured).toBe(true)
  const repeated = await setup.save(actor, input)
  expect(repeated).toEqual(saved)
  expect((await models.list(actor)).providers).toHaveLength(1)
  await expect(setup.view({ ...actor, sessionEpoch: 1 })).rejects.toThrow('Sign in')
})

it('recovers a committed publication failure using the same provider ID and revision, and ignores later defaults', async () => {
  const { setup, persisted, published } = bench(true)
  const input = {
    revision: 0,
    name: 'Chosen provider',
    baseUrl: 'https://models.example.test',
    apiFormat: 'anthropic-messages' as const,
    model: 'chosen-model',
    apiKey: 'fictional-replacement-value',
  }
  await expect(setup.save(actor, input)).rejects.toMatchObject({ code: 'model-projection-pending' })
  const committed = structuredClone(persisted())
  expect(committed.providers[0]!.apiKey).toBe('fictional-replacement-value')
  expect(published()).toBe(0)
  const refreshed = await setup.view(actor)
  expect(refreshed.defaults).toEqual({ apiKey: { configured: false } })
  const recovered = await setup.save(actor, { ...input, revision: refreshed.settings.revision })
  expect(recovered).toEqual(refreshed.settings)
  expect(persisted()).toEqual(committed)
  expect(published()).toBe(1)
})

it('requires a current administrator before reading defaults or accepting a first model', async () => {
  const { setup, setAdmin } = bench()
  setAdmin(false)
  await expect(setup.view(actor)).rejects.toMatchObject({ code: 'admin-required' })
  await expect(
    setup.save(actor, {
      revision: 0,
      name: 'Provider',
      baseUrl: 'https://models.example.test',
      apiFormat: 'openai-completions',
      model: 'chat',
      apiKey: 'fictional-key',
    }),
  ).rejects.toMatchObject({ code: 'admin-required' })
})
