import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { PlatformDatabase } from '../src/adapters/platform-database.js'
import { FilePlatformSecrets } from '../src/adapters/platform-secrets.js'
import { PostgresCommunityAccountStore } from '../src/adapters/postgres-community-accounts.js'
import { postgresConnection } from './support/postgres.js'

async function fixture(
  check: (writer: PostgresCommunityAccountStore, reader: PostgresCommunityAccountStore, first: PlatformDatabase, second: PlatformDatabase) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'postgres-accounts-')),
    masterKeyPath = join(root, 'master.key')
  const secrets = FilePlatformSecrets.create(masterKeyPath),
    security = { masterKeyPath, registry: secrets.registry() }
  secrets.close()
  const connection = postgresConnection(),
    first = new PlatformDatabase(connection, security),
    second = new PlatformDatabase(connection, security)
  try {
    await first.initialize()
    await second.initialize()
    await check(new PostgresCommunityAccountStore(first), new PostgresCommunityAccountStore(second), first, second)
  } finally {
    await Promise.all([first.close(), second.close()])
    rmSync(root, { recursive: true, force: true })
  }
}

it('persists the first administrator and completed bootstrap for another PostgreSQL connection', async () => {
  await fixture(async (writer, reader) => {
    expect(await reader.bootstrapComplete()).toBe(false)
    await writer.createFirstAdmin({ username: 'admin', email: 'admin@example.test', password: 'password' })
    expect(await reader.get('admin')).toMatchObject({
      username: 'admin',
      email: 'admin@example.test',
      admin: true,
      disabled: false,
      sessionEpoch: 0,
      groupId: 'admin',
    })
    expect(await reader.bootstrapComplete()).toBe(true)
  })
})

it('keeps existing memberships when the default group changes and assigns future members to the new default', async () => {
  await fixture(async (writer, reader) => {
    const first = await writer.create({ username: 'first', email: '', password: 'password' })
    const group = await writer.createGroup('Research')
    await writer.setDefaultGroup(group.id)
    const second = await writer.create({ username: 'second', email: '', password: 'password' })
    expect((await reader.get('first'))?.groupId).toBe(first.groupId)
    expect(second.groupId).toBe(group.id)
    expect(await reader.listGroups()).toEqual(expect.arrayContaining([{ ...group, isDefault: true, memberCount: 1 }]))
    expect((await reader.listGroups()).filter(row => row.isDefault)).toHaveLength(1)
  })
})

it('changes passwords and revokes old epochs on disable without restoring them on enable', async () => {
  await fixture(async (writer, reader) => {
    await writer.createFirstAdmin({ username: 'admin', email: '', password: 'password' })
    await writer.create({ username: 'member', email: '', password: 'initial-password' })
    expect(await reader.authenticate('MEMBER', 'initial-password')).toMatchObject({ username: 'member', sessionEpoch: 0 })
    await writer.resetPassword('MEMBER', 'replacement-password')
    expect(await reader.authenticate('member', 'initial-password')).toBeUndefined()
    expect(await reader.authenticate('member', 'replacement-password')).toMatchObject({ sessionEpoch: 1 })
    await writer.setDisabled('MEMBER', true)
    expect(await reader.authenticate('member', 'replacement-password')).toBeUndefined()
    expect(await reader.getState('member')).toMatchObject({ disabled: true, sessionEpoch: 2 })
    await writer.setDisabled('member', false)
    expect(await reader.authenticate('member', 'replacement-password')).toMatchObject({ disabled: false, sessionEpoch: 2 })
    expect(await reader.authenticate('absent', 'replacement-password')).toBeUndefined()
  })
})

