import type { PoolClient } from 'pg'
import { PlatformDatabaseError, PlatformMigrationError } from '../domain/platform-database.js'
import { schemaIdentifier, type PlatformSchema } from './platform-schema-registry.js'

/** The caller holds the common migration lock and transaction for the entire registry. */
export async function migrateRegisteredSchema(client: PoolClient, schema: PlatformSchema, coreVersion?: number): Promise<void> {
  const identifier = schemaIdentifier(schema.name),
    table = `${identifier}.schema_migrations`
  let version = coreVersion
  if (version === undefined) {
    const namespace = (
      await client.query<{ present: boolean; owned: boolean | null; creatable: boolean }>(
        `SELECT n.oid IS NOT NULL AS present,n.nspowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS owned,
      has_database_privilege(current_user,current_database(),'CREATE') AS creatable
      FROM (SELECT 1) probe LEFT JOIN pg_namespace n ON n.nspname=$1`,
        [schema.name],
      )
    ).rows[0]!
    if (namespace.present && !namespace.owned)
      throw new PlatformDatabaseError('schema-incompatible', `The platform database account must own registered schema ${schema.name}`)
    if (!namespace.present) {
      if (!namespace.creatable)
        throw new PlatformDatabaseError('schema-incompatible', `The platform database account cannot create registered schema ${schema.name}`)
      await client.query(`CREATE SCHEMA ${identifier}`)
    }
    const present = (await client.query<{ relation: string | null }>('SELECT to_regclass($1)::text AS relation', [table])).rows[0]!.relation
    if (!present) {
      const objects = await client.query('SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 LIMIT 1', [schema.name])
      if (objects.rows.length) throw new PlatformDatabaseError('schema-incompatible', `Registered schema ${schema.name} contains unrelated objects`)
      await client.query(`CREATE TABLE ${table}(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`)
    }
    version = Number((await client.query<{ version: number }>(`SELECT COALESCE(max(version),0) AS version FROM ${table}`)).rows[0]!.version)
  }
  if (version > schema.migrations.at(-1)!.version)
    throw new PlatformDatabaseError('schema-incompatible', `Unsupported registered schema version for ${schema.name}; start the matching platform version`)
  for (const migration of schema.migrations) {
    if (migration.version <= version) continue
    try {
      if (migration.sql) await client.query(migration.sql)
      await client.query(`INSERT INTO ${table}(version) VALUES($1) ON CONFLICT(version) DO NOTHING`, [migration.version])
    } catch (error) {
      if (
        error instanceof Error &&
        'severity' in error &&
        typeof error.severity === 'string' &&
        'code' in error &&
        typeof error.code === 'string' &&
        /^[A-Z0-9]{5}$/u.test(error.code)
      ) {
        if (error.code.startsWith('08') || ['57P01', '57P02', '57P03'].includes(error.code))
          throw new PlatformDatabaseError('unavailable', 'The platform database connection was interrupted during migration', error.code)
        throw new PlatformMigrationError(error.code, error)
      }
      throw error
    }
  }
}
