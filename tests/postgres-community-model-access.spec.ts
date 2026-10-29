import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { PostgresCommunityModelAccess } from '../src/adapters/postgres-community-model-access.js'
import { PostgresCommunityAccountStore } from '../src/adapters/postgres-community-accounts.js'
import { CommunityModelAuthorization } from '../src/use-cases/community-model-authorization.js'
import { openTestDatabase } from './support/community-application.js'

it('commits encrypted space tokens once across concurrent issuers and reopens them after restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'postgres-model-access-'))
  const database = await openTestDatabase(root),
    other = await openTestDatabase(root)
  try {
    const accounts = new PostgresCommunityAccountStore(database)
    const account = await accounts.createFirstAdmin({ username: 'admin', email: '', password: 'password' })
    const first = new PostgresCommunityModelAccess(database),
      second = new PostgresCommunityModelAccess(other)
    expect(() => first.resolve('wrong')).toThrow('not ready')
    await Promise.all([first.initialize(), second.initialize()])
    const [token, concurrent] = await Promise.all([first.forUser(account.username, account.spaceId), second.forUser(account.username, account.spaceId)])
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    expect(concurrent).toBe(token)
    expect(first.resolve(token)).toEqual({ username: account.username, spaceId: account.spaceId })
    expect(first.resolve('wrong')).toBeUndefined()
    const rows = await database.query('SELECT * FROM dsh_phalanx.model_access_tokens')
    expect(rows).toHaveLength(1)
    expect(JSON.stringify(rows)).not.toContain(token)
    expect(rows[0]!.token).toEqual({ key_id: expect.any(String), nonce: expect.any(String), ciphertext: expect.any(String) })
    const restarted = new PostgresCommunityModelAccess(other)
    await restarted.initialize()
    expect(restarted.resolve(token)).toEqual({ username: account.username, spaceId: account.spaceId })
    expect(await restarted.forUser(account.username, account.spaceId)).toBe(token)
  } finally {
    await Promise.all([database.close(), other.close()])
    await rm(root, { recursive: true, force: true })
  }
})

