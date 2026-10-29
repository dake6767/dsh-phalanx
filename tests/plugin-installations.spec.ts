import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { PostgresPluginInstallations } from '../src/adapters/postgres-plugin-installations.js'
import { PostgresCommunityAccountStore } from '../src/adapters/postgres-community-accounts.js'
import { openTestDatabase } from './support/community-application.js'

it('persists successful deliveries by immutable member space and keeps independent package histories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-installations-'))
  const database = await openTestDatabase(root)
  try {
    const accounts = new PostgresCommunityAccountStore(database)
    const spaceA = (await accounts.create({ username: 'a', email: '', password: 'password' })).spaceId
    const spaceB = (await accounts.create({ username: 'b', email: '', password: 'password' })).spaceId
    const records = new PostgresPluginInstallations(database)
    await records.save(spaceA, { packageName: 'plugin', source: 'preinstall', version: '1.0.0' })
    await records.save(spaceA, { packageName: 'other', source: 'selected', version: '2.0.0' })
    await records.save(spaceB, { packageName: 'plugin', source: 'selected', version: '3.0.0' })
    const reopened = new PostgresPluginInstallations(database)
    expect(await reopened.get(spaceA)).toEqual([
      { packageName: 'other', source: 'selected', version: '2.0.0' },
      { packageName: 'plugin', source: 'preinstall', version: '1.0.0' },
    ])
    expect(await reopened.get(spaceB)).toEqual([{ packageName: 'plugin', source: 'selected', version: '3.0.0' }])
    expect(await reopened.get('new-space')).toEqual([])
    await reopened.save(spaceA, { packageName: 'plugin', source: 'selected', version: '1.2.0' })
    expect(await new PostgresPluginInstallations(database).get(spaceA)).toContainEqual({ packageName: 'plugin', source: 'selected', version: '1.2.0' })
    await reopened.clearPreinstalls(spaceA)
    expect(await new PostgresPluginInstallations(database).get(spaceA)).toEqual([
      { packageName: 'other', source: 'selected', version: '2.0.0' },
      { packageName: 'plugin', source: 'selected', version: '1.2.0' },
    ])
    await reopened.save(spaceA, { packageName: 'preinstalled', source: 'preinstall', version: '1.0.0' })
    await reopened.clearPreinstalls(spaceA)
    expect((await new PostgresPluginInstallations(database).get(spaceA)).map(row => row.packageName)).toEqual(['other', 'plugin'])
    expect(await new PostgresPluginInstallations(database).get(spaceB)).toEqual([{ packageName: 'plugin', source: 'selected', version: '3.0.0' }])
  } finally {
    try {
      await database.close()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})

it('retains concurrent successful deliveries for different member spaces', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-installations-concurrent-'))
  const database = await openTestDatabase(root)
  try {
    const accounts = new PostgresCommunityAccountStore(database)
    const spaceA = (await accounts.create({ username: 'a', email: '', password: 'password' })).spaceId
    const spaceB = (await accounts.create({ username: 'b', email: '', password: 'password' })).spaceId
    const records = new PostgresPluginInstallations(database)
    await Promise.all([
      records.save(spaceA, { packageName: 'one', source: 'selected', version: '1.0.0' }),
      records.save(spaceB, { packageName: 'two', source: 'preinstall', version: '2.0.0' }),
    ])
    const reopened = new PostgresPluginInstallations(database)
    expect(await reopened.get(spaceA)).toEqual([{ packageName: 'one', source: 'selected', version: '1.0.0' }])
    expect(await reopened.get(spaceB)).toEqual([{ packageName: 'two', source: 'preinstall', version: '2.0.0' }])
  } finally {
    try {
      await database.close()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})
