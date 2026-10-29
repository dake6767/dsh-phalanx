import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { runtimeDependencyInput } from '../src/domain/runtime-dependency.js'
import { PostgresRuntimeDependencyStore } from '../src/adapters/postgres-runtime-dependencies.js'
import { openTestDatabase } from './support/community-application.js'

it('persists dependency definitions independently of caller mutations and removes them durably without a JSON library', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dependency-store-'))
  let database = await openTestDatabase(root)
  try {
    let store = new PostgresRuntimeDependencyStore(database)
    const row = {
      name: 'example',
      prepareCommand: 'install-pinned',
      pathDirectories: ['bin'],
      source: 'manual' as const,
      stage: 'preparing' as const,
      log: 'full log',
      checks: [],
      updatedAt: 1,
    }
    await store.save(row)
    row.pathDirectories.push('changed')
    await database.close()
    database = await openTestDatabase(root)
    store = new PostgresRuntimeDependencyStore(database)
    expect((await store.list())[0]?.pathDirectories).toEqual(['bin'])
    await expect(stat(join(root, 'runtime-dependencies', 'library.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    await store.remove('example')
    await database.close()
    database = await openTestDatabase(root)
    expect(await new PostgresRuntimeDependencyStore(database).list()).toEqual([])
  } finally {
    try {
      await database.close()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})

it('retains Python definitions and rejects an invalid stored package lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'python-store-'))
  const database = await openTestDatabase(root)
  try {
    const store = new PostgresRuntimeDependencyStore(database)
    const definition = runtimeDependencyInput({ name: 'python-library', type: 'python-library', packages: ['six==1.17.0'] })
    const row = { ...definition, source: 'manual' as const, stage: 'preparing' as const, updatedAt: 1, log: '', checks: [] }
    await store.save(row)
    expect((await new PostgresRuntimeDependencyStore(database).list())[0]).toMatchObject({ type: 'python-library', packages: ['six==1.17.0'] })
    await expect(store.save({ ...row, type: 'python-library', packages: ['six>=1.0'] })).rejects.toThrow()
    await database.query(`UPDATE dsh_phalanx.runtime_dependencies SET definition=jsonb_set(definition,'{packages}',$1::jsonb) WHERE name=$2`, [
      JSON.stringify(['six>=1.0']),
      row.name,
    ])
    await expect(store.list()).rejects.toThrow()
  } finally {
    try {
      await database.close()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})

it('preserves a resource category and its empty PATH', async () => {
  const root = await mkdtemp(join(tmpdir(), 'resource-store-'))
  const database = await openTestDatabase(root)
  try {
    const definition = runtimeDependencyInput({ name: 'office-sdk', type: 'resource', prepareCommand: 'mkdir sdk; printf READY > sdk/data' })
    await new PostgresRuntimeDependencyStore(database).save({ ...definition, source: 'manual', stage: 'preparing', updatedAt: 1, log: '', checks: [] })
    expect((await new PostgresRuntimeDependencyStore(database).list())[0]).toMatchObject({ type: 'resource', pathDirectories: [] })
  } finally {
    try {
      await database.close()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})
