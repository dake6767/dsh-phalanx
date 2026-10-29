import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { UserStorageGuard } from '../src/adapters/user-storage-guard.js'
import { PostgresUserStorageFacts } from '../src/adapters/postgres-user-storage-facts.js'
import { openTestDatabase } from './support/community-application.js'
import { cleanupOwned, removeCommunityFixture } from './fixtures/owned-cleanup.js'

it.each(['durable', 'legacy'])('refuses retained default files before creating a new SQL owner (%s)', async layout => {
  const directory = mkdtempSync(join(tmpdir(), 'storage-unowned-default-')),
    platform = join(directory, 'data')
  mkdirSync(platform, { mode: 0o700 })
  const previous = layout === 'durable' ? join(directory, 'data.durable/users/member/home') : join(platform, 'users/member/home')
  mkdirSync(previous, { recursive: true, mode: 0o700 })
  writeFileSync(join(previous, 'retained.txt'), 'KEEP_PRIVATE_USER_FILE', { mode: 0o600 })
  const database = await openTestDatabase(platform),
    facts = new PostgresUserStorageFacts(database)
  try {
    await expect(new UserStorageGuard(platform, facts).initialize()).rejects.toThrow('User data storage is unavailable')
    expect(await facts.read()).toBeUndefined()
    expect(readFileSync(join(previous, 'retained.txt'), 'utf8')).toBe('KEEP_PRIVATE_USER_FILE')
  } finally {
    await cleanupOwned(
      () => database.close(),
      async () => rmSync(directory, { recursive: true, force: true }),
    )
  }
})

it.each(['durable', 'legacy'])('refuses an empty external binding while retained default user files exist (%s)', async layout => {
  const directory = mkdtempSync(join(tmpdir(), 'storage-retained-default-'))
  const platform = join(directory, 'data'),
    storage = join(directory, 'external')
  mkdirSync(platform, { mode: 0o700 })
  mkdirSync(storage, { mode: 0o700 })
  const previous = layout === 'durable' ? join(directory, 'data.durable/users/member/home') : join(platform, 'users/member/home')
  mkdirSync(previous, { recursive: true, mode: 0o700 })
  writeFileSync(join(previous, 'retained.txt'), 'KEEP_DEFAULT_USER_FILE', { mode: 0o600 })
  const database = await openTestDatabase(platform),
    facts = new PostgresUserStorageFacts(database)
  try {
    await expect(new UserStorageGuard(platform, facts, storage).initialize()).rejects.toThrow('User data storage is unavailable')
    expect((await facts.read())?.binding ?? null).toBeNull()
    expect(existsSync(join(storage, '.dsh-phalanx-storage.json'))).toBe(false)
    expect(readFileSync(join(previous, 'retained.txt'), 'utf8')).toBe('KEEP_DEFAULT_USER_FILE')
  } finally {
    await cleanupOwned(
      () => database.close(),
      async () => rmSync(directory, { recursive: true, force: true }),
    )
  }
})

it('rejects lost storage, changed markers, changed SQL bindings and ownership while only physical mount information is cached', async () => {
  const platform = mkdtempSync(join(tmpdir(), 'storage-platform-')),
    storage = mkdtempSync(join(tmpdir(), 'storage-volume-'))
  const detached = storage + '-detached'
  const database = await openTestDatabase(platform),
    facts = new PostgresUserStorageFacts(database)
  try {
    const guard = new UserStorageGuard(platform, facts, storage)
    await expect(guard.assertAvailable()).rejects.toThrow('User data storage is unavailable')
    await guard.initialize()
    await guard.assertAvailable()
    await guard.assertAvailable()
    expect(existsSync(join(platform, 'user-storage.json'))).toBe(false)
    expect(existsSync(join(platform, 'user-storage-identity'))).toBe(false)
    chmodSync(storage, 0o500)
    await expect(guard.assertAvailable()).rejects.toThrow('User data storage is unavailable')
    chmodSync(storage, 0o700)
    await guard.assertAvailable()
    const marker = join(storage, '.dsh-phalanx-storage.json'),
      original = readFileSync(marker, 'utf8')
    writeFileSync(marker, JSON.stringify({ id: '1'.repeat(32), owner: 'different-platform' }))
    await expect(guard.assertAvailable()).rejects.toThrow('User data storage is unavailable')
    writeFileSync(marker, original)
    const before = (await facts.read())!
    await facts.saveBinding(before.revision, { ...before.binding!, id: '2'.repeat(32) })
    await expect(guard.assertAvailable()).rejects.toThrow('User data storage is unavailable')
    await facts.saveBinding(before.revision + 1, before.binding)
    await guard.assertAvailable()
    await expect(new UserStorageGuard(platform, facts).initialize()).rejects.toThrow('User data storage is unavailable')
    renameSync(storage, detached)
    await expect(guard.assertAvailable()).rejects.toThrow('User data storage is unavailable')
  } finally {
    await cleanupOwned(
      () => database.close(),
      async () => {
        rmSync(platform, { recursive: true, force: true })
        rmSync(storage, { recursive: true, force: true })
        rmSync(detached, { recursive: true, force: true })
      },
    )
  }
})

