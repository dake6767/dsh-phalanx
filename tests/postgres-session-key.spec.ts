import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { PostgresSessionKey } from '../src/adapters/postgres-session-key.js'
import { PlatformSessionCodec } from '../src/inbound/platform-session.js'
import { SignedPluginDownloadTokens } from '../src/adapters/plugin-download-tokens.js'
import { PostgresCommunityAccountStore } from '../src/adapters/postgres-community-accounts.js'
import { openTestDatabase } from './support/community-application.js'

it('generates one encrypted signing key and preserves session and download signatures across independent restarts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'postgres-session-key-'))
  const database = await openTestDatabase(root),
    other = await openTestDatabase(root)
  try {
    const accounts = new PostgresCommunityAccountStore(database)
    await accounts.createFirstAdmin({ username: 'admin', email: '', password: 'password' })
    const account = (await accounts.getState('admin'))!
    const first = new PostgresSessionKey(database),
      second = new PostgresSessionKey(other)
    expect(() => first.read()).toThrow('not ready')
    const sessions = new PlatformSessionCodec(first),
      downloads = new SignedPluginDownloadTokens(first)
    expect(() => sessions.issue(account)).toThrow('not ready')
    await Promise.all([first.initialize(), second.initialize()])
    expect(first.read()).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    expect(second.read()).toBe(first.read())
    const rows = await database.query('SELECT * FROM dsh_phalanx.session_signing_key')
    expect(rows).toHaveLength(1)
    expect(JSON.stringify(rows)).not.toContain(first.read())
    expect(rows[0]!.signing_key).toEqual({ key_id: expect.any(String), nonce: expect.any(String), ciphertext: expect.any(String) })
    const session = sessions.issue(account)
    const grant = {
      username: 'admin',
      spaceId: account.spaceId,
      sessionEpoch: account.sessionEpoch,
      packageName: 'fixture',
      integrity: 'fixture-integrity',
      artifact: 'fixture-artifact',
      expiresAt: Date.now() + 60_000,
    }
    const download = downloads.issue(grant)
    await first.close()
    expect(() => sessions.issue(account)).toThrow('closed')
    const restarted = new PostgresSessionKey(database)
    await restarted.initialize()
    expect(new PlatformSessionCodec(restarted).verify(session)).toMatchObject({ userId: 'admin', spaceId: account.spaceId })
    expect(new SignedPluginDownloadTokens(restarted).read(download)).toEqual(grant)
    await restarted.close()
    await second.close()
  } finally {
    await Promise.all([database.close(), other.close()])
    await rm(root, { recursive: true, force: true })
  }
})

it('keeps the signing cache unavailable when PostgreSQL rejects the generated key at COMMIT', async () => {
  const root = await mkdtemp(join(tmpdir(), 'postgres-session-commit-'))
  const database = await openTestDatabase(root)
  try {
    await database.query(`CREATE TABLE dsh_phalanx.signing_parents(id integer PRIMARY KEY);
      CREATE TABLE dsh_phalanx.signing_children(id integer REFERENCES dsh_phalanx.signing_parents(id) DEFERRABLE INITIALLY DEFERRED);
      CREATE FUNCTION dsh_phalanx.reject_signing_commit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN INSERT INTO dsh_phalanx.signing_children VALUES(42); RETURN NEW; END $$;
      CREATE TRIGGER reject_signing_commit AFTER INSERT ON dsh_phalanx.session_signing_key FOR EACH ROW EXECUTE FUNCTION dsh_phalanx.reject_signing_commit();`)
    const key = new PostgresSessionKey(database)
    await expect(key.initialize()).rejects.toMatchObject({ code: 'query-failed', sqlState: '23503' })
    expect(() => key.read()).toThrow('not ready')
    expect(await database.query('SELECT * FROM dsh_phalanx.session_signing_key')).toEqual([])
    await key.close()
    await database.query('DROP TRIGGER reject_signing_commit ON dsh_phalanx.session_signing_key')
    const restarted = new PostgresSessionKey(database)
    await restarted.initialize()
    expect(restarted.read()).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    await restarted.close()
  } finally {
    await database.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('rejects a decrypted signing key that is too short without silently replacing it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'postgres-session-invalid-'))
  const database = await openTestDatabase(root)
  try {
    const envelope = database.cipher().encrypt({ table: 'session_signing_key', recordId: '1', field: 'signing_key' }, 'short')
    await database.query('INSERT INTO dsh_phalanx.session_signing_key(id,signing_key) VALUES(1,$1)', [JSON.stringify(envelope)])
    const key = new PostgresSessionKey(database)
    await expect(key.initialize()).rejects.toThrow('Invalid platform session key')
    expect(() => key.read()).toThrow('not ready')
    expect((await database.query('SELECT signing_key FROM dsh_phalanx.session_signing_key'))[0]!.signing_key).toEqual(envelope)
    await key.close()
  } finally {
    await database.close()
    await rm(root, { recursive: true, force: true })
  }
})
