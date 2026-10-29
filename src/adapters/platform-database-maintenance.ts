import { PLATFORM_SCHEMA_VERSION } from './platform-schema.js'
import { randomBytes } from 'node:crypto'
import type { Pool, PoolClient, QueryResultRow } from 'pg'
import { PlatformDatabaseError, type PlatformDatabaseConnection } from '../domain/platform-database.js'
import type { PlatformSql } from './platform-database.js'
import { inspectPlatformDatabaseSession, platformDatabasePool } from './platform-database-inspection.js'
import { AdvisoryLock } from './advisory-locks.js'

/** An offline operator holds both production and migration sessions until it finishes. */
export class PlatformDatabaseMaintenance implements PlatformSql {
  private lost = false
  private closed = false
  private constructor(
    private readonly pool: Pool,
    private readonly client: PoolClient,
    readonly schema: 'empty' | 'platform',
  ) {
    client.once('error', () => {
      this.lost = true
    })
    client.once('end', () => {
      this.lost = true
    })
  }
  static async open(
    connection: PlatformDatabaseConnection,
    fingerprint: string,
    deploymentId: string,
    previousFingerprint?: string,
  ): Promise<PlatformDatabaseMaintenance> {
    const pool = platformDatabasePool(connection)
    let client: PoolClient | undefined
    try {
      client = await pool.connect()
      for (const key of [AdvisoryLock.deployment, AdvisoryLock.migration]) {
        const locked = (await client.query<{ acquired: boolean }>('SELECT pg_try_advisory_lock($1::bigint) AS acquired', [key])).rows[0]!
        if (!locked.acquired) throw new PlatformDatabaseError('deployment-in-use', 'Another platform process owns this database; stop it before maintenance')
      }
      let checked = await inspectPlatformDatabaseSession(client, fingerprint, deploymentId)
      if (!checked.ok && checked.code === 'master-key-mismatch' && previousFingerprint !== undefined)
        checked = await inspectPlatformDatabaseSession(client, previousFingerprint, deploymentId)
      if (!checked.ok)
        throw new PlatformDatabaseError(
          checked.code === 'deployment-mismatch' ? 'deployment-mismatch' : 'schema-incompatible',
          'Platform database maintenance checks failed; verify its owner, schema, deployment and master key',
        )
      if (checked.schema === 'platform') {
        const version = (await client.query<{ version: number }>('SELECT max(version) AS version FROM dsh_phalanx.schema_migrations')).rows[0]!.version
        if (version !== PLATFORM_SCHEMA_VERSION)
          throw new PlatformDatabaseError('schema-incompatible', 'Maintenance requires the current platform database schema')
        const owner = (await client.query<{ deployment_id: string }>('SELECT deployment_id FROM dsh_phalanx.platform_deployment WHERE id=1')).rows[0]
        if (owner?.deployment_id !== deploymentId)
          throw new PlatformDatabaseError('deployment-mismatch', 'The platform database has no matching deployment owner')
      }
      return new PlatformDatabaseMaintenance(pool, client, checked.schema!)
    } catch (error) {
      client?.release(true)
      await pool.end()
      if (error instanceof PlatformDatabaseError) throw error
      throw new PlatformDatabaseError('unavailable', 'Platform database maintenance connection is unavailable')
    }
  }
  /** Database-scoped session locks distinguish aliases without server-specific identifiers. */
  async isSameDatabase(connection: PlatformDatabaseConnection): Promise<boolean> {
    const random = randomBytes(8),
      keys = [random.readInt32BE(0), random.readInt32BE(4)]
    const probe = platformDatabasePool(connection)
    let client: PoolClient | undefined
    try {
      await this.query('SELECT pg_advisory_lock($1::int,$2::int)', keys)
      client = await probe.connect()
      const result = await client.query<{ acquired: boolean }>('SELECT pg_try_advisory_lock($1::int,$2::int) AS acquired', keys)
      return !result.rows[0]!.acquired
    } catch {
      throw new PlatformDatabaseError('unavailable', 'Cannot compare platform database identities')
    } finally {
      client?.release(true)
      await probe.end()
      if (!this.lost) await this.query('SELECT pg_advisory_unlock($1::int,$2::int)', keys)
    }
  }
  async query<Row extends QueryResultRow = Record<string, unknown>>(text: string, values: readonly unknown[] = []): Promise<Row[]> {
    if (this.lost) throw new PlatformDatabaseError('unavailable', 'Platform database maintenance ownership was lost')
    try {
      const rows = (await this.client.query<Row>(text, [...values])).rows
      if (this.lost) throw Error('Ownership lost')
      return rows
    } catch {
      throw new PlatformDatabaseError('query-failed', 'Platform database maintenance query failed')
    }
  }
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.lost = true
    this.client.release(true)
    await this.pool.end()
  }
}
