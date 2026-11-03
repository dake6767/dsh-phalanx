import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { PlatformDatabase } from '../src/adapters/platform-database.js'
import { PostgresCommunityAccountStore } from '../src/adapters/postgres-community-accounts.js'
import { createNativeFeatureStorage } from '../src/composition/native-feature-storage.js'
import { NativeFeatures } from '../src/use-cases/native-features.js'
import { nativeFeatureCatalog } from '../src/domain/native-features.js'
import { PostgresNativeFeatures } from '../src/adapters/postgres-native-features.js'
import { PLATFORM_MIGRATIONS, PLATFORM_SCHEMA_VERSION } from '../src/adapters/platform-schema.js'
import { FilePlatformSecrets } from '../src/adapters/platform-secrets.js'
import { postgresConnection } from './support/postgres.js'
import { cleanupOwned } from './fixtures/owned-cleanup.js'
import { openTestDatabase } from './support/community-application.js'

it('upgrades schema 15 with existing groups and members defaulting to all features, then persists only explicit deviations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-feature-upgrade-'))
  const masterKeyPath = join(root, 'master.key'),
    key = FilePlatformSecrets.create(masterKeyPath)
  const security = { masterKeyPath, registry: key.registry() },
    connection = postgresConnection()
  key.close()
  const previous = new PlatformDatabase(connection, security, [
    { name: 'dsh_phalanx', migrations: PLATFORM_MIGRATIONS.filter(migration => migration.version <= 15) },
  ])
  const current = new PlatformDatabase(connection, security)
  try {
    await previous.initialize()
    await previous.query("INSERT INTO dsh_phalanx.groups(id,name,kind) VALUES('team','Fixture team','ordinary')")
    const accounts = new PostgresCommunityAccountStore(previous)
    const admin = await accounts.createFirstAdmin({ username: 'admin', password: 'fixture-password', email: '' })
    const member = await accounts.create({ username: 'member', password: 'fixture-password', email: '', groupId: 'team' })
    expect(await previous.health()).toMatchObject({ schemaVersion: 15 })
    await previous.close()
    await current.initialize()
    expect(await current.health()).toMatchObject({ schemaVersion: PLATFORM_SCHEMA_VERSION })
    const rows = new PostgresNativeFeatures(current)
    for (const groupId of ['admin', 'default', 'team']) expect(await rows.readGroup(groupId)).toEqual({ groupId, revision: 'none', disabledIds: [] })
    for (const account of [admin, member]) expect(await rows.forMember(account)).toMatchObject({ disabledIds: [] })
    const saved = await rows.save('team', ['future-feature', 'terminal'], 'none')
    expect(saved.revision).not.toBe('none')
    expect(await new PostgresNativeFeatures(current).readGroup('team')).toEqual(saved)
    expect(await rows.forMember(member)).toEqual(saved)
    expect(await rows.readGroup('admin')).toMatchObject({ disabledIds: [] })
  } finally {
    await cleanupOwned(
      () => previous.close(),
      () => current.close(),
      () => rm(root, { recursive: true, force: true }),
    )
  }
})

it('uses independent row revisions, refuses stale writers and cascades only the deleted group', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-feature-rows-'))
  const database = await openTestDatabase(root)
  try {
    await database.query("INSERT INTO dsh_phalanx.groups(id,name,kind) VALUES('team','Fixture team','ordinary'),('other','Fixture other','ordinary')")
    const first = new PostgresNativeFeatures(database),
      second = new PostgresNativeFeatures(database)
    const attempts = await Promise.allSettled([first.save('team', ['terminal'], 'none'), second.save('team', [], 'none')])
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(attempts.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'native-features-stale' } })
    const current = (await first.readGroup('team'))!
    const other = await second.save('other', ['terminal'], 'none')
    const restored = await first.save('team', [], current.revision)
    expect(restored.revision).not.toBe(current.revision)
    await expect(second.save('team', ['terminal'], current.revision)).rejects.toMatchObject({ code: 'native-features-stale' })
    expect(await first.readGroup('team')).toEqual(restored)
    await expect(first.save('missing', ['terminal'], 'none')).rejects.toMatchObject({ code: 'group-not-found' })
    await database.query("DELETE FROM dsh_phalanx.groups WHERE id='other'")
    expect(await first.readGroup('other')).toBeUndefined()
    expect(await database.query('SELECT group_id FROM dsh_phalanx.native_feature_group_settings WHERE group_id=$1', [other.groupId])).toEqual([])
    expect(await first.readGroup('team')).toEqual(restored)
  } finally {
    await cleanupOwned(
      () => database.close(),
      () => rm(root, { recursive: true, force: true }),
    )
  }
})

