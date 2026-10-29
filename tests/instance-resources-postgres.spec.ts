import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { PostgresCommunityAccountStore } from '../src/adapters/postgres-community-accounts.js'
import { PostgresInstanceResources } from '../src/adapters/postgres-instance-resources.js'
import { PostgresSpaceActors } from '../src/adapters/postgres-space-actors.js'
import { PostgresUnitOfWork } from '../src/adapters/postgres-unit-of-work.js'
import { UNLIMITED_INSTANCE_RESOURCES } from '../src/domain/instance-resources.js'
import { InstanceResources } from '../src/use-cases/instance-resources.js'
import type { InstanceResourcePersistence } from '../src/ports/instance-resource-persistence.js'
import { cleanupOwned } from './fixtures/owned-cleanup.js'
import { openTestDatabase } from './support/community-application.js'

it('rejects a revoked administrator at the resource transaction without advancing settings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'resource-admission-'))
  const database = await openTestDatabase(root)
  const accounts = new PostgresCommunityAccountStore(database)
  const rows = new PostgresInstanceResources(database)
  let release!: () => void, reached!: () => void
  const paused = new Promise<void>(resolve => {
    release = resolve
  })
  const entered = new Promise<void>(resolve => {
    reached = resolve
  })
  const work = new PostgresUnitOfWork(database, {
    actors: tx => new PostgresSpaceActors(tx),
    settings: tx => new PostgresInstanceResources(tx),
  })
  const persistence: InstanceResourcePersistence = {
    rows,
    work: {
      run: async operation => {
        reached()
        await paused
        return work.run(operation)
      },
    },
  }
  try {
    await rows.initialize(UNLIMITED_INSTANCE_RESOURCES, 1800)
    const admin = await accounts.createFirstAdmin({ username: 'admin', password: 'fixture-password', email: '' })
    const service = new InstanceResources(
      accounts,
      persistence,
      { read: () => ({ memoryBytes: 4096 * 1024 ** 2, cpuCount: 4 }) },
      { status: () => ({ state: 'stopped' }) },
      { closeUser: async () => {} },
      true,
    )
    const saving = service.saveDefaults(admin, { revision: 0, limits: { cpus: 1, memoryMiB: 1024, pids: 128 }, idleSeconds: 0 })
    const rejected = expect(saving).rejects.toMatchObject({ code: 'sign-in-required' })
    await entered
    await accounts.resetPassword('admin', 'replacement-password')
    release()
    await rejected
    expect(await rows.read()).toEqual({ revision: 0, defaults: UNLIMITED_INSTANCE_RESOURCES, idleSeconds: 1800, overrides: {}, residents: {} })
    await service.stop()
  } finally {
    release()
    await cleanupOwned(
      () => database.close(),
      () => rm(root, { recursive: true, force: true }),
    )
  }
})
