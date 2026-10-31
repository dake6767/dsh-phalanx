import type { PoolClient } from 'pg'
import { postgresUpgradePasswordFile } from './postgres-upgrade-connection.js'
import { createHash } from 'node:crypto'
import { readFileSync, lstatSync, chmodSync, openSync, fsyncSync, closeSync, createReadStream } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { AdvisoryLock } from './advisory-locks.js'
import type { PlatformDatabaseConnection } from '../domain/platform-database.js'
import { FilePlatformDatabaseConfig } from './platform-database-config.js'
import { platformDatabasePool } from './platform-database-inspection.js'
import { readRegisteredSchemaVersions } from './platform-schema-versions.js'
import { schemaIdentifier } from './platform-schema-registry.js'

export interface UpgradeDatabaseFacts {
  readonly masterKeyPath: string
  readonly configurationSha256: string
  readonly serverMajor: number
  readonly selection: 'builtin' | 'external'
  readonly estimatedBytes: number
  readonly schemas: readonly {
    readonly name: string
    readonly present: boolean
    readonly version: number
    readonly namespace?: Readonly<Record<string, unknown>>
  }[]
}
const NAMESPACE_METADATA = `jsonb_build_object('owner',n.nspowner::text,
  'acl',CASE WHEN n.nspacl IS NULL THEN NULL ELSE (SELECT array_agg(a::text ORDER BY a::text) FROM unnest(n.nspacl) a) END,
  'commentHash',md5(obj_description(n.oid,'pg_namespace')),
  'defaultPrivileges',COALESCE((SELECT jsonb_agg(jsonb_build_object('role',d.defaclrole::text,'kind',d.defaclobjtype,
    'acl',(SELECT array_agg(a::text ORDER BY a::text) FROM unnest(d.defaclacl) a)) ORDER BY d.defaclrole,d.defaclobjtype)
    FROM pg_default_acl d WHERE d.defaclnamespace=n.oid),'[]'::jsonb))`
/** Read-only upgrade facts; connection credentials never leave this adapter. */
export async function inspectUpgradeDatabase(configFile: string, dataRoot: string, schemas: readonly string[]): Promise<UpgradeDatabaseFacts> {
  if (schemas[0] !== 'dsh_phalanx' || new Set(schemas).size !== schemas.length) throw Error('Invalid upgrade schema inventory')
  for (const name of schemas) schemaIdentifier(name)
  const saved = FilePlatformDatabaseConfig.open(configFile, dataRoot)
  postgresUpgradePasswordFile(saved.connection)
  const pool = platformDatabasePool(saved.connection)
  try {
    const version = Number((await pool.query<{ version: string }>("SELECT current_setting('server_version_num') AS version")).rows[0]!.version)
    const serverMajor = Math.floor(version / 10000)
    if (serverMajor < 14 || !saved.selection) throw Error('A selected PostgreSQL 14 or newer database is required')
    const rows = []
    for (const name of schemas) {
      const row = (
        await pool.query<{ present: boolean; owned: boolean }>(
          `SELECT n.oid IS NOT NULL AS present,
        n.nspowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS owned
        FROM (SELECT 1) AS probe LEFT JOIN pg_namespace n ON n.nspname=$1`,
          [name],
        )
      ).rows[0]!
      if (row.present && !row.owned) throw Error('The database role must own each registered schema')
      const [recorded] = await readRegisteredSchemaVersions(pool, [{ name, migrations: [] }])
      const namespace = row.present
        ? (await pool.query<{ metadata: Record<string, unknown> }>(`SELECT ${NAMESPACE_METADATA} AS metadata FROM pg_namespace n WHERE n.nspname=$1`, [name]))
            .rows[0]!.metadata
        : undefined
      rows.push({ name, present: row.present, version: recorded!.version, ...(namespace ? { namespace } : {}) })
    }
    const bytes = Number(
      (
        await pool.query<{ bytes: string }>(
          `SELECT COALESCE(sum(pg_total_relation_size(c.oid)),0)::text AS bytes
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=ANY($1::text[]) AND c.relkind IN ('r','m','S')`,
          [schemas],
        )
      ).rows[0]!.bytes,
    )
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw Error('Database export size is unavailable')
    return {
      masterKeyPath: saved.security.masterKeyPath,
      configurationSha256: createHash('sha256').update(readFileSync(configFile)).digest('hex'),
      selection: saved.selection,
      serverMajor,
      estimatedBytes: bytes,
      schemas: rows,
    }
  } catch {
    throw Error('Upgrade database inspection failed; check the selected connection, role and registered schemas')
  } finally {
    await pool.end()
  }
}