it('keeps one enabled administrator when separate connections demote the final two concurrently', async () => {
  await fixture(async (writer, reader) => {
    await writer.createFirstAdmin({ username: 'admin', email: '', password: 'password' })
    await writer.create({ username: 'other', email: '', password: 'password' })
    await writer.setAdmin('other', true)
    const outcomes = await Promise.allSettled([writer.setAdmin('admin', false, 'default'), reader.setAdmin('other', false, 'default')])
    expect(outcomes.filter(row => row.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.find(row => row.status === 'rejected')).toMatchObject({ reason: { code: 'last-admin-required' } })
    expect((await reader.list()).filter(row => row.admin && !row.disabled)).toHaveLength(1)
  })
})

it('refuses a login whose initial PostgreSQL snapshot predates a completed disable', async () => {
  await fixture(async (writer, reader, first, second) => {
    await writer.createFirstAdmin({ username: 'admin', email: '', password: 'password' })
    await writer.create({ username: 'member', email: '', password: 'password' })
    // Hold only the first account SELECT after its statement snapshot was taken.
    // The real concurrent writer remains free to commit; no scrypt duration is assumed.
    await first.query(`CREATE SEQUENCE dsh_phalanx.login_reads;
      CREATE FUNCTION dsh_phalanx.pause_first_login_read() RETURNS boolean LANGUAGE plpgsql AS $$
        BEGIN IF nextval('dsh_phalanx.login_reads')=1 THEN PERFORM pg_advisory_xact_lock(1685282999); END IF; RETURN true; END $$;
      ALTER TABLE dsh_phalanx.accounts RENAME TO stored_accounts;
      CREATE VIEW dsh_phalanx.accounts AS SELECT * FROM dsh_phalanx.stored_accounts WHERE dsh_phalanx.pause_first_login_read();`)
    let entered!: () => void, release!: () => void
    const began = new Promise<void>(resolve => {
        entered = resolve
      }),
      gate = new Promise<void>(resolve => {
        release = resolve
      })
    const holder = first.transaction(async sql => {
      await sql.query('SELECT pg_advisory_xact_lock(1685282999)')
      entered()
      await gate
    })
    await began
    const signingIn = reader.authenticate('member', 'password')
    try {
      await expect
        .poll(async () =>
          Number(
            (
              await second.query<{ waiting: string }>(
                "SELECT count(*) AS waiting FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'",
              )
            )[0]!.waiting,
          ),
        )
        .toBeGreaterThan(0)
      await writer.setDisabled('member', true)
      release()
      await holder
      expect(await signingIn).toBeUndefined()
      expect(await reader.getState('member')).toMatchObject({ disabled: true, sessionEpoch: 1 })
    } finally {
      release()
      await Promise.allSettled([holder, signingIn])
      await first.query(
        'DROP VIEW dsh_phalanx.accounts; ALTER TABLE dsh_phalanx.stored_accounts RENAME TO accounts; DROP FUNCTION dsh_phalanx.pause_first_login_read(); DROP SEQUENCE dsh_phalanx.login_reads',
      )
    }
  })
})

it('waits for a concurrent PostgreSQL account mutation and refuses registration against the resulting disabled state', async () => {
  await fixture(async (writer, reader, first, second) => {
    await writer.create({ username: 'member', email: '', password: 'password' })
    let entered!: () => void,
      release!: () => void,
      registered = false
    const began = new Promise<void>(resolve => {
        entered = resolve
      }),
      gate = new Promise<void>(resolve => {
        release = resolve
      })
    const mutation = first.transaction(async sql => {
      await sql.query("UPDATE dsh_phalanx.accounts SET disabled=true,session_epoch=1 WHERE username='member'")
      entered()
      await gate
    })
    await began
    try {
      const admission = reader.withCurrentState('member', account => {
        if (!account || account.disabled) throw Error('Member admission refused')
        registered = true
      })
      const refused = expect(admission).rejects.toThrow('Member admission refused')
      try {
        await expect
          .poll(async () =>
            Number(
              (
                await second.query<{ waiting: string }>(
                  "SELECT count(*) AS waiting FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'",
                )
              )[0]!.waiting,
            ),
          )
          .toBeGreaterThan(0)
        release()
        await Promise.all([mutation, refused])
        expect(registered).toBe(false)
        expect(await reader.getState('member')).toMatchObject({ disabled: true, sessionEpoch: 1 })
      } finally {
        release()
        await Promise.allSettled([mutation, admission])
      }
    } finally {
      release()
      await mutation
    }
  })
})

it('reclaims registrations in reverse order when PostgreSQL itself rejects the final COMMIT', async () => {
  await fixture(async (writer, reader, database) => {
    await writer.create({ username: 'member', email: '', password: 'password' })
    // A real deferred foreign-key failure is injected by the read fixture. No fake database or async registration callback.
    await database.query(`CREATE TABLE dsh_phalanx.commit_parents(id integer PRIMARY KEY);
      CREATE TABLE dsh_phalanx.commit_children(id integer REFERENCES dsh_phalanx.commit_parents(id) DEFERRABLE INITIALLY DEFERRED);
      CREATE FUNCTION dsh_phalanx.defer_account_commit_failure() RETURNS boolean LANGUAGE plpgsql AS $$
        BEGIN INSERT INTO dsh_phalanx.commit_children VALUES(42); RETURN true; END $$;
      ALTER TABLE dsh_phalanx.accounts RENAME TO stored_accounts;
      CREATE VIEW dsh_phalanx.accounts AS SELECT * FROM dsh_phalanx.stored_accounts WHERE dsh_phalanx.defer_account_commit_failure();`)
    const connections = new Set<number>(),
      released: number[] = []
    const failure = await reader
      .withCurrentState('member', (account, onAbort) => {
        if (!account || account.disabled) throw Error('Fixture account unavailable')
        onAbort(() => {
          connections.delete(1)
          released.push(1)
        })
        connections.add(1)
        onAbort(() => {
          connections.delete(2)
          released.push(2)
        })
        connections.add(2)
      })
      .then(
        () => undefined,
        error => error as unknown,
      )
    expect(connections.size).toBe(0)
    expect(released).toEqual([2, 1])
    expect(failure).toMatchObject({ code: 'query-failed', sqlState: '23503', message: 'Platform database operation failed; check its connection and schema' })
    await database.query('DROP VIEW dsh_phalanx.accounts; ALTER TABLE dsh_phalanx.stored_accounts RENAME TO accounts')
    expect(await reader.getState('member')).toMatchObject({ disabled: false, sessionEpoch: 0 })
  })
})
