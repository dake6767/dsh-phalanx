import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { PostgresPlatformSearchSettings } from '../src/adapters/postgres-platform-search-settings.js'
import type { CommunityAccountRecord } from '../src/domain/community-account.js'
import { PlatformSearchSettings } from '../src/use-cases/platform-search-settings.js'
import { openTestDatabase } from './support/community-application.js'
import { removeCommunityFixture } from './fixtures/owned-cleanup.js'

it('checks current administrator access and validates changes before calling the store', async () => {
  const actor = { username: 'admin', spaceId: 'space', sessionEpoch: 3 }
  let account: CommunityAccountRecord = { ...actor, admin: false, disabled: false, email: '', groupId: 'members', createdAt: 0, updatedAt: 0 }
  const view = vi.fn(async () => ({ revision: 1, enabled: false, hasKey: false }))
  const save = vi.fn(view)
  const settings = new PlatformSearchSettings({ get: async () => account }, { view, save, credential: vi.fn() })
  const valid = { action: 'save', revision: 1, enabled: false }
  await expect(settings.view(actor)).rejects.toMatchObject({ code: 'admin-required' })
  await expect(settings.save(actor, valid)).rejects.toMatchObject({ code: 'admin-required' })
  account = { ...account, admin: true, sessionEpoch: 4 }
  await expect(settings.save(actor, valid)).rejects.toMatchObject({ code: 'sign-in-required' })
  expect(view).not.toHaveBeenCalled()
  const current = { ...actor, sessionEpoch: 4 }
  for (const input of [
    { ...valid, revision: -1 },
    { ...valid, apiKey: 'bad\nkey' },
    { action: 'clear', revision: 1, enabled: true },
  ]) {
    await expect(settings.save(current, input)).rejects.toMatchObject({ code: 'platform-search-settings-invalid' })
  }
  expect(save).not.toHaveBeenCalled()
  await expect(settings.view(current)).resolves.toEqual({ revision: 1, enabled: false, hasKey: false })
  await settings.save(current, valid)
  expect(save).toHaveBeenCalledWith(valid)
})

it('keeps the search key encrypted and applies rotation, disabling and clearing atomically', async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-search-test-'))
  const database = await openTestDatabase(root)
  try {
    const store = new PostgresPlatformSearchSettings(database)
    expect(await store.view()).toEqual({ revision: 0, enabled: false, hasKey: false })
    await expect(store.save({ action: 'save', revision: 0, enabled: true })).rejects.toMatchObject({ code: 'platform-search-key-required' })
    const first = 'search-fixture-secret'
    expect(await store.save({ action: 'save', revision: 0, enabled: true, apiKey: first })).toEqual({ revision: 1, enabled: true, hasKey: true })
    const stored = await database.query('SELECT api_key FROM dsh_phalanx.platform_search_settings')
    expect(stored[0]?.api_key).toMatchObject({ ciphertext: expect.any(String) })
    expect(JSON.stringify(stored)).not.toContain(first)
    const reader = new PostgresPlatformSearchSettings(database)
    expect(await reader.credential()).toBe(first)
    const concurrent = await Promise.allSettled([
      store.save({ action: 'save', revision: 1, enabled: true, apiKey: 'rotated-search-key' }),
      store.save({ action: 'save', revision: 1, enabled: true, apiKey: 'other-search-key' }),
    ])
    expect(concurrent.map(item => item.status).sort()).toEqual(['fulfilled', 'rejected'])
    const fresh = await reader.credential()
    expect(['rotated-search-key', 'other-search-key']).toContain(fresh)
    expect(await store.save({ action: 'save', revision: 2, enabled: false })).toMatchObject({ enabled: false, hasKey: true })
    expect(await reader.credential()).toBeUndefined()
    await store.save({ action: 'save', revision: 3, enabled: true })
    expect(await reader.credential()).toBe(fresh)
    expect(await store.save({ action: 'clear', revision: 4 })).toMatchObject({ enabled: false, hasKey: false })
    expect(await reader.credential()).toBeUndefined()
  } finally {
    await database.close()
    await removeCommunityFixture(root)
  }
})