it('rejects a deleted space after username reuse and cascades its durable token without trusting the cache', async () => {
  const root = await mkdtemp(join(tmpdir(), 'postgres-token-space-'))
  const database = await openTestDatabase(root)
  try {
    const accounts = new PostgresCommunityAccountStore(database)
    await accounts.createFirstAdmin({ username: 'admin', email: '', password: 'password' })
    const old = await accounts.create({ username: 'member', email: '', password: 'password' })
    const access = new PostgresCommunityModelAccess(database)
    await access.initialize()
    const oldToken = await access.forUser(old.username, old.spaceId)
    const authorization = new CommunityModelAuthorization(accounts, access)
    expect(await authorization.authorize(oldToken)).toBe('member')
    await accounts.delete('member')
    expect(await database.query('SELECT * FROM dsh_phalanx.model_access_tokens')).toEqual([])
    const current = await accounts.create({ username: 'member', email: '', password: 'password' })
    expect(current.spaceId).not.toBe(old.spaceId)
    const currentToken = await access.forUser(current.username, current.spaceId)
    await expect(access.forUser(old.username, old.spaceId)).rejects.toMatchObject({ kind: 'forbidden' })
    await expect(authorization.authorize(oldToken)).rejects.toMatchObject({ kind: 'forbidden' })
    expect(await authorization.authorize(currentToken)).toBe('member')
    expect(await access.forUser(current.username, current.spaceId)).toBe(currentToken)
  } finally {
    await database.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('does not publish a token or advance its cache version when PostgreSQL rejects COMMIT', async () => {
  const root = await mkdtemp(join(tmpdir(), 'postgres-token-commit-'))
  const database = await openTestDatabase(root)
  try {
    const accounts = new PostgresCommunityAccountStore(database)
    const account = await accounts.createFirstAdmin({ username: 'admin', email: '', password: 'password' })
    const access = new PostgresCommunityModelAccess(database)
    await access.initialize()
    await database.query(`CREATE TABLE dsh_phalanx.token_parents(id integer PRIMARY KEY);
      CREATE TABLE dsh_phalanx.token_children(id integer REFERENCES dsh_phalanx.token_parents(id) DEFERRABLE INITIALLY DEFERRED);
      CREATE FUNCTION dsh_phalanx.reject_token_commit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN INSERT INTO dsh_phalanx.token_children VALUES(42); RETURN NEW; END $$;
      CREATE TRIGGER reject_token_commit AFTER INSERT ON dsh_phalanx.model_access_tokens FOR EACH ROW EXECUTE FUNCTION dsh_phalanx.reject_token_commit();`)
    await expect(access.forUser(account.username, account.spaceId)).rejects.toMatchObject({ code: 'query-failed', sqlState: '23503' })
    expect(access.version()).toBe(0)
    expect(await database.query('SELECT * FROM dsh_phalanx.model_access_tokens')).toEqual([])
    await database.query('DROP TRIGGER reject_token_commit ON dsh_phalanx.model_access_tokens')
    const token = await access.forUser(account.username, account.spaceId)
    expect(access.version()).toBe(1)
    expect(access.resolve(token)).toEqual({ username: account.username, spaceId: account.spaceId })
  } finally {
    await database.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('waits for accepted token issuance before closing and rejects new issuance during the drain', async () => {
  const root = await mkdtemp(join(tmpdir(), 'postgres-token-close-'))
  const database = await openTestDatabase(root)
  let release!: () => void, holder: Promise<void> | undefined, issuing: Promise<string> | undefined, closing: Promise<void> | undefined
  try {
    const accounts = new PostgresCommunityAccountStore(database)
    const account = await accounts.createFirstAdmin({ username: 'admin', email: '', password: 'password' })
    const access = new PostgresCommunityModelAccess(database)
    await access.initialize()
    let entered!: () => void,
      closed = false
    const began = new Promise<void>(resolve => {
        entered = resolve
      }),
      gate = new Promise<void>(resolve => {
        release = resolve
      })
    holder = database.transaction(async sql => {
      await sql.query('SELECT username FROM dsh_phalanx.accounts WHERE username=$1 FOR UPDATE', [account.username])
      entered()
      await gate
    })
    await began
    issuing = access.forUser(account.username, account.spaceId)
    await expect
      .poll(async () =>
        Number(
          (
            await database.query<{ waiting: string }>(
              "SELECT count(*) AS waiting FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'",
            )
          )[0]!.waiting,
        ),
      )
      .toBeGreaterThan(0)
    expect(access.version()).toBe(0)
    closing = access.close().then(() => {
      closed = true
    })
    await expect(access.forUser(account.username, account.spaceId)).rejects.toThrow('closed')
    expect(closed).toBe(false)
    release()
    await holder
    await issuing
    await closing
    expect(() => access.resolve('wrong')).toThrow('closed')
    await expect(access.initialize()).rejects.toThrow('closed')
    expect(await database.query('SELECT * FROM dsh_phalanx.model_access_tokens')).toHaveLength(1)
  } finally {
    release?.()
    await Promise.allSettled([holder, issuing, closing])
    await database.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('rejects an encrypted gateway token copied from another space instead of loading an alternate token', async () => {
  const root = await mkdtemp(join(tmpdir(), 'postgres-token-aad-'))
  const database = await openTestDatabase(root)
  try {
    const accounts = new PostgresCommunityAccountStore(database)
    const alice = await accounts.create({ username: 'alice', email: '', password: 'password' })
    const bob = await accounts.create({ username: 'bob', email: '', password: 'password' })
    const access = new PostgresCommunityModelAccess(database)
    await access.initialize()
    await access.forUser(alice.username, alice.spaceId)
    await access.forUser(bob.username, bob.spaceId)
    await access.close()
    await database.query(
      'UPDATE dsh_phalanx.model_access_tokens SET token=(SELECT token FROM dsh_phalanx.model_access_tokens WHERE space_id=$1) WHERE space_id=$2',
      [alice.spaceId, bob.spaceId],
    )
    const reopened = new PostgresCommunityModelAccess(database)
    await expect(reopened.initialize()).rejects.toThrow('Cannot decrypt platform secret at model_access_tokens/' + bob.spaceId + '/token')
    expect(() => reopened.resolve('wrong')).toThrow('not ready')
  } finally {
    await database.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('rejects a decrypted token with invalid syntax before publishing the startup index', async () => {
  const root = await mkdtemp(join(tmpdir(), 'postgres-token-invalid-'))
  const database = await openTestDatabase(root)
  try {
    const accounts = new PostgresCommunityAccountStore(database)
    const member = await accounts.create({ username: 'member', email: '', password: 'password' })
    const token = database.cipher().encrypt({ table: 'model_access_tokens', recordId: member.spaceId, field: 'token' }, 'short')
    await database.query('INSERT INTO dsh_phalanx.model_access_tokens(space_id,token) VALUES($1,$2)', [member.spaceId, JSON.stringify(token)])
    const access = new PostgresCommunityModelAccess(database)
    await expect(access.initialize()).rejects.toThrow('Invalid community model access token')
    expect(() => access.resolve('wrong')).toThrow('not ready')
    await access.close()
  } finally {
    await database.close()
    await rm(root, { recursive: true, force: true })
  }
})
