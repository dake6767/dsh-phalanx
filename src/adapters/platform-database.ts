import type { Pool, PoolClient, QueryResultRow } from 'pg'
import { PlatformDatabaseError, type PlatformDatabaseConnection } from '../domain/platform-database.js'
import type { PlatformSecretRegistry } from '../domain/platform-secret.js'
import { AdvisoryLock, transactionLock } from './advisory-locks.js'
import { inspectPlatformDatabaseSession, platformDatabasePool } from './platform-database-inspection.js'
import { PLATFORM_MIGRATIONS, PLATFORM_SCHEMA_VERSION, platformCoreSchemaFor } from './platform-schema.js'
import type { PlatformSecretCipher } from './platform-secret-codec.js'
import { FilePlatformSecrets } from './platform-secrets.js'

export interface PlatformSql {
  query<Row extends QueryResultRow = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<Row[]>
}

/** The single PostgreSQL I/O owner, including schema and transaction lifetimes. */
export class PlatformDatabase implements PlatformSql {
  private pool: Pool
  private initialization: Promise<void> | undefined
  private closing: Promise<void> | undefined
  private deployment: { id: string; client: PoolClient; lost: () => void } | undefined
  private ownershipLost = false
  private readonly clients = new Set<PoolClient>()
  private readonly clientError = () => {}
  private readonly committedTableWrites = new Map<string, number>()
  private readonly writeSubscribers = new Set<{ tables: ReadonlySet<string>; publish: () => Promise<void> }>()
  /** Conservative relation-scoped invalidation, published only after successful commit. */
  writeRevision(tables: readonly string[]): string {
    return JSON.stringify([this.committedTableWrites.get('*') ?? 0, ...tables.map(table => this.committedTableWrites.get(table) ?? 0)])
  }
  /** The callback synchronously invalidates its view, then asynchronously publishes committed facts.
   * Writers release their connection before awaiting publication. A failed publication cannot undo COMMIT. */
  subscribeCommittedWrites(tables: readonly string[], publish: () => Promise<void>): () => void {
    if (this.closing) throw Error('A closed platform database cannot register a view')
    const subscriber = { tables: new Set(tables), publish }
    this.writeSubscribers.add(subscriber)
    return () => {
      this.writeSubscribers.delete(subscriber)
    }
  }
  private recordWrites(tables: Iterable<string>): Promise<void>[] {
    const written = [...tables]
    for (const table of written) this.committedTableWrites.set(table, (this.committedTableWrites.get(table) ?? 0) + 1)
    const publications: Promise<void>[] = []
    for (const subscriber of this.writeSubscribers) {
      if (!written.some(table => table === '*' || subscriber.tables.has(table))) continue
      try {
        publications.push(subscriber.publish())
      } catch (error) {
        publications.push(Promise.reject(error))
      }
    }
    return publications
  }
  private async completePublications(publications: readonly Promise<void>[], failure: { cause: unknown } | undefined): Promise<void> {
    const results = await Promise.allSettled(publications)
    if (failure) throw failure.cause
    const refused = results.find(result => result.status === 'rejected')
    if (refused?.status === 'rejected') throw refused.reason
    this.assertReady()
  }
  private ready = false
  private secrets: FilePlatformSecrets | undefined
  constructor(
    private connection: PlatformDatabaseConnection,
    private readonly security: { readonly masterKeyPath: string; readonly registry: PlatformSecretRegistry },
  ) {
    this.pool = platformDatabasePool(connection)
  }
  /** Binding is permitted only before any owner initializes or the production session is acquired. */
  async bindBeforeInitialization(connection: PlatformDatabaseConnection): Promise<void> {
    if (this.initialization || this.deployment || this.closing) throw Error('An active platform database cannot be rebound')
    await this.pool.end()
    this.connection = structuredClone(connection)
    this.pool = platformDatabasePool(this.connection)
  }
  /** A production-only session lock; temporary operator/owner connections remain available. */
  async claimDeployment(id: string, onLost: () => void): Promise<void> {
    if (!id || this.initialization || this.deployment || this.closing || this.ownershipLost)
      throw Error('Deployment ownership must be acquired before initialization')
    const client = await this.connect()
    try {
      const row = (await client.query<{ acquired: boolean }>('SELECT pg_try_advisory_lock($1::bigint) AS acquired', [AdvisoryLock.deployment])).rows[0]!
      if (!row.acquired)
        throw new PlatformDatabaseError(
          'deployment-in-use',
          'Another platform instance is already using this database; stop it before starting this deployment',
        )
    } catch (error) {
      this.release(client, true)
      throw error
    }
    const lost = () => {
      if (this.deployment?.client !== client) return
      this.ownershipLost = true
      this.ready = false
      this.releaseDeployment()
      for (const active of [...this.clients]) this.release(active, true)
      onLost()
    }
    this.deployment = { id, client, lost }
    client.once('error', lost)
    client.once('end', lost)
  }
  private releaseDeployment(): void {
    const owner = this.deployment
    if (!owner) return
    this.deployment = undefined
    owner.client.removeListener('error', owner.lost)
    owner.client.removeListener('end', owner.lost)
    this.release(owner.client, true)
  }
  initialize(): Promise<void> {
    return (this.initialization ??= this.prepare().catch(error => {
      this.releaseDeployment()
      throw error
    }))
  }
  /** The opened platform key owner; available once initialization verified the master key and registry. */
  cipher(): PlatformSecretCipher {
    this.assertReady()
    const secrets = this.secrets!
    return {
      encrypt: (context, value) => (this.assertReady(), secrets.encrypt(context, value)),
      decrypt: (context, envelope) => (this.assertReady(), secrets.decrypt(context, envelope)),
    }
  }
  async query<Row extends QueryResultRow = Record<string, unknown>>(text: string, values: readonly unknown[] = []): Promise<Row[]> {
    this.assertReady()
    const client = await this.connect()
    let rows: Row[] = [],
      failure: { cause: unknown } | undefined
    let publications: Promise<void>[] = []
    try {
      this.assertReady()
      const response = await client.query<Row>(text, [...values])
      const table = writtenTable(text, response.command)
      if (table && response.rowCount !== 0) publications = this.recordWrites([table])
      rows = response.rows
      this.assertReady()
    } catch (error) {
      failure = { cause: queryError(error) }
    } finally {
      this.release(client)
    }
    await this.completePublications(publications, failure)
    return rows
  }
  async transaction<T>(operation: (sql: PlatformSql) => Promise<T>, onCommitted?: (value: T) => void): Promise<T> {
    this.assertReady()
    const client = await this.connect()
    let value!: T,
      failure: { cause: unknown } | undefined,
      committed = false
    let publications: Promise<void>[] = []
    try {
      this.assertReady()
      const written = new Set<string>()
      await client.query('BEGIN').catch(error => {
        throw queryError(error)
      })
      value = await operation({
        query: async <Row extends QueryResultRow>(text: string, values: readonly unknown[] = []) => {
          this.assertReady()
          try {
            const response = await client.query<Row>(text, [...values])
            const table = writtenTable(text, response.command)
            if (table && response.rowCount !== 0) written.add(table)
            const rows = response.rows
            this.assertReady()
            return rows
          } catch (error) {
            throw queryError(error)
          }
        },
      })
      this.assertReady()
      await client.query('COMMIT').catch(error => {
        throw queryError(error)
      })
      committed = true
      publications = this.recordWrites(written)
      this.assertReady()
    } catch (error) {
      if (!committed) await client.query('ROLLBACK').catch(() => {})
      failure = { cause: error }
    } finally {
      this.release(client)
    }
    if (committed && onCommitted) {
      try {
        onCommitted(value)
      } catch (error) {
        failure ??= { cause: error }
      }
    }
    await this.completePublications(publications, failure)
    return value
  }
  address(): string {
    return `${this.connection.host}:${this.connection.port}/${this.connection.database}`
  }
  async health() {
    try {
      const [row] = await this.query<{ version: string; schema: number }>(
        "SELECT current_setting('server_version') AS version, COALESCE((SELECT max(version) FROM dsh_phalanx.schema_migrations),0) AS schema",
      )
      return { state: 'connected' as const, serverVersion: row!.version, schemaVersion: row!.schema, address: this.address() }
    } catch {
      return { state: 'unavailable' as const, message: 'Platform database connection is unavailable; check the database service and connection settings' }
    }
  }
  close(): Promise<void> {
    this.ready = false
    this.writeSubscribers.clear()
    this.releaseDeployment()
    return (this.closing ??= this.pool.end().finally(() => this.secrets?.close()))
  }
  private assertReady(): void {
    if (!this.ready || this.closing || this.ownershipLost) throw new PlatformDatabaseError('unavailable', 'Platform database is not ready')
  }
  private async connect(): Promise<PoolClient> {
    try {
      const client = await this.pool.connect()
      if (this.ownershipLost || this.closing) {
        client.release(true)
        throw Error('Database ownership is unavailable')
      }
      this.clients.add(client)
      client.on('error', this.clientError)
      return client
    } catch {
      throw new PlatformDatabaseError('unavailable', 'Platform database connection is unavailable; check the database service and connection settings')
    }
  }
  private release(client: PoolClient, destroy = false): void {
    if (!this.clients.delete(client)) return
    client.removeListener('error', this.clientError)
    client.release(destroy)
  }
  private assertOwnership(): void {
    if (this.ownershipLost || this.closing) throw new PlatformDatabaseError('unavailable', 'Platform database ownership was lost; restart the platform')
  }
  private async prepare(): Promise<void> {
    const client = await this.connect()
    let secrets: FilePlatformSecrets | undefined
    try {
      await client.query('BEGIN')
      await client.query(transactionLock(AdvisoryLock.migration))
      const checked = await inspectPlatformDatabaseSession(client, this.security.registry.masterFingerprint, this.deployment?.id)
      if (!checked.ok) {
        if (checked.code === 'unavailable') throw new PlatformDatabaseError('unavailable', 'Platform database connection checks could not complete')
        if (checked.code === 'master-key-mismatch')
          throw new PlatformDatabaseError('schema-incompatible', 'Platform master-key fingerprint does not match; restore the matching master-key file')
        if (checked.code === 'deployment-mismatch')
          throw new PlatformDatabaseError(
            'deployment-mismatch',
            'This database belongs to another platform deployment; use its matching deployment configuration',
          )
        const stage = checked.checks.at(-1)?.stage
        throw new PlatformDatabaseError(
          'schema-incompatible',
          stage === 'version'
            ? 'PostgreSQL 14 or newer is required'
            : stage === 'owner'
              ? 'The platform database account must own dsh_phalanx or be able to create it'
              : 'The dsh_phalanx schema contains unrelated objects; use an empty platform schema',
        )
      }
      const existing = await client.query<{ version_table: string | null; namespace_present: boolean }>(
        "SELECT to_regclass('dsh_phalanx.schema_migrations')::text AS version_table,to_regnamespace('dsh_phalanx') IS NOT NULL AS namespace_present",
      )
      if (!existing.rows[0]!.version_table) {
        const tables = await client.query(
          "SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='dsh_phalanx' AND c.relkind IN ('r','p','v','m','f','S') LIMIT 1",
        )
        if (tables.rows.length)
          throw new PlatformDatabaseError('schema-incompatible', 'The dsh_phalanx schema contains unrelated objects; use an empty platform schema')
      }
      await client.query(platformCoreSchemaFor(!existing.rows[0]!.namespace_present))
      const version = Number(
        (await client.query<{ version: number }>('SELECT COALESCE(max(version),0) AS version FROM dsh_phalanx.schema_migrations')).rows[0]!.version,
      )
      if (version > PLATFORM_SCHEMA_VERSION)
        throw new PlatformDatabaseError('schema-incompatible', 'Unsupported platform database schema version; start the matching platform version')
      await client.query('INSERT INTO dsh_phalanx.platform_security(id,registry) VALUES(1,$1) ON CONFLICT(id) DO NOTHING', [
        JSON.stringify(this.security.registry),
      ])
      const registry = (await client.query<{ registry: PlatformSecretRegistry }>('SELECT registry FROM dsh_phalanx.platform_security WHERE id=1')).rows[0]!
        .registry
      secrets = FilePlatformSecrets.open(this.security.masterKeyPath, registry)
      for (const migration of PLATFORM_MIGRATIONS) {
        if (migration.version <= version) continue
        if (migration.sql) await client.query(migration.sql)
        await client.query('INSERT INTO dsh_phalanx.schema_migrations(version) VALUES($1) ON CONFLICT(version) DO NOTHING', [migration.version])
      }
      // Version 1 has no DDL of its own; a database first prepared by version 1 code still records it.
      await client.query('INSERT INTO dsh_phalanx.schema_migrations(version) VALUES(1) ON CONFLICT(version) DO NOTHING')
      if (this.deployment) {
        await client.query('INSERT INTO dsh_phalanx.platform_deployment(id,deployment_id) VALUES(1,$1) ON CONFLICT(id) DO NOTHING', [this.deployment.id])
        const deployment = (await client.query<{ deployment_id: string }>('SELECT deployment_id FROM dsh_phalanx.platform_deployment WHERE id=1 FOR UPDATE'))
          .rows[0]!
        if (deployment.deployment_id !== this.deployment.id)
          throw new PlatformDatabaseError(
            'deployment-mismatch',
            'This database belongs to another platform deployment; use its matching deployment configuration',
          )
      }
      this.assertOwnership()
      await client.query('COMMIT')
      this.assertOwnership()
      this.secrets = secrets
      this.ready = true
    } catch (error) {
      secrets?.close()
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      this.release(client)
    }
  }
}

