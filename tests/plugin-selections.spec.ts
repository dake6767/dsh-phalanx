import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { PostgresPluginSelections } from '../src/adapters/postgres-plugin-selections.js'
import { PostgresCommunityAccountStore } from '../src/adapters/postgres-community-accounts.js'
import { openTestDatabase } from './support/community-application.js'
import { seedPluginParents } from './support/plugin-facts.js'
it('persists independent space choices and removes retired packages without changing other selections', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-selections-'))
  const database = await openTestDatabase(root)
  try {
    const accounts = new PostgresCommunityAccountStore(database)
    const spaceA = (await accounts.create({ username: 'a', email: '', password: 'password' })).spaceId
    const spaceB = (await accounts.create({ username: 'b', email: '', password: 'password' })).spaceId
    await seedPluginParents(database, ['one', 'two'])
    const store = new PostgresPluginSelections(database)
    await store.set(spaceA, ['one', 'two', 'one'])
    await store.set(spaceB, ['two'])
    expect(await store.get(spaceA)).toEqual(['one', 'two'])
    expect(await store.members('two')).toEqual([spaceA, spaceB].sort())
    const reopened = new PostgresPluginSelections(database)
    expect(await reopened.get(spaceA)).toEqual(['one', 'two'])
    expect(await reopened.get('new-space-a')).toEqual([])
    await reopened.removePackage('one')
    expect(await reopened.get(spaceA)).toEqual(['two'])
    await reopened.retainPackages([])
    expect(await new PostgresPluginSelections(database).members('two')).toEqual([])
  } finally {
    try {
      await database.close()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})
