import { PLATFORM_RELATIONS, PLATFORM_ROUTINES } from './platform-schema.js'
import { Pool, type PoolClient } from 'pg'
import { PlatformDatabaseError } from '../domain/platform-database.js'
import type { DatabaseCheckStage, DatabaseInspection, PlatformDatabaseConnection } from '../domain/platform-database.js'

/** Connection settings have one TLS mapping for startup and read-only onboarding probes. */
export function platformDatabasePool(connection: PlatformDatabaseConnection): Pool {
  const ssl =
    connection.tls === 'disable'
      ? false
      : { rejectUnauthorized: connection.tls === 'verify-full', ...(connection.ca === undefined ? {} : { ca: connection.ca }) }
  const pool = new Pool({
    host: connection.host,
    port: connection.port,
    database: connection.database,
    user: connection.username,
    password: connection.password,
    ssl,
    max: 5,
    connectionTimeoutMillis: 5000,
  })
  pool.on('error', () => {
    console.warn('Platform database connection was interrupted')
  })
  return pool
}

/** A connection test never initializes schema, secrets, accounts or other business records. */
export async function inspectPlatformDatabase(
  connection: PlatformDatabaseConnection,
  masterFingerprint: string,
  deploymentId?: string,
): Promise<DatabaseInspection> {
  const pool = platformDatabasePool(connection)
  let client: PoolClient | undefined
  try {
    client = await pool.connect()
    await client.query('SET statement_timeout=10000')
    return await inspectPlatformDatabaseSession(client, masterFingerprint, deploymentId)
  } catch {
    return { ok: false, code: 'unavailable', checks: [{ stage: 'connection', passed: false }] }
  } finally {
    client?.release()
    await pool.end()
  }
}

