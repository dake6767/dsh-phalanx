import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { PostgresUserStorageFacts } from '../src/adapters/postgres-user-storage-facts.js'
import { PostgresCommunityAccountStore } from '../src/adapters/postgres-community-accounts.js'
import { cleanupOwned } from './fixtures/owned-cleanup.js'
import { openTestDatabase } from './support/community-application.js'

it('keeps one platform storage owner and rejects stale binding publications independently of account deletion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'storage-facts-'))
  const database = await openTestDatabase(root)
  const first = new PostgresUserStorageFacts(database),
    second = new PostgresUserStorageFacts(database)
  try {
    expect(await first.read()).toBeUndefined()
    const owners = await Promise.all([first.createOwner('a'.repeat(32)), second.createOwner('b'.repeat(32))])
    expect(owners[0]).toEqual(owners[1])
    const binding = { path: '/fixture/user-volume', id: 'c'.repeat(32), mount: 'fixture-mount' }
    expect(await first.saveBinding(0, binding)).toEqual({ owner: owners[0]!.owner, revision: 1, binding })
    await expect(second.saveBinding(0, null)).rejects.toMatchObject({ code: 'storage-binding-changed' })
    const accounts = new PostgresCommunityAccountStore(database)
    await accounts.create({ username: 'member', password: 'fixture-password', email: '' })
    await accounts.delete('member')
    expect(await new PostgresUserStorageFacts(database).read()).toEqual({ owner: owners[0]!.owner, revision: 1, binding })
    expect(await second.saveBinding(1, null)).toEqual({ owner: owners[0]!.owner, revision: 2, binding: null })
  } finally {
    await cleanupOwned(
      () => database.close(),
      () => rm(root, { recursive: true, force: true }),
    )
  }
})
