import { FilePlatformDatabaseConfig } from '../src/adapters/platform-database-config.js'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { nativeFeaturePredecessor } from './fixtures/native-feature-predecessor.js'
import { cleanupOwned, removeCommunityFixture } from './fixtures/owned-cleanup.js'
import { seedTestSecrets, testDatabaseConfigFile } from './support/community-application.js'

it('leaves a predecessor database untouched when an acceptance fixture has no secrets to seed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-feature-seed-'))
  const previous = await nativeFeaturePredecessor(root)
  try {
    await previous.accounts.createFirstAdmin({ username: 'admin', password: 'fixture-password', email: '' })
    await seedTestSecrets({
      listen: { host: '127.0.0.1', port: 0 },
      runtime: {
        dataRoot: root,
        command: '/unavailable-dsh',
        args: [],
        defaultModel: { provider: 'deepseek-official', model: 'deepseek-chat', upstream: { baseUrl: 'https://api.example.test' } },
      },
    })
    expect(await previous.database.health()).toMatchObject({ schemaVersion: 15 })
  } finally {
    await cleanupOwned(
      () => previous.database.close(),
      () => removeCommunityFixture(root),
    )
  }
})

it('preserves builtin selection for an installed fixture with no secrets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-feature-selection-'))
  try {
    const path = testDatabaseConfigFile(root)
    expect(FilePlatformDatabaseConfig.open(path, root).selection).toBeUndefined()
    await seedTestSecrets({
      listen: { host: '127.0.0.1', port: 0 },
      runtime: {
        dataRoot: root,
        command: '/unavailable-dsh',
        args: [],
        defaultModel: { provider: 'deepseek-official', model: 'deepseek-chat', upstream: { baseUrl: 'https://api.example.test' } },
      },
    })
    expect(FilePlatformDatabaseConfig.open(path, root).selection).toBe('builtin')
  } finally {
    await removeCommunityFixture(root)
  }
})
