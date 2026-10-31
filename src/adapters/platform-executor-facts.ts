import { lstatSync } from 'node:fs'
import type { Pool, PoolClient } from 'pg'
import { FilePlatformDatabaseConfig } from './platform-database-config.js'
import { FilePlatformSecrets } from './platform-secrets.js'
import { platformDatabasePool } from './platform-database-inspection.js'
import { readRegisteredSchemaVersions } from './platform-schema-versions.js'
import { readSavedDownloadSources } from './postgres-download-sources.js'

/** Opaque filesystem fence; connection and key interpretation remain with the source owners. */
function fileIdentity(path: string) {
  const info = lstatSync(path, { bigint: true })
  if (!info.isFile()) throw Error('Executor facts require an independent protected file')
  return { path, device: String(info.dev), inode: String(info.ino), size: String(info.size), modified: String(info.mtimeNs), changed: String(info.ctimeNs) }
}
const rows = (sql: Pool | PoolClient) => ({
  query: async <Row extends Record<string, unknown>>(text: string, values?: readonly unknown[]) =>
    (await sql.query<Row>(text, values === undefined ? undefined : [...values])).rows,
})

async function checkFacts(sql: Pool, schemas: readonly string[]) {
  let selection: Awaited<ReturnType<typeof readSavedDownloadSources>>,
    versions: Awaited<ReturnType<typeof readRegisteredSchemaVersions>> | null = null,
    client: PoolClient | undefined
  try {
    client = await sql.connect()
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await client.query('SET LOCAL statement_timeout=10000')
    await client.query('SAVEPOINT download_sources')
    try {
      selection = await readSavedDownloadSources(rows(client))
    } catch {
      await client.query('ROLLBACK TO SAVEPOINT download_sources')
    }
    await client.query('SAVEPOINT schema_versions')
    try {
      versions = await readRegisteredSchemaVersions(
        client,
        schemas.map(name => ({ name, migrations: [] })),
      )
    } catch {
      await client.query('ROLLBACK TO SAVEPOINT schema_versions')
    }
    await client.query('COMMIT')
  } catch {
    versions = null
    try {
      await client?.query('ROLLBACK')
    } catch {
      /* The connection may already have closed. */
    }
  } finally {
    client?.release()
  }
  return { selection: selection?.selection ?? null, schemas: versions }
}

/** Read selected source facts without preparing stores, migrations or a platform runtime. */
export async function readExecutorFacts(configFile: string, dataRoot: string, fact: 'schemas' | 'download-sources' | 'check', schemas: readonly string[]) {
  const before = fileIdentity(configFile),
    selected = FilePlatformDatabaseConfig.open(configFile, dataRoot),
    key = fileIdentity(selected.security.masterKeyPath),
    verifiedKey = FilePlatformSecrets.open(selected.security.masterKeyPath, selected.security.registry)
  verifiedKey.close()
  const sql = platformDatabasePool(selected.connection)
  try {
    if (fact === 'check') {
      const result = await checkFacts(sql, schemas)
      if (JSON.stringify(before) !== JSON.stringify(fileIdentity(configFile)) || JSON.stringify(key) !== JSON.stringify(fileIdentity(key.path)))
        throw Error('The selected connection or key changed during the request')
      return { ...result, identity: [before, key] }
    }
    await sql.query('SET statement_timeout=10000')
    if (fact === 'schemas')
      return {
        schemas: await readRegisteredSchemaVersions(
          sql,
          schemas.map(name => ({ name, migrations: [] })),
        ),
      }
    const row = await readSavedDownloadSources(rows(sql))
    return { selection: row?.selection ?? null }
  } finally {
    await sql.end()
  }
}
