import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { PostgresCommunityAccountStore } from '../src/adapters/postgres-community-accounts.js'
import { PostgresNativePluginHistory } from '../src/adapters/postgres-native-plugin-history.js'
import { PostgresSpaceActors } from '../src/adapters/postgres-space-actors.js'
import { PostgresUnitOfWork } from '../src/adapters/postgres-unit-of-work.js'
import { openTestDatabase } from './support/community-application.js'
import { cleanupOwned } from './fixtures/owned-cleanup.js'

it('persists monotonic space eligibility across concurrent writes and removes it with the retired account', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-plugin-history-'))
  const database = await openTestDatabase(root)
  try {
    const accounts = new PostgresCommunityAccountStore(database)
    const member = await accounts.createFirstAdmin({ username: 'member', password: 'fixture-password', email: '' })
    const rows = new PostgresNativePluginHistory(database)
    expect(await rows.read(member.spaceId)).toBeUndefined()
    await Promise.all([rows.remember(member.spaceId, ['first']), rows.remember(member.spaceId, ['second'])])
    expect(await new PostgresNativePluginHistory(database).read(member.spaceId)).toEqual(['first', 'second'])
    expect(await rows.remember(member.spaceId, [])).toEqual(['first', 'second'])
    const work = new PostgresUnitOfWork(database, { actors: transaction => new PostgresSpaceActors(transaction) })
    await work.run(repositories => repositories.actors.lockMember(member))
    await expect(work.run(repositories => repositories.actors.lockMember({ ...member, spaceId: 'retired-space' }))).rejects.toMatchObject({
      code: 'sign-in-required',
    })
    await database.query('DELETE FROM dsh_phalanx.accounts WHERE username=$1', ['member'])
    expect(await rows.read(member.spaceId)).toBeUndefined()
  } finally {
    await cleanupOwned(
      () => database.close(),
      () => rm(root, { recursive: true, force: true }),
    )
  }
})
