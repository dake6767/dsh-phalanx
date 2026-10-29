import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { PostgresPluginGrants } from '../src/adapters/postgres-plugin-grants.js'
import { PostgresCommunityAccountStore } from '../src/adapters/postgres-community-accounts.js'
import { openTestDatabase } from './support/community-application.js'
import { seedPluginParents } from './support/plugin-facts.js'
it('persists grants and retains only the requested live group references', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-grants-'))
  const database = await openTestDatabase(root)
  try {
    const accounts = new PostgresCommunityAccountStore(database)
    const retained = (await accounts.createGroup('Retained')).id
    const removed = (await accounts.createGroup('Removed')).id
    await seedPluginParents(database, ['one', 'two', 'controlled', 'native', 'another'])
    const grants = new PostgresPluginGrants(database)
    await grants.set(retained, ['one', 'two'])
    await grants.set(removed, ['one'])
    const recovered = new PostgresPluginGrants(database)
    await recovered.retainGroups([retained])
    expect(await recovered.get(removed)).toEqual([])
    expect(await new PostgresPluginGrants(database).get(retained)).toEqual(['one', 'two'])
    await recovered.remove(retained)
    expect(await new PostgresPluginGrants(database).get(retained)).toEqual([])
  } finally {
    try {
      await database.close()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})

it('saves both plugin lists atomically and permits moving a package in one configuration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-grants-'))
  const database = await openTestDatabase(root)
  try {
    const accounts = new PostgresCommunityAccountStore(database)
    const group = (await accounts.createGroup('Group')).id
    await seedPluginParents(database, ['one', 'two', 'controlled', 'native', 'another'])
    const store = new PostgresPluginGrants(database)
    await store.configure(group, ['controlled'], ['native'])
    const reopened = new PostgresPluginGrants(database)
    expect(await reopened.get(group)).toEqual(['controlled'])
    expect(await reopened.preinstalls(group)).toEqual(['native'])
    await reopened.configure(group, ['native'], ['controlled'])
    const moved = new PostgresPluginGrants(database)
    expect(await moved.get(group)).toEqual(['native'])
    expect(await moved.preinstalls(group)).toEqual(['controlled'])
    await expect(moved.configure(group, ['native'], ['native'])).rejects.toThrow()
    expect(await new PostgresPluginGrants(database).preinstalls(group)).toEqual(['controlled'])
  } finally {
    try {
      await database.close()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})

it('keeps preinstalls and contribution receipts during controlled edits, rejects implicit moves and cleans both lists on group removal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-grants-'))
  const database = await openTestDatabase(root)
  try {
    const accounts = new PostgresCommunityAccountStore(database)
    const retained = (await accounts.createGroup('Retained')).id
    const removed = (await accounts.createGroup('Removed')).id
    await seedPluginParents(database, ['one', 'two', 'controlled', 'native', 'another'])
    const store = new PostgresPluginGrants(database),
      receipt = { id: 'contribution', revision: 'approved' }
    await store.configure(retained, [], ['native'])
    await store.configure(removed, [], ['native'])
    await store.grantContribution(retained, 'controlled', receipt)
    await store.set(retained, ['controlled', 'another'])
    const reopened = new PostgresPluginGrants(database)
    expect(await reopened.preinstalls(retained)).toEqual(['native'])
    expect(await reopened.contributionReceipt(retained, 'controlled')).toEqual(receipt)
    await expect(reopened.set(retained, ['native'])).rejects.toThrow()
    await expect(reopened.grantContribution(retained, 'native', receipt)).rejects.toThrow()
    await reopened.retainGroups([retained])
    expect(await new PostgresPluginGrants(database).preinstalls(removed)).toEqual([])
    await reopened.remove(retained)
    const afterRemoval = new PostgresPluginGrants(database)
    expect(await afterRemoval.preinstalls(retained)).toEqual([])
    expect(await afterRemoval.contributionReceipt(retained, 'controlled')).toBeUndefined()
  } finally {
    try {
      await database.close()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})
