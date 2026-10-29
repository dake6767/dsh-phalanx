import { PostgresUnitOfWork } from '../src/adapters/postgres-unit-of-work.js'
import { PostgresContributionSetups } from '../src/adapters/postgres-contribution-setups.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { openTestDatabase } from './support/community-application.js'
import { cleanupOwned } from './fixtures/owned-cleanup.js'
import { PostgresCommunityAccountStore } from '../src/adapters/postgres-community-accounts.js'
import { PostgresContributionRows } from '../src/adapters/postgres-contribution-rows.js'
import type { MemberContribution } from '../src/domain/member-contribution.js'

it('persists individual contribution records and keeps author history after the account disappears', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contribution-rows-'))
  const database = await openTestDatabase(root)
  const store = new PostgresContributionRows(database),
    accounts = new PostgresCommunityAccountStore(database)
  try {
    const account = await accounts.create({ username: 'author', password: 'fixture-password', email: '' })
    const contributor = { username: account.username, spaceId: account.spaceId, sessionEpoch: account.sessionEpoch }
    const row: MemberContribution = {
      id: 'one',
      revision: 'upload-one',
      hash: 'a'.repeat(64),
      name: 'guide',
      description: 'Guide',
      markdown: '# Guide',
      files: ['SKILL.md'],
      contributor,
      declaration: { purpose: 'Share' },
      submittedAt: 1,
      updatedAt: 1,
      status: 'pending',
    }
    await store.save(row)
    const initial = (await store.get(row.id))!
    expect(initial.row).toEqual(row)
    await store.save({ ...row, status: 'adopted' }, initial.revision)
    await store.save({ ...row, id: 'pending' })
    const reopened = new PostgresContributionRows(database)
    expect((await reopened.list()).map(record => record.row.id).sort()).toEqual(['one', 'pending'])
    await database.query('DELETE FROM dsh_phalanx.accounts WHERE space_id=$1', [account.spaceId])
    expect(await reopened.get('pending')).toBeUndefined()
    expect((await reopened.get('one'))?.row).toEqual({ ...row, status: 'adopted' })
    const replacement = await accounts.create({ username: 'author', password: 'replacement-password', email: '' })
    expect(replacement.spaceId).not.toBe(contributor.spaceId)
    expect((await reopened.get('one'))?.row.contributor).toEqual(contributor)
  } finally {
    await cleanupOwned(
      () => database.close(),
      () => rm(root, { recursive: true, force: true }),
    )
  }
})

it('keeps unrelated contributions independent, rejects stale rows and rolls protected setup back on rejected COMMIT', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contribution-row-transactions-'))
  const database = await openTestDatabase(root),
    store = new PostgresContributionRows(database),
    accounts = new PostgresCommunityAccountStore(database)
  const setups = new PostgresContributionSetups(database)
  try {
    await setups.initialize()
    const account = await accounts.create({ username: 'author', password: 'fixture-password', email: '' })
    const first: MemberContribution = {
      id: 'first',
      revision: 'upload-first',
      hash: 'a'.repeat(64),
      name: 'guide',
      description: '',
      markdown: '# Guide',
      files: [],
      contributor: { username: account.username, spaceId: account.spaceId, sessionEpoch: account.sessionEpoch },
      declaration: { purpose: 'Share' },
      submittedAt: 0,
      updatedAt: 0,
      status: 'pending',
    }
    const second = { ...first, id: 'second', name: 'other' }
    await store.save(first)
    await store.save(second)
    const a = (await store.get('first'))!,
      b = (await store.get('second'))!
    await Promise.all([
      store.save({ ...first, description: 'First changed' }, a.revision),
      store.save({ ...second, description: 'Second changed' }, b.revision),
    ])
    await expect(store.save({ ...first, status: 'declined' }, a.revision)).rejects.toMatchObject({ code: 'contribution-unavailable' })
    expect((await store.get('first'))?.row.description).toBe('First changed')
    expect((await store.get('second'))?.row.description).toBe('Second changed')
    const current = (await store.get('first'))!
    await database.query(`CREATE TABLE dsh_phalanx.reject_contribution_parent(id integer PRIMARY KEY);
      CREATE TABLE dsh_phalanx.reject_contribution_child(id integer REFERENCES dsh_phalanx.reject_contribution_parent DEFERRABLE INITIALLY DEFERRED);
      CREATE FUNCTION dsh_phalanx.reject_contribution() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN INSERT INTO dsh_phalanx.reject_contribution_child VALUES(1); RETURN NULL; END $$;
      CREATE TRIGGER reject_contribution AFTER UPDATE ON dsh_phalanx.contributions FOR EACH ROW EXECUTE FUNCTION dsh_phalanx.reject_contribution();`)
    const work = new PostgresUnitOfWork(database, { contributions: tx => new PostgresContributionRows(tx), setups: tx => new PostgresContributionSetups(tx) })
    let reference = ''
    await expect(
      work.run(async rows => {
        reference = await rows.setups.save(first, {
          execution: { enabled: true, commands: [], variables: [{ name: 'KEY', value: 'fictional-private-value', secret: true }] },
        })
        await rows.contributions.save({ ...current.row, status: 'adopted' }, current.revision)
      }),
    ).rejects.toMatchObject({ sqlState: '23503' })
    expect(await store.get('first')).toEqual(current)
    expect(await setups.read(reference, first)).toBeUndefined()
  } finally {
    await cleanupOwned(
      () => setups.close(),
      () => database.close(),
      () => rm(root, { recursive: true, force: true }),
    )
  }
})
