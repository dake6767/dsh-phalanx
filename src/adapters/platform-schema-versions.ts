import type { Pool, PoolClient } from 'pg'
import { PLATFORM_SCHEMAS, schemaIdentifier, type PlatformSchema } from './platform-schema-registry.js'

/** A missing namespace or version table is version zero; reading never prepares it. */
export async function readRegisteredSchemaVersions(sql: Pool | PoolClient, schemas: readonly PlatformSchema[] = PLATFORM_SCHEMAS) {
  const versions: { name: string; version: number }[] = []
  for (const schema of schemas) {
    const table = `${schemaIdentifier(schema.name)}.schema_migrations`
    const present = (await sql.query<{ relation: string | null }>('SELECT to_regclass($1)::text AS relation', [table])).rows[0]!.relation
    const version = present ? Number((await sql.query<{ version: number }>(`SELECT COALESCE(max(version),0) AS version FROM ${table}`)).rows[0]!.version) : 0
    versions.push({ name: schema.name, version })
  }
  return versions
}
