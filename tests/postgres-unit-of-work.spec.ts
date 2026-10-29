import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { PlatformDatabase } from '../src/adapters/platform-database.js'
import { FilePlatformSecrets } from '../src/adapters/platform-secrets.js'
import { protectedTable } from '../src/adapters/platform-secret-codec.js'
import { PostgresUnitOfWork, type PlatformTransaction } from '../src/adapters/postgres-unit-of-work.js'
import type { PlatformUnitOfWorkPort } from '../src/ports/platform-unit-of-work.js'
import { AdvisoryLock, EXECUTION_CONFIGURATION_LOCK_SQL } from '../src/adapters/advisory-locks.js'
import { postgresConnection } from './support/postgres.js'

// Two fixture repositories over their own tables, standing in for two domains.
const notes = (transaction: PlatformTransaction) => ({
  add: async (id: string, body: string) => void (await transaction.sql.query('INSERT INTO uow_notes(id,body) VALUES($1,$2)', [id, body])),
})
const secretTable = protectedTable('uow_secrets')
const secrets = (transaction: PlatformTransaction) => ({
  put: async (id: string, value: string) =>
    void (await transaction.sql.query('INSERT INTO uow_secrets(id,value) VALUES($1,$2)', [
      id,
      JSON.stringify(secretTable.encrypt(transaction.cipher, id, 'value', value)),
    ])),
})
type Repositories = { notes: ReturnType<typeof notes>; secrets: ReturnType<typeof secrets> }

/** A use-case-shaped action: it only sees the port, never PostgreSQL. */
async function record(unit: PlatformUnitOfWorkPort<Repositories>, id: string, fail: boolean) {
  await unit.run(async repositories => {
    await repositories.notes.add(id, 'note ' + id)
    await repositories.secrets.put(id, 'secret ' + id)
    if (fail) throw Error('injected failure after both writes')
  })
}

async function withDatabase(test: (database: PlatformDatabase) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'unit-of-work-')),
    masterKeyPath = join(root, 'master.key')
  const created = FilePlatformSecrets.create(masterKeyPath),
    registry = created.registry()
  created.close()
  const database = new PlatformDatabase(postgresConnection(), { masterKeyPath, registry })
  try {
    await database.initialize()
    await database.query('CREATE TABLE uow_notes(id text PRIMARY KEY, body text NOT NULL); CREATE TABLE uow_secrets(id text PRIMARY KEY, value jsonb NOT NULL)')
    await test(database)
  } finally {
    await database.close()
    rmSync(root, { recursive: true, force: true })
  }
}

const counts = async (database: PlatformDatabase) =>
  (
    await database.query<{ notes: string; secrets: string }>('SELECT (SELECT count(*) FROM uow_notes) AS notes,(SELECT count(*) FROM uow_secrets) AS secrets')
  )[0]

it('leaves both repositories unchanged when the unit fails after writing to each', async () => {
  await withDatabase(async database => {
    const unit = new PostgresUnitOfWork<Repositories>(database, { notes, secrets })
    await expect(record(unit, 'a', true)).rejects.toThrow('injected failure after both writes')
    expect(await counts(database)).toEqual({ notes: '0', secrets: '0' })
  })
})

it('makes both repositories visible together once the unit commits, with the value encrypted at its position', async () => {
  await withDatabase(async database => {
    const unit = new PostgresUnitOfWork<Repositories>(database, { notes, secrets })
    await record(unit, 'b', false)
    expect(await counts(database)).toEqual({ notes: '1', secrets: '1' })
    const [row] = await database.query<{ value: { key_id: string; nonce: string; ciphertext: string } }>('SELECT value FROM uow_secrets WHERE id=$1', ['b'])
    expect(JSON.stringify(row)).not.toContain('secret b')
    expect(secretTable.decrypt(database.cipher(), 'b', 'value', row!.value)).toBe('secret b')
  })
})

it('isolates an open unit from other connections until it commits', async () => {
  await withDatabase(async database => {
    const unit = new PostgresUnitOfWork<Repositories>(database, { notes, secrets })
    let observed: unknown
    await unit.run(async repositories => {
      await repositories.notes.add('c', 'note c')
      observed = await counts(database)
    })
    expect(observed).toEqual({ notes: '0', secrets: '0' })
    expect(await counts(database)).toEqual({ notes: '1', secrets: '0' })
  })
})

it('derives the execution-configuration lock outside every named advisory key', async () => {
  await withDatabase(async database => {
    const [row] = await database.query<{ key: number }>(`SELECT ${EXECUTION_CONFIGURATION_LOCK_SQL} AS key`)
    expect(Object.values(AdvisoryLock)).not.toContain(Number(row!.key))
  })
})

it('runs synchronous lifecycle cleanup only after COMMIT, including when subsequent publication fails', async () => {
  await withDatabase(async database => {
    const unit = new PostgresUnitOfWork<Repositories>(database, { notes, secrets })
    const committed: string[] = []
    const unsubscribe = database.subscribeCommittedWrites(['uow_notes'], async () => {
      throw Error('publication unavailable')
    })
    try {
      await expect(
        unit.run(
          async rows => {
            await rows.notes.add('rollback', 'not committed')
            throw Error('rollback before COMMIT')
          },
          () => {
            committed.push('rollback')
          },
        ),
      ).rejects.toThrow('rollback before COMMIT')
      expect(committed).toEqual([])
      await expect(
        unit.run(
          async rows => {
            await rows.notes.add('durable', 'already committed')
            return 'durable'
          },
          value => {
            committed.push(value)
          },
        ),
      ).rejects.toThrow('publication unavailable')
      expect(committed).toEqual(['durable'])
      expect(await counts(database)).toEqual({ notes: '1', secrets: '0' })
    } finally {
      unsubscribe()
    }
  })
})
