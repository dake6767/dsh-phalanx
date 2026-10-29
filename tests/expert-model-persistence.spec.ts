import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { PlatformDatabase } from '../src/adapters/platform-database.js'
import { openTestDatabase } from './support/community-application.js'
import { cleanupOwned } from './fixtures/owned-cleanup.js'
import { PostgresCommunityAccountStore } from '../src/adapters/postgres-community-accounts.js'
import { PostgresSharedModelStore } from '../src/adapters/postgres-shared-model-store.js'
import { createExpertStorage } from '../src/composition/expert-storage.js'
import { SharedModelAdministration } from '../src/use-cases/shared-model-administration.js'
import { Experts } from '../src/use-cases/experts.js'
import { enabledSharedModels } from '../src/domain/shared-models.js'

for (const removal of ['provider', 'model'] as const)
  it(`retains an unavailable expert model after actual ${removal} removal and falls back until explicitly cleared`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'expert-model-persistence-'))
    let database: PlatformDatabase | undefined, storage: ReturnType<typeof createExpertStorage> | undefined, models: PostgresSharedModelStore | undefined
    try {
      database = await openTestDatabase(root)
      storage = createExpertStorage(database)
      models = new PostgresSharedModelStore(database, { prepare: () => ({ publish() {}, discard() {} }) })
      const accounts = new PostgresCommunityAccountStore(database)
      const admin = await accounts.createFirstAdmin({ username: 'admin', email: '', password: 'password' }),
        member = await accounts.create({ username: 'member', email: '', password: 'password' })
      await models.initialize()
      await storage.initialize()
      const management = new SharedModelAdministration(accounts, models)
      const provider = {
        name: 'Provider A',
        baseUrl: 'https://example.test',
        apiFormat: 'anthropic-messages' as const,
        apiKey: 'fictional-key',
        enabled: true,
        models: [
          { name: 'chosen', enabled: true },
          { name: 'retained', enabled: true },
        ],
      }
      const first = await management.execute(admin, { action: 'save-provider', revision: 0, provider })
      const second = await management.execute(admin, { action: 'save-provider', revision: first.revision, provider: { ...provider, name: 'Provider B' } })
      const originalProvider = second.providers.find(row => row.name === 'Provider A')!,
        fallback = second.providers.find(row => row.name === 'Provider B')!.models[0]!.id
      const expertStorage = storage,
        modelStore = models
      const experts = new Experts(
        accounts,
        storage,
        { list: async () => [] },
        { list: async () => [] },
        () => 'writer',
        undefined,
        undefined,
        {
          status: () => ({
            state: 'ready',
            instance: {
              userId: 'member',
              origin: '',
              launchUrl: '',
              processId: 1,
              expertSnapshot: expertStorage.view.read().experts.map(row => `${row.id}:${row.revision}`),
            },
          }),
        },
        undefined,
        undefined,
        () =>
          enabledSharedModels(modelStore.read()).map(({ provider, model }) => ({
            providerId: provider.id,
            name: model.name,
            id: model.id,
            label: provider.name + ' / ' + model.name,
          })),
      )
      const input = {
        name: 'Writer',
        description: 'Reports',
        icon: 'W',
        persona: 'Write.',
        skills: [],
        skillPacks: [],
        model: { providerId: originalProvider.id, name: 'chosen' },
      }
      await experts.save(admin, input, await experts.revision())
      await experts.grant(admin, member.groupId, ['writer'], await experts.revision())
      expect((await experts.start(member, 'writer')).modelId).toBe(originalProvider.models[0]!.id)
      if (removal === 'provider')
        await management.execute(admin, { action: 'delete-provider', revision: second.revision, providerId: originalProvider.id, defaultModelId: fallback })
      else
        await management.execute(admin, {
          action: 'save-provider',
          revision: second.revision,
          defaultModelId: fallback,
          provider: { ...provider, id: originalProvider.id, models: [{ name: 'retained', enabled: true }] },
        })
      expect((await experts.list(admin)).experts[0]).toMatchObject({ model: input.model, modelUnavailable: true })
      expect(await experts.start(member, 'writer')).toEqual({ expertId: 'writer', modelId: null })
      await experts.save(admin, { ...input, description: 'Edited report expert' }, await experts.revision(), 'writer')
      expect((await storage.read()).experts[0]!.model).toEqual(input.model)
      await expect(
        experts.save(admin, { ...input, model: { providerId: 'absent', name: 'absent' } }, await experts.revision(), 'writer'),
      ).rejects.toMatchObject({ code: 'expert-invalid' })
      await experts.save(admin, { ...input, model: null }, await experts.revision(), 'writer')
      expect((await storage.read()).experts[0]!.model).toBeNull()
    } finally {
      await cleanupOwned(
        async () => storage?.close(),
        async () => models?.close(),
        async () => database?.close(),
        () => rm(root, { recursive: true, force: true }),
      )
    }
  })
