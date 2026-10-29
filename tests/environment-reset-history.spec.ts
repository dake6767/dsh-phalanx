import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { PostgresCommunityAccountStore } from '../src/adapters/postgres-community-accounts.js'
import { createSpaceStorage } from '../src/composition/community-space-storage.js'
import { CommunityEnvironmentRecovery } from '../src/use-cases/community-environment-recovery.js'
import type { EnvironmentResetPersistence } from '../src/ports/environment-reset-persistence.js'
import { cleanupOwned } from './fixtures/owned-cleanup.js'
import { openTestDatabase } from './support/community-application.js'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'reset-history-pg-'))
  const database = await openTestDatabase(root)
  const accounts = new PostgresCommunityAccountStore(database)
  const persistence = createSpaceStorage(database, { dataRoot: root }).resets
  let now = 0,
    effects = 0
  const service = (storage: EnvironmentResetPersistence = persistence) =>
    new CommunityEnvironmentRecovery(
      accounts,
      {
        recover: async (userId, _origin, prepare) => {
          await prepare()
          return { userId, processId: 1, origin: 'http://localhost', launchUrl: 'http://localhost' }
        },
      },
      { backup: async () => ({ id: 'fixture', location: '/private/fixture', restoreInstructions: 'Follow README' }), reset: async () => {} },
      {
        closeUser: async () => {
          effects++
        },
      },
      storage,
      { now: () => now },
    )
  return {
    database,
    accounts,
    persistence,
    service,
    at: (value: number) => {
      now = value
    },
    effects: () => effects,
    close: () =>
      cleanupOwned(
        () => database.close(),
        () => rm(root, { recursive: true, force: true }),
      ),
  }
}
const origin = new URL('https://community.example/')

it('serializes independent reset owners, persists the member window and keeps administrator credit independently', async () => {
  const f = await fixture()
  try {
    const admin = await f.accounts.createFirstAdmin({ username: 'admin', password: 'fixture-password', email: '' })
    const member = await f.accounts.create({ username: 'member', password: 'fixture-password', email: '' })
    const results = await Promise.allSettled([f.service().reset(member, member.username, origin), f.service().reset(member, member.username, origin)])
    expect(results.filter(row => row.status === 'fulfilled')).toHaveLength(1)
    expect(results.find(row => row.status === 'rejected')).toMatchObject({ reason: { code: 'environment-reset-rate-limited' } })
    expect(f.effects()).toBe(1)
    expect(await f.persistence.history.get(member.spaceId)).toEqual({ lastMemberAcceptedAt: 0, recent: { at: 0, username: 'member', role: 'member' } })
    f.at(100)
    await f.service().reset(admin, member.username, origin)
    expect(await f.persistence.history.get(member.spaceId)).toEqual({ lastMemberAcceptedAt: 0, recent: { at: 100, username: 'admin', role: 'admin' } })
    await f.accounts.create({ username: 'backupadmin', password: 'fixture-password', email: '' })
    await f.accounts.setAdmin('backupadmin', true)
    await f.accounts.delete('admin')
    expect((await f.persistence.history.get(member.spaceId))?.recent.username).toBe('admin')
    f.at(599999)
    await expect(f.service().reset(member, member.username, origin)).rejects.toMatchObject({ code: 'environment-reset-rate-limited' })
    f.at(600000)
    await f.service().reset(member, member.username, origin)
    expect((await f.persistence.history.get(member.spaceId))?.lastMemberAcceptedAt).toBe(600000)
    await f.accounts.delete('member')
    const replacement = await f.accounts.create({ username: 'member', password: 'replacement-password', email: '' })
    expect(replacement.spaceId).not.toBe(member.spaceId)
    expect(await f.persistence.history.get(member.spaceId)).toBeUndefined()
    expect(await f.persistence.history.get(replacement.spaceId)).toBeUndefined()
  } finally {
    await f.close()
  }
})

it('starts no external effects and consumes no cooldown when acceptance COMMIT is rejected', async () => {
  const f = await fixture()
  try {
    const member = await f.accounts.create({ username: 'member', password: 'fixture-password', email: '' })
    await f.database.query(`CREATE TABLE dsh_phalanx.reset_reject_parent(id integer PRIMARY KEY);
      CREATE TABLE dsh_phalanx.reset_reject_child(id integer REFERENCES dsh_phalanx.reset_reject_parent DEFERRABLE INITIALLY DEFERRED);
      CREATE FUNCTION dsh_phalanx.reject_reset() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN INSERT INTO dsh_phalanx.reset_reject_child VALUES(1); RETURN NULL; END $$;
      CREATE TRIGGER reject_reset AFTER INSERT ON dsh_phalanx.environment_reset_history FOR EACH ROW EXECUTE FUNCTION dsh_phalanx.reject_reset();`)
    await expect(f.service().reset(member, member.username, origin)).rejects.toMatchObject({ sqlState: '23503' })
    expect(f.effects()).toBe(0)
    expect(await f.persistence.history.get(member.spaceId)).toBeUndefined()
    await f.database.query('DROP TRIGGER reject_reset ON dsh_phalanx.environment_reset_history')
    await f.service().reset(member, member.username, origin)
    expect(f.effects()).toBe(1)
    expect((await f.persistence.history.get(member.spaceId))?.lastMemberAcceptedAt).toBe(0)
  } finally {
    await f.close()
  }
})

it('rejects an old target before acceptance when the username was recreated during admission', async () => {
  const f = await fixture()
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const reached = new Promise<void>(resolve => {
    entered = resolve
  })
  try {
    const admin = await f.accounts.createFirstAdmin({ username: 'admin', password: 'fixture-password', email: '' })
    const member = await f.accounts.create({ username: 'member', password: 'fixture-password', email: '' })
    const service = f.service({
      history: f.persistence.history,
      work: {
        run: async operation => {
          entered()
          await gate
          return f.persistence.work.run(operation)
        },
      },
    })
    const pending = service.reset(admin, member.username, origin)
    const rejected = expect(pending).rejects.toMatchObject({ code: 'environment-space-changed' })
    await reached
    await f.accounts.delete(member.username)
    const replacement = await f.accounts.create({ username: 'member', password: 'replacement-password', email: '' })
    release()
    await rejected
    expect(f.effects()).toBe(0)
    expect(await f.persistence.history.get(member.spaceId)).toBeUndefined()
    expect(await f.persistence.history.get(replacement.spaceId)).toBeUndefined()
  } finally {
    release()
    await f.close()
  }
})
