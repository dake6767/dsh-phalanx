import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { PostgresInstanceResources } from '../src/adapters/postgres-instance-resources.js'
import { PostgresCommunityAccountStore } from '../src/adapters/postgres-community-accounts.js'
import { UNLIMITED_INSTANCE_RESOURCES } from '../src/domain/instance-resources.js'
import { openTestDatabase } from './support/community-application.js'
import { cleanupOwned } from './fixtures/owned-cleanup.js'

it('imports deployment defaults once and admits only one independent writer at a shared revision', async () => {
  const root = await mkdtemp(join(tmpdir(), 'resource-rows-'))
  const database = await openTestDatabase(root)
  const store = new PostgresInstanceResources(database)
  try {
    const accounts = new PostgresCommunityAccountStore(database)
    const alice = await accounts.create({ username: 'alice', password: 'fixture-password', email: '' })
    const bob = await accounts.create({ username: 'bob', password: 'fixture-password', email: '' })
    await store.initialize({ cpus: 0.5, memoryMiB: 512, pids: 64 }, 0)
    const second = new PostgresInstanceResources(database)
    await second.initialize(UNLIMITED_INSTANCE_RESOURCES, 900)
    expect(await second.read()).toEqual({
      revision: 0,
      defaults: { cpus: 0.5, memoryMiB: 512, pids: 64 },
      idleSeconds: 0,
      overrides: {},
      residents: {},
    })
    const attempts = await Promise.allSettled([
      store.saveMember(0, alice.spaceId, UNLIMITED_INSTANCE_RESOURCES, true),
      second.saveMember(0, bob.spaceId, { cpus: 2, memoryMiB: 2048, pids: 256 }, true),
    ])
    expect(attempts.filter(row => row.status === 'fulfilled')).toHaveLength(1)
    expect(attempts.find(row => row.status === 'rejected')).toMatchObject({
      reason: { code: 'instance-resource-revision-conflict' },
    })
    const state = await store.read()
    expect(state.revision).toBe(1)
    const winner = Object.keys(state.overrides)[0]!
    expect(Object.keys(state.overrides)).toEqual([winner])
    expect(state.residents).toEqual({ [winner]: true })
    const loser = winner === alice.spaceId ? bob.spaceId : alice.spaceId
    await second.saveMember(1, loser, UNLIMITED_INSTANCE_RESOURCES, false)
    expect((await store.read()).overrides[loser]).toEqual(UNLIMITED_INSTANCE_RESOURCES)
    await store.saveMember(2, loser, null)
    const reopened = await new PostgresInstanceResources(database).read()
    expect(reopened.revision).toBe(3)
    expect(reopened.overrides[loser]).toBeUndefined()
    expect(reopened.overrides[winner]).toEqual(state.overrides[winner])
    expect(reopened.residents).toEqual({ [winner]: true })
  } finally {
    await cleanupOwned(
      () => database.close(),
      () => rm(root, { recursive: true, force: true }),
    )
  }
})

it('rolls back the shared revision, override and residency together when COMMIT is rejected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'resource-commit-'))
  const database = await openTestDatabase(root)
  const store = new PostgresInstanceResources(database)
  try {
    const accounts = new PostgresCommunityAccountStore(database)
    const member = await accounts.create({ username: 'member', password: 'fixture-password', email: '' })
    await store.initialize(UNLIMITED_INSTANCE_RESOURCES, 1800)
    await database.query(`CREATE TABLE dsh_phalanx.resource_reject_parent(id integer PRIMARY KEY);
      CREATE TABLE dsh_phalanx.resource_reject_child(id integer REFERENCES dsh_phalanx.resource_reject_parent DEFERRABLE INITIALLY DEFERRED);
      CREATE FUNCTION dsh_phalanx.reject_resident() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN INSERT INTO dsh_phalanx.resource_reject_child VALUES(1); RETURN NULL; END $$;
      CREATE TRIGGER reject_resident AFTER INSERT ON dsh_phalanx.resident_instances FOR EACH ROW EXECUTE FUNCTION dsh_phalanx.reject_resident();`)
    await expect(store.saveMember(0, member.spaceId, { cpus: 1, memoryMiB: 1024, pids: 128 }, true)).rejects.toMatchObject({ sqlState: '23503' })
    expect(await store.read()).toEqual({ revision: 0, defaults: UNLIMITED_INSTANCE_RESOURCES, idleSeconds: 1800, overrides: {}, residents: {} })
    await expect(store.saveDefaults(0, { cpus: 0, memoryMiB: 1024, pids: 128 }, 0)).rejects.toMatchObject({ code: 'instance-resource-invalid' })
    await expect(store.saveDefaults(0, UNLIMITED_INSTANCE_RESOURCES, -1)).rejects.toMatchObject({ code: 'instance-idle-invalid' })
    expect((await store.read()).revision).toBe(0)
  } finally {
    await cleanupOwned(
      () => database.close(),
      () => rm(root, { recursive: true, force: true }),
    )
  }
})

it('invalidates an old global form when any account is deleted and starts a recreated space without old settings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'resource-cascade-'))
  const database = await openTestDatabase(root)
  const accounts = new PostgresCommunityAccountStore(database)
  const store = new PostgresInstanceResources(database)
  try {
    await store.initialize(UNLIMITED_INSTANCE_RESOURCES, 1800)
    await accounts.create({ username: 'plain', password: 'fixture-password', email: '' })
    await accounts.delete('plain')
    await expect(store.saveDefaults(0, { cpus: 1, memoryMiB: 1024, pids: 128 }, 60)).rejects.toMatchObject({
      code: 'instance-resource-revision-conflict',
    })
    expect(await store.read()).toMatchObject({ revision: 1, defaults: UNLIMITED_INSTANCE_RESOURCES, idleSeconds: 1800 })
    const member = await accounts.create({ username: 'member', password: 'fixture-password', email: '' })
    await store.saveMember(1, member.spaceId, { cpus: 2, memoryMiB: 2048, pids: 256 }, true)
    await accounts.delete('member')
    const replacement = await accounts.create({ username: 'member', password: 'replacement-password', email: '' })
    expect(replacement.spaceId).not.toBe(member.spaceId)
    expect(await store.read()).toEqual({ revision: 3, defaults: UNLIMITED_INSTANCE_RESOURCES, idleSeconds: 1800, overrides: {}, residents: {} })
    await expect(store.saveMember(3, member.spaceId, UNLIMITED_INSTANCE_RESOURCES, true)).rejects.toMatchObject({
      code: 'instance-resource-revision-conflict',
    })
    expect((await store.read()).revision).toBe(3)
  } finally {
    await cleanupOwned(
      () => database.close(),
      () => rm(root, { recursive: true, force: true }),
    )
  }
})