it('reads the current group and refuses retired spaces and disabled accounts in the same member query', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-feature-member-'))
  const database = await openTestDatabase(root)
  try {
    const accounts = new PostgresCommunityAccountStore(database)
    const admin = await accounts.createFirstAdmin({ username: 'admin', password: 'fixture-password', email: '' })
    const member = await accounts.create({ username: 'member', password: 'fixture-password', email: '' })
    const rows = new PostgresNativeFeatures(database)
    await rows.save('admin', ['terminal'], 'none')
    await rows.save('default', ['future-feature', 'terminal'], 'none')
    expect(await rows.forMember(admin)).toMatchObject({ groupId: 'admin', disabledIds: ['terminal'] })
    expect(await rows.forMember(member)).toMatchObject({ groupId: 'default', disabledIds: ['future-feature', 'terminal'] })
    await database.query("INSERT INTO dsh_phalanx.groups(id,name,kind) VALUES('other','Fixture other','ordinary')")
    await database.query("UPDATE dsh_phalanx.accounts SET group_id='other' WHERE username='member'")
    expect(await rows.forMember(member)).toMatchObject({ groupId: 'other', disabledIds: [] })
    expect(await rows.forMember({ ...member, spaceId: 'retired-space' })).toBeUndefined()
    await database.query("UPDATE dsh_phalanx.accounts SET disabled=true WHERE username='member'")
    expect(await rows.forMember(member)).toBeUndefined()
  } finally {
    await cleanupOwned(
      () => database.close(),
      () => rm(root, { recursive: true, force: true }),
    )
  }
})

it('rolls back policy and revision on rejected COMMIT and rechecks a revoked administrator session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-feature-commit-'))
  const database = await openTestDatabase(root)
  try {
    const accounts = new PostgresCommunityAccountStore(database)
    const admin = await accounts.createFirstAdmin({ username: 'admin', password: 'fixture-password', email: '' })
    const storage = createNativeFeatureStorage(database)
    const service = new NativeFeatures(nativeFeatureCatalog(), storage)
    const initial = await service.group(admin, 'default')
    await database.query(`CREATE TABLE dsh_phalanx.feature_reject_parent(id integer PRIMARY KEY);
      CREATE TABLE dsh_phalanx.feature_reject_child(id integer REFERENCES dsh_phalanx.feature_reject_parent DEFERRABLE INITIALLY DEFERRED);
      CREATE FUNCTION dsh_phalanx.reject_feature_save() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN INSERT INTO dsh_phalanx.feature_reject_child VALUES(1); RETURN NULL; END $$;
      CREATE TRIGGER reject_feature_save AFTER INSERT OR UPDATE ON dsh_phalanx.native_feature_group_settings
      FOR EACH ROW EXECUTE FUNCTION dsh_phalanx.reject_feature_save();`)
    await expect(service.save(admin, 'default', { revision: initial.revision, disabledIds: ['terminal'] })).rejects.toMatchObject({ sqlState: '23503' })
    expect(await service.group(admin, 'default')).toEqual(initial)
    await database.query('DROP TRIGGER reject_feature_save ON dsh_phalanx.native_feature_group_settings')
    await service.save(admin, 'default', { revision: initial.revision, disabledIds: ['terminal'] })
    await database.query("UPDATE dsh_phalanx.accounts SET session_epoch=session_epoch+1 WHERE username='admin'")
    await expect(service.group(admin, 'default')).rejects.toMatchObject({ code: 'sign-in-required' })
    await expect(service.save(admin, 'default', { revision: initial.revision, disabledIds: [] })).rejects.toMatchObject({ code: 'sign-in-required' })
    expect(await storage.rows.readGroup('default')).toMatchObject({ disabledIds: ['terminal'] })
  } finally {
    await cleanupOwned(
      () => database.close(),
      () => rm(root, { recursive: true, force: true }),
    )
  }
})