/** Initialization repeats these checks inside its own migration transaction and lock. */
export async function inspectPlatformDatabaseSession(client: PoolClient, masterFingerprint: string, deploymentId?: string): Promise<DatabaseInspection> {
  let stage: DatabaseCheckStage = 'connection'
  const checks: { stage: DatabaseCheckStage; passed: boolean }[] = []
  try {
    checks.push({ stage, passed: true })
    stage = 'version'
    const version = (
      await client.query<{ number: string; version: string }>(
        "SELECT current_setting('server_version_num') AS number,current_setting('server_version') AS version",
      )
    ).rows[0]!
    if (Number(version.number) < 140000) return { ok: false, checks: [...checks, { stage, passed: false }] }
    checks.push({ stage, passed: true })
    stage = 'owner'
    const schema = (
      await client.query<{ owned: boolean; creatable: boolean }>(`SELECT n.nspowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS owned,
      has_database_privilege(current_user,current_database(),'CREATE') AS creatable FROM (SELECT 1) AS probe LEFT JOIN pg_namespace n ON n.nspname='dsh_phalanx'`)
    ).rows[0]!
    if (!(schema.owned ?? schema.creatable)) return { ok: false, checks: [...checks, { stage, passed: false }] }
    checks.push({ stage, passed: true })
    stage = 'schema'
    const relations = await client.query<{ name: string }>(
      "SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='dsh_phalanx' AND c.relkind NOT IN ('i','I')",
    )
    const recorded = relations.rows.some(row => row.name === 'schema_migrations')
      ? Number((await client.query<{ version: number }>('SELECT COALESCE(max(version),0) AS version FROM dsh_phalanx.schema_migrations')).rows[0]!.version)
      : 0
    const routines = PLATFORM_ROUTINES.filter(row => recorded >= row.since).map(row => row.name)
    // Namespace dependencies cover independent functions, collations, operators,
    // conversions and text-search objects. Table constraints/indexes and default
    // privileges belong to their relation or schema; they are not independent data.
    const otherObjects = await client.query(
      `SELECT 1 FROM pg_depend d JOIN pg_namespace n ON n.oid=d.refobjid
      WHERE d.refclassid='pg_namespace'::regclass AND n.nspname='dsh_phalanx'
        AND d.classid NOT IN ('pg_class'::regclass,'pg_type'::regclass,'pg_constraint'::regclass,'pg_default_acl'::regclass)
        AND NOT(d.classid='pg_proc'::regclass AND EXISTS(SELECT 1 FROM pg_proc p
          WHERE p.oid=d.objid AND p.pronargs=0 AND p.prokind='f' AND p.proname=ANY($1::text[])))
      UNION ALL SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
      WHERE n.nspname='dsh_phalanx' AND t.typrelid=0 AND NOT EXISTS (
        SELECT 1 FROM pg_type row_type WHERE row_type.typnamespace=t.typnamespace AND row_type.typrelid<>0 AND row_type.typarray=t.oid
      ) LIMIT 1`,
      [routines],
    )
    if (otherObjects.rows.length) return { ok: false, checks: [...checks, { stage, passed: false }] }
    if (!relations.rows.length) return { ok: true, schema: 'empty', serverVersion: version.version, checks: [...checks, { stage, passed: true }] }
    const platformRelations = new Set<string>(PLATFORM_RELATIONS)
    if (recorded >= 2 && recorded < 15) platformRelations.add('usage_imports')
    if (relations.rows.some(row => row.name === 'schema_migrations') && relations.rows.some(row => row.name === 'mcp_state')) {
      // Only an actual predecessor may contain the MCP table retired by migration 11.
      if (recorded >= 5 && recorded < 11) platformRelations.add('mcp_state')
    }
    if (relations.rows.some(row => !platformRelations.has(row.name))) return { ok: false, checks: [...checks, { stage, passed: false }] }
    if (!relations.rows.some(row => row.name === 'schema_migrations') || !relations.rows.some(row => row.name === 'platform_security'))
      return { ok: false, checks: [...checks, { stage, passed: false }] }
    const registry = (
      await client.query<{ fingerprint: string }>("SELECT registry->>'masterFingerprint' AS fingerprint FROM dsh_phalanx.platform_security WHERE id=1")
    ).rows[0]
    if (registry?.fingerprint !== masterFingerprint) return { ok: false, code: 'master-key-mismatch', checks: [...checks, { stage, passed: false }] }
    if (deploymentId && relations.rows.some(row => row.name === 'platform_deployment')) {
      const owner = (await client.query<{ deployment_id: string }>('SELECT deployment_id FROM dsh_phalanx.platform_deployment WHERE id=1')).rows[0]
      if (owner && owner.deployment_id !== deploymentId) return { ok: false, code: 'deployment-mismatch', checks: [...checks, { stage, passed: false }] }
    }
    return { ok: true, schema: 'platform', serverVersion: version.version, checks: [...checks, { stage, passed: true }] }
  } catch {
    return { ok: false, code: 'unavailable', checks: [...checks, { stage, passed: false }] }
  }
}

/** Installer readiness and invitation checks must not initialize default business records. */
export async function readPlatformDatabaseState(connection: PlatformDatabaseConnection) {
  const pool = platformDatabasePool(connection)
  try {
    const tables = (
      await pool.query<{ bootstrap: string | null; migrations: string | null }>(
        "SELECT to_regclass('dsh_phalanx.bootstrap_state')::text AS bootstrap,to_regclass('dsh_phalanx.schema_migrations')::text AS migrations",
      )
    ).rows[0]!
    const complete = tables.bootstrap
      ? (await pool.query<{ completed: boolean }>('SELECT completed FROM dsh_phalanx.bootstrap_state WHERE id=1')).rows[0]?.completed === true
      : false
    const schemaVersion = tables.migrations
      ? Number((await pool.query<{ version: number }>('SELECT COALESCE(max(version),0) AS version FROM dsh_phalanx.schema_migrations')).rows[0]!.version)
      : 0
    const serverVersion = (await pool.query<{ version: string }>("SELECT current_setting('server_version') AS version")).rows[0]!.version
    return { complete, schemaVersion, serverVersion }
  } catch {
    throw new PlatformDatabaseError('unavailable', 'Platform database state is unavailable; check its connection and schema')
  } finally {
    await pool.end()
  }
}

export { readRegisteredSchemaVersions } from './platform-schema-versions.js'