export interface UpgradeDatabaseTools {
  dump(
    connection: import('../domain/platform-database.js').PlatformDatabaseConnection,
    schemas: readonly string[],
    destination: string,
    signal?: AbortSignal,
  ): Promise<void>
  restore(
    connection: import('../domain/platform-database.js').PlatformDatabaseConnection,
    archive: string,
    before: string,
    after: string,
    retainedSchemas: readonly string[],
  ): Promise<void>
}
export interface UpgradeDatabaseBackup {
  readonly schema: 1
  readonly facts: UpgradeDatabaseFacts
  readonly sha256: string
}
function privateDirectory(directory: string): void {
  const info = lstatSync(directory)
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700)
    throw Error('Upgrade archive directory must be private and owned')
}
async function archiveHash(path: string): Promise<string> {
  const info = lstatSync(path)
  if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600) throw Error('Upgrade archive must be a private regular file')
  const hash = createHash('sha256')
  for await (const block of createReadStream(path)) hash.update(block)
  return hash.digest('hex')
}
async function offline<T>(connection: PlatformDatabaseConnection, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const pool = platformDatabasePool(connection)
  let client: PoolClient | undefined
  const controller = new AbortController()
  try {
    client = await pool.connect()
    client.once('error', () => controller.abort())
    client.once('end', () => controller.abort())
    for (const key of [AdvisoryLock.deployment, AdvisoryLock.migration]) {
      if (!(await client.query<{ acquired: boolean }>('SELECT pg_try_advisory_lock($1::bigint) AS acquired', [key])).rows[0]!.acquired)
        throw Error('Stop the platform before exporting or restoring its database')
    }
    const result = await action(controller.signal)
    controller.signal.throwIfAborted()
    return result
  } finally {
    client?.release(true)
    await pool.end()
  }
}
export async function backupUpgradeDatabase(
  configFile: string,
  dataRoot: string,
  facts: UpgradeDatabaseFacts,
  directory: string,
  tools: UpgradeDatabaseTools,
): Promise<UpgradeDatabaseBackup> {
  privateDirectory(directory)
  const saved = FilePlatformDatabaseConfig.open(configFile, dataRoot)
  return offline(saved.connection, async signal => {
    const actual = await inspectUpgradeDatabase(
      configFile,
      dataRoot,
      facts.schemas.map(row => row.name),
    )
    if (
      actual.configurationSha256 !== facts.configurationSha256 ||
      actual.serverMajor !== facts.serverMajor ||
      !isDeepStrictEqual(actual.schemas, facts.schemas)
    )
      throw Error('Database selection or registered schemas changed after preparation')
    const path = join(directory, 'platform.pgdump')
    await tools.dump(
      saved.connection,
      facts.schemas.filter(row => row.present).map(row => row.name),
      path,
      signal,
    )
    chmodSync(path, 0o600)
    const sha256 = await archiveHash(path)
    for (const name of [path, directory]) {
      const fd = openSync(name, 'r')
      try {
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
    }
    return { schema: 1, facts: actual, sha256 }
  })
}
/** Database-enforced RESTRICT protects incoming dependencies even when another session creates one during recovery. */
function namespaceCheck(facts: UpgradeDatabaseFacts): string {
  return facts.schemas
    .filter(row => row.present)
    .map(row => {
      const expected = JSON.stringify(row.namespace).replaceAll("'", "''")
      return `IF NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname='${row.name}' AND ${NAMESPACE_METADATA}='${expected}'::jsonb)
      THEN RAISE EXCEPTION 'Registered namespace ownership or privileges changed; keep maintenance closed'; END IF;`
    })
    .join('\n')
}
function restorePrelude(facts: UpgradeDatabaseFacts): string {
  const names = facts.schemas.map(row => row.name),
    major = facts.serverMajor
  const retained = facts.schemas
    .filter(row => row.present)
    .map(row => "'" + row.name + "'")
    .join(',')
  const absent = facts.schemas.filter(row => !row.present).map(row => schemaIdentifier(row.name))
  const literals = names.map(name => "'" + name + "'").join(',')
  return `SET LOCAL standard_conforming_strings=on;
  DO $upgrade_restore$
  DECLARE candidate record; progressed boolean;
  BEGIN
    IF NOT pg_try_advisory_xact_lock(${AdvisoryLock.deployment}::bigint) OR NOT pg_try_advisory_xact_lock(${AdvisoryLock.migration}::bigint)
      THEN RAISE EXCEPTION 'Another platform process owns the selected database'; END IF;
    IF current_setting('server_version_num')::integer/10000<>${major}
      THEN RAISE EXCEPTION 'PostgreSQL server major changed after backup'; END IF;
    IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname IN (${literals}) AND nspowner<>(SELECT oid FROM pg_roles WHERE rolname=current_user))
      THEN RAISE EXCEPTION 'The restoring role no longer owns all registered schemas'; END IF;
    IF EXISTS (SELECT 1 FROM pg_inherits i JOIN pg_class child ON child.oid=i.inhrelid JOIN pg_namespace cn ON cn.oid=child.relnamespace
      JOIN pg_class parent ON parent.oid=i.inhparent JOIN pg_namespace pn ON pn.oid=parent.relnamespace
      WHERE (cn.nspname IN (${literals}))<>(pn.nspname IN (${literals})))
      THEN RAISE EXCEPTION 'Restore refuses inheritance across registered schemas'; END IF;
    ${namespaceCheck(facts)}
    LOOP
      progressed=false;
      FOR candidate IN
        SELECT kind,string_agg(identity,',' ORDER BY identity) AS identities FROM (
          SELECT CASE
            WHEN d.classid='pg_class'::regclass THEN (SELECT CASE c.relkind
              WHEN 'r' THEN 'TABLE' WHEN 'p' THEN 'TABLE' WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW'
              WHEN 'S' THEN 'SEQUENCE' WHEN 'f' THEN 'FOREIGN TABLE' END FROM pg_class c WHERE c.oid=d.objid)
            WHEN d.classid='pg_type'::regclass THEN (SELECT CASE WHEN t.typtype='d' THEN 'DOMAIN' ELSE 'TYPE' END FROM pg_type t WHERE t.oid=d.objid)
            WHEN d.classid='pg_proc'::regclass THEN (SELECT CASE p.prokind WHEN 'p' THEN 'PROCEDURE' WHEN 'a' THEN 'AGGREGATE' ELSE 'FUNCTION' END FROM pg_proc p WHERE p.oid=d.objid)
            WHEN d.classid='pg_operator'::regclass THEN 'OPERATOR'
            WHEN d.classid='pg_collation'::regclass THEN 'COLLATION'
            WHEN d.classid='pg_conversion'::regclass THEN 'CONVERSION'
            WHEN d.classid='pg_ts_config'::regclass THEN 'TEXT SEARCH CONFIGURATION'
            WHEN d.classid='pg_ts_dict'::regclass THEN 'TEXT SEARCH DICTIONARY'
            WHEN d.classid='pg_ts_parser'::regclass THEN 'TEXT SEARCH PARSER'
            WHEN d.classid='pg_ts_template'::regclass THEN 'TEXT SEARCH TEMPLATE'
            WHEN d.classid='pg_statistic_ext'::regclass THEN 'STATISTICS'
          END AS kind,(pg_identify_object(d.classid,d.objid,0)).identity AS identity
          FROM pg_depend d JOIN pg_namespace n ON d.refclassid='pg_namespace'::regclass AND d.refobjid=n.oid
          WHERE n.nspname IN (${literals}) AND d.deptype='n'
            AND NOT EXISTS (SELECT 1 FROM pg_depend owner WHERE owner.classid=d.classid AND owner.objid=d.objid AND owner.deptype='i')
        ) objects WHERE kind IS NOT NULL GROUP BY kind
      LOOP
        BEGIN
          EXECUTE 'DROP '||candidate.kind||' IF EXISTS '||candidate.identities||' RESTRICT';
          progressed=true;
        EXCEPTION WHEN dependent_objects_still_exist THEN NULL;
        END;
      END LOOP;
      EXIT WHEN NOT progressed;
    END LOOP;
    IF EXISTS(SELECT 1 FROM pg_depend d JOIN pg_namespace n ON d.refclassid='pg_namespace'::regclass AND d.refobjid=n.oid
      WHERE n.nspname IN (${retained || "''"}) AND d.deptype='n' AND d.classid<>'pg_default_acl'::regclass)
      THEN RAISE EXCEPTION 'Registered namespaces contain objects that cannot be restored safely'; END IF;
  END $upgrade_restore$;
  ${absent.length ? 'DROP SCHEMA IF EXISTS ' + absent.join(',') + ' RESTRICT;' : ''}`
}
function restoreVerification(facts: UpgradeDatabaseFacts): string {
  const checks = facts.schemas.map(row =>
    row.present
      ? `IF to_regnamespace('${row.name}') IS NULL THEN RAISE EXCEPTION 'Restored namespace is missing'; END IF;
       IF to_regclass('${row.name}.schema_migrations') IS NULL THEN
         IF ${row.version}<>0 THEN RAISE EXCEPTION 'Restored schema version is missing'; END IF;
       ELSIF (SELECT COALESCE(max(version),0) FROM ${schemaIdentifier(row.name)}.schema_migrations)<>${row.version}
         THEN RAISE EXCEPTION 'Restored registered schema version differs'; END IF;`
      : `IF to_regnamespace('${row.name}') IS NOT NULL THEN RAISE EXCEPTION 'New namespace remained after recovery'; END IF;`,
  )
  return `DO $upgrade_verify$ BEGIN ${checks.join('\n')} ${namespaceCheck(facts)} END $upgrade_verify$;`
}
export async function restoreUpgradeDatabase(
  configFile: string,
  dataRoot: string,
  input: unknown,
  directory: string,
  tools: UpgradeDatabaseTools,
): Promise<void> {
  privateDirectory(directory)
  const receipt = input as UpgradeDatabaseBackup
  if (
    !receipt ||
    receipt.schema !== 1 ||
    !/^[a-f0-9]{64}$/u.test(receipt.sha256) ||
    !receipt.facts ||
    !/^[a-f0-9]{64}$/u.test(receipt.facts.configurationSha256) ||
    !Number.isInteger(receipt.facts.serverMajor) ||
    receipt.facts.serverMajor < 14 ||
    !Array.isArray(receipt.facts.schemas)
  )
    throw Error('Invalid database backup receipt')
  const names = receipt.facts.schemas.map(row => {
    schemaIdentifier(row.name)
    if (
      typeof row.present !== 'boolean' ||
      !Number.isSafeInteger(row.version) ||
      row.version < 0 ||
      (row.present && (!row.namespace || typeof row.namespace !== 'object'))
    )
      throw Error('Invalid schema backup receipt')
    return row.name
  })
  if (names[0] !== 'dsh_phalanx' || new Set(names).size !== names.length) throw Error('Invalid database schema backup inventory')
  const archive = join(directory, 'platform.pgdump')
  if ((await archiveHash(archive)) !== receipt.sha256) throw Error('Database archive is damaged; recovery stopped')
  const saved = FilePlatformDatabaseConfig.open(configFile, dataRoot)
  if (createHash('sha256').update(readFileSync(configFile)).digest('hex') !== receipt.facts.configurationSha256)
    throw Error('Restore the original database connection before recovering its schemas')
  await tools.restore(
    saved.connection,
    archive,
    restorePrelude(receipt.facts),
    restoreVerification(receipt.facts),
    receipt.facts.schemas.filter(row => row.present).map(row => row.name),
  )
}
