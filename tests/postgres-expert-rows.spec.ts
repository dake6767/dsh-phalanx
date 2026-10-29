import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { PlatformDatabase } from '../src/adapters/platform-database.js'
import type { Expert } from '../src/domain/expert.js'
import { PostgresExpertRows } from '../src/adapters/postgres-expert-rows.js'
import { openTestDatabase } from './support/community-application.js'
import { cleanupOwned } from './fixtures/owned-cleanup.js'
import { PostgresSkillLibraryStore } from '../src/adapters/postgres-skill-library.js'
import { PostgresSkillPackStore } from '../src/adapters/postgres-skill-packs.js'
import { PostgresPluginLibraryStore } from '../src/adapters/postgres-plugin-library.js'
import { PostgresMcpStore } from '../src/adapters/postgres-mcp-store.js'
import { mcpSecretContext } from '../src/domain/mcp-protected-values.js'

const expert: Expert = {
  id: 'writer',
  revision: 1,
  published: false,
  name: 'Writer',
  description: 'Draft reports',
  icon: 'W',
  persona: 'Write clearly.',
  examples: ['Draft a report', 'Review a report'],
  skills: [],
  skillPacks: [],
  plugins: [],
  mcp: [],
  model: null,
}

it('reopens expert definitions from ordinary database rows without a JSON backend and refuses a stale editor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'expert-rows-'))
  let database: PlatformDatabase | undefined
  try {
    database = await openTestDatabase(root)
    let rows = new PostgresExpertRows(database)
    await rows.save(expert, 'none')
    await rows.save({ ...expert, id: 'other', name: 'Other writer' }, 'none')
    const original = (await rows.get('writer'))!
    await rows.save({ ...original, name: 'Edited writer', revision: 2 }, original.rowRevision!)
    await expect(rows.save({ ...original, name: 'Stale writer' }, original.rowRevision!)).rejects.toMatchObject({ code: 'expert-stale' })
    await database.close()
    database = await openTestDatabase(root)
    rows = new PostgresExpertRows(database)
    expect(await rows.list()).toMatchObject([
      { id: 'other', name: 'Other writer' },
      { id: 'writer', name: 'Edited writer', revision: 2 },
    ])
    await expect(stat(join(root, 'experts', 'library.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await cleanupOwned(
      async () => database?.close(),
      () => rm(root, { recursive: true, force: true }),
    )
  }
})

it('keeps ordered expert references and an unavailable saved model while changing only the selected expert', async () => {
  const root = await mkdtemp(join(tmpdir(), 'expert-references-'))
  let database: PlatformDatabase | undefined
  try {
    database = await openTestDatabase(root)
    const skills = new PostgresSkillLibraryStore(database)
    for (const name of ['first', 'second']) await skills.save({ name, description: name, hash: 'a'.repeat(64), importedAt: 0, published: false })
    await new PostgresSkillPackStore(database).save({ name: 'reports', description: 'Reports', instructions: '', skills: ['first'], published: false })
    await new PostgresPluginLibraryStore(database).save({
      packageName: '@fixture/client',
      version: '1.0.0',
      stage: 'resolving',
      published: false,
      current: null,
    })
    const service = { name: 'p-reports', description: 'Reports', generation: 1, url: 'https://example.test' }
    await new PostgresMcpStore(database).save(service, mcpSecretContext([service]), 'none')
    const rows = new PostgresExpertRows(database)
    const selected = {
      ...expert,
      skills: ['second', 'first'],
      skillPacks: ['reports'],
      plugins: ['@fixture/client'],
      mcp: ['p-reports'],
      model: { providerId: 'removed-provider', name: 'saved-model' },
    }
    await rows.save(selected, 'none')
    const saved = (await rows.get(expert.id))!
    expect(saved).toMatchObject(selected)
    await rows.save({ ...saved, revision: 2, skills: ['first'], mcp: [] }, saved.rowRevision!)
    expect(await rows.get(expert.id)).toMatchObject({ ...selected, revision: 2, skills: ['first'], mcp: [] })
    await database.close()
    database = await openTestDatabase(root)
    expect(await new PostgresExpertRows(database).get(expert.id)).toMatchObject({ ...selected, revision: 2, skills: ['first'], mcp: [] })
  } finally {
    await cleanupOwned(
      async () => database?.close(),
      () => rm(root, { recursive: true, force: true }),
    )
  }
})