function queryError(error: unknown): PlatformDatabaseError {
  const code = error instanceof Error && 'code' in error && typeof error.code === 'string' && /^[A-Z0-9]{5}$/u.test(error.code) ? error.code : undefined
  return new PlatformDatabaseError(
    code?.startsWith('08') || code === undefined ? 'unavailable' : 'query-failed',
    'Platform database operation failed; check its connection and schema',
    code,
  )
}

/** Owned simple statements name their target; unfamiliar writes invalidate every registered scope. */
function writtenTable(statement: string, command?: string): string | undefined {
  if (!/^(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|CREATE|DROP)\b/iu.test(command ?? statement.trimStart())) return undefined
  const sql = statement.trim().replace(/;$/u, '')
  if (sql.includes(';')) return '*'
  const target =
    /^(?:INSERT\s+INTO|UPDATE(?:\s+ONLY)?|DELETE\s+FROM(?:\s+ONLY)?|TRUNCATE(?:\s+TABLE)?|(?:ALTER|CREATE|DROP)\s+TABLE(?:\s+IF\s+(?:NOT\s+)?EXISTS)?)\s+((?:"?[a-z_][\w$]*"?\.)?"?[a-z_][\w$]*"?)/iu.exec(
      sql,
    )?.[1]
  return target?.replaceAll('"', '').toLowerCase() ?? '*'
}