it('resumes the same marker and owner after rejected SQL publication without losing later target files', async () => {
  const platform = mkdtempSync(join(tmpdir(), 'storage-publication-')),
    storage = mkdtempSync(join(tmpdir(), 'storage-target-'))
  const database = await openTestDatabase(platform),
    facts = new PostgresUserStorageFacts(database)
  try {
    await database.query(`CREATE TABLE dsh_phalanx.storage_reject_parent(id integer PRIMARY KEY);
      CREATE TABLE dsh_phalanx.storage_reject_child(id integer REFERENCES dsh_phalanx.storage_reject_parent DEFERRABLE INITIALLY DEFERRED);
      CREATE FUNCTION dsh_phalanx.reject_storage() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN INSERT INTO dsh_phalanx.storage_reject_child VALUES(1); RETURN NULL; END $$;
      CREATE TRIGGER reject_storage AFTER INSERT ON dsh_phalanx.user_storage_binding FOR EACH ROW EXECUTE FUNCTION dsh_phalanx.reject_storage();`)
    await expect(new UserStorageGuard(platform, facts, storage).initialize()).rejects.toThrow('User data storage is unavailable')
    const pending = (await facts.read())!
    expect(pending.binding).toBeNull()
    expect(pending.revision).toBe(0)
    const markerPath = join(storage, '.dsh-phalanx-storage.json'),
      marker = readFileSync(markerPath, 'utf8')
    expect(JSON.parse(marker).owner).toBe(pending.owner)
    writeFileSync(join(storage, 'later-file'), 'KEEP_LATER_FILE')
    await database.query('DROP TRIGGER reject_storage ON dsh_phalanx.user_storage_binding')
    const resumed = new UserStorageGuard(platform, new PostgresUserStorageFacts(database), storage)
    await resumed.initialize()
    await resumed.assertAvailable()
    expect(readFileSync(markerPath, 'utf8')).toBe(marker)
    expect(readFileSync(join(storage, 'later-file'), 'utf8')).toBe('KEEP_LATER_FILE')
    expect((await facts.read())?.binding?.id).toBe(JSON.parse(marker).id)
    await database.query('DELETE FROM dsh_phalanx.user_storage_identity')
    await expect(new UserStorageGuard(platform, facts, storage).initialize()).rejects.toThrow('User data storage is unavailable')
    expect(await facts.read()).toBeUndefined()
    expect(readFileSync(markerPath, 'utf8')).toBe(marker)
  } finally {
    await cleanupOwned(
      () => database.close(),
      async () => {
        rmSync(platform, { recursive: true, force: true })
        rmSync(storage, { recursive: true, force: true })
      },
    )
  }
})

it('keeps omitted default user storage distinct from an explicitly configured external mount', async () => {
  const platform = mkdtempSync(join(tmpdir(), 'storage-default-'))
  const database = await openTestDatabase(platform),
    facts = new PostgresUserStorageFacts(database)
  try {
    const guard = new UserStorageGuard(platform, facts, undefined, true)
    await guard.initialize()
    await guard.assertAvailable()
    expect((await facts.read())?.binding).toBeNull()
    const home = platform + '.durable/users/member/home'
    mkdirSync(home, { recursive: true, mode: 0o700 })
    writeFileSync(join(home, 'retained.txt'), 'KNOWN_PLATFORM_PRIVATE_FILE', { mode: 0o600 })
    await new UserStorageGuard(platform, facts).initialize()
    expect(readFileSync(join(home, 'retained.txt'), 'utf8')).toBe('KNOWN_PLATFORM_PRIVATE_FILE')

    await expect(new UserStorageGuard(platform, facts, undefined, true, platform).initialize()).rejects.toThrow('User data storage is unavailable')
  } finally {
    await cleanupOwned(
      () => database.close(),
      () => removeCommunityFixture(platform),
    )
  }
})

it.each(['namespace', 'users'])('refuses a symbolic link in default durable storage (%s)', async location => {
  const directory = mkdtempSync(join(tmpdir(), 'storage-default-link-')),
    platform = join(directory, 'data'),
    namespace = platform + '.durable',
    outside = join(directory, 'outside')
  mkdirSync(platform, { mode: 0o700 })
  mkdirSync(outside, { mode: 0o700 })
  if (location === 'namespace') symlinkSync(outside, namespace)
  else {
    mkdirSync(namespace, { mode: 0o700 })
    symlinkSync(outside, join(namespace, 'users'))
  }
  const database = await openTestDatabase(platform),
    facts = new PostgresUserStorageFacts(database)
  try {
    await expect(new UserStorageGuard(platform, facts).initialize()).rejects.toThrow('User data storage is unavailable')
  } finally {
    await cleanupOwned(
      () => database.close(),
      async () => rmSync(directory, { recursive: true, force: true }),
    )
  }
})
