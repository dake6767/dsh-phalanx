import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { PostgresContainerHostnames } from '../src/adapters/postgres-container-hostnames.js'
import { PostgresCommunityAccountStore } from '../src/adapters/postgres-community-accounts.js'
import { cleanupOwned } from './fixtures/owned-cleanup.js'
import { openTestDatabase } from './support/community-application.js'

it('keeps the first hostname across concurrent writers and reopen while isolating recreated spaces', async () => {
  const root = await mkdtemp(join(tmpdir(), 'container-hostnames-'))
  const database = await openTestDatabase(root)
  try {
    const accounts = new PostgresCommunityAccountStore(database)
    const account = await accounts.create({ username: 'alice', password: 'fixture-password', email: '' })
    const owner = { username: account.username, spaceId: account.spaceId }
    const first = new PostgresContainerHostnames(database),
      second = new PostgresContainerHostnames(database)
    const results = await Promise.all([first.get(owner), second.get(owner), second.remember(owner, 'observed-container')])
    expect(new Set(results).size).toBe(1)
    const saved = results[0]!
    expect(await new PostgresContainerHostnames(database).get(owner)).toBe(saved)
    expect(await first.remember(owner, 'later-observation')).toBe(saved)
    expect(await first.remember({ ...owner, username: 'bob' }, 'wrong-owner')).toBeUndefined()
    await accounts.delete('alice')
    const replacement = await accounts.create({ username: 'alice', password: 'replacement-password', email: '' })
    expect(replacement.spaceId).not.toBe(owner.spaceId)
    expect(await first.remember(owner, saved)).toBeUndefined()
    await expect(first.get(owner)).rejects.toThrow('space')
    const next = await first.get({ username: replacement.username, spaceId: replacement.spaceId })
    expect(next).not.toBe(saved)
    expect(await second.get({ username: replacement.username, spaceId: replacement.spaceId })).toBe(next)
  } finally {
    await cleanupOwned(
      () => database.close(),
      () => rm(root, { recursive: true, force: true }),
    )
  }
})
