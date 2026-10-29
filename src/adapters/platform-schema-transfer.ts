import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { isDeepStrictEqual } from 'node:util'
import type { PlatformSql } from './platform-database.js'
import { currentPlatformSchema, PLATFORM_TABLES, PLATFORM_ROUTINES } from './platform-schema.js'

interface Layout {
  readonly table_name: string
  readonly signature: string
  readonly primary_key: string[]
}
interface Summary {
  readonly count: number
  readonly sha256: string
}
interface Sequence {
  readonly last_value: string
  readonly is_called: boolean
  readonly parameters: string
}
const tables = PLATFORM_TABLES.map(table => `dsh_phalanx."${table}"`).join(',')
const environment = "SET LOCAL TIME ZONE 'UTC'; SET LOCAL datestyle='ISO,YMD'; SET LOCAL extra_float_digits=3; SET LOCAL bytea_output='hex'"

/** An opaque logical archive keeps bigint/floating/timestamp values inside PostgreSQL's type conversion. */
export async function transferPlatformSchema(source: PlatformSql, target: PlatformSql, archive: string): Promise<void> {
  let sourceTransaction = false,
    targetTransaction = false
  try {
    await source.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    sourceTransaction = true
    await source.query(environment)
    await target.query('BEGIN')
    targetTransaction = true
    await target.query(environment)
    const original = await layout(target),
      sourceLayout = await layout(source)
    const expected = await exportSchema(source, sourceLayout, archive)
    const sequence = await sequenceState(source)
    const [namespace] = await target.query<{ present: boolean }>("SELECT to_regnamespace('dsh_phalanx') IS NOT NULL AS present")
    // RESTRICT rejects external dependents. PostgreSQL rolls back all DDL/data on failure.
    if (original.length) {
      await target.query(`DROP TABLE ${tables} RESTRICT`)
      for (const routine of PLATFORM_ROUTINES) await target.query(`DROP FUNCTION IF EXISTS dsh_phalanx."${routine.name}"() RESTRICT`)
    }
    await target.query(currentPlatformSchema(!namespace!.present))
    const canonical = await layout(target)
    if (!isDeepStrictEqual(sourceLayout, canonical) || (original.length && !isDeepStrictEqual(original, canonical)))
      throw Error('Database transfer requires the exact current platform table layout')
    const targetSequence = await sequenceState(target)
    if (targetSequence.parameters !== sequence.parameters) throw Error('Database transfer requires the current identity sequence layout')
    await target.query(`TRUNCATE TABLE ${tables}`)
    await importSchema(target, archive)
    for (const row of canonical) {
      const actual = await tableSummary(target, row)
      if (!isDeepStrictEqual(actual, expected.get(row.table_name))) throw Error('Database transfer verification did not match its source snapshot')
    }
    await target.query("SELECT setval('dsh_phalanx.usage_records_id_seq',$1::bigint,$2::boolean)", [sequence.last_value, sequence.is_called])
    if (!isDeepStrictEqual(await sequenceState(target), sequence)) throw Error('Database transfer sequence verification failed')
    await target.query('COMMIT')
    targetTransaction = false
    await source.query('COMMIT')
    sourceTransaction = false
  } catch (error) {
    const failures = [error]
    for (const [database, active] of [
      [target, targetTransaction],
      [source, sourceTransaction],
    ] as const) {
      if (active)
        try {
          await database.query('ROLLBACK')
        } catch (cleanup) {
          failures.push(cleanup)
        }
    }
    if (failures.length > 1) throw new AggregateError(failures, 'Database transfer failed; keep the original selection')
    throw error
  }
}

async function layout(database: PlatformSql): Promise<Layout[]> {
  const rows = await database.query<Layout & Record<string, unknown>>(`SELECT c.relname AS table_name,
    jsonb_build_object('kind',c.relkind,'persistence',c.relpersistence,'rls',c.relrowsecurity,'forceRls',c.relforcerowsecurity,
      'columns',(SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notNull',a.attnotnull,'identity',a.attidentity,'generated',a.attgenerated,'default',pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum)
        FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
      'constraints',(SELECT jsonb_agg(pg_get_constraintdef(k.oid) ORDER BY pg_get_constraintdef(k.oid)) FROM pg_constraint k WHERE k.conrelid=c.oid),
      'indexes',(SELECT jsonb_agg(pg_get_indexdef(i.indexrelid) ORDER BY pg_get_indexdef(i.indexrelid)) FROM pg_index i WHERE i.indrelid=c.oid))::text AS signature,
    ARRAY(SELECT a.attname::text FROM pg_constraint k CROSS JOIN LATERAL unnest(k.conkey) WITH ORDINALITY AS key(attnum,position)
      JOIN pg_attribute a ON a.attrelid=k.conrelid AND a.attnum=key.attnum WHERE k.conrelid=c.oid AND k.contype='p' ORDER BY key.position) AS primary_key
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='dsh_phalanx' AND c.relkind IN ('r','p') ORDER BY c.relname`)
  if (
    rows.length &&
    (rows.length !== PLATFORM_TABLES.length ||
      rows.some(row => !PLATFORM_TABLES.includes(row.table_name as (typeof PLATFORM_TABLES)[number]) || !row.primary_key.length))
  )
    throw Error('Database transfer found an unknown platform table layout')
  return rows
}
async function sequenceState(database: PlatformSql): Promise<Sequence> {
  const [state] = await database.query<Sequence & Record<string, unknown>>(`SELECT value.last_value::text AS last_value,value.is_called,
    jsonb_build_array(format_type(s.seqtypid,NULL),s.seqstart::text,s.seqincrement::text,s.seqmax::text,s.seqmin::text,s.seqcache::text,s.seqcycle)::text AS parameters
    FROM dsh_phalanx.usage_records_id_seq AS value CROSS JOIN pg_sequence s WHERE s.seqrelid='dsh_phalanx.usage_records_id_seq'::regclass`)
  if (!state || !/^[0-9]+$/u.test(state.last_value) || typeof state.is_called !== 'boolean') throw Error('Invalid platform identity sequence')
  return state
}
function ordered(row: Layout): string {
  // Database locale is not part of the connection contract; compare identical bytes.
  return `SELECT to_jsonb(row)::text AS value FROM dsh_phalanx."${row.table_name}" AS row ORDER BY to_jsonb(row)::text COLLATE "C" OFFSET $1 LIMIT 500`
}
async function exportSchema(database: PlatformSql, rows: readonly Layout[], archive: string): Promise<Map<string, Summary>> {
  if (rows.length !== PLATFORM_TABLES.length) throw Error('The selected platform database is not initialized')
  const file = await open(archive, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600),
    summaries = new Map<string, Summary>()
  try {
    for (const table of PLATFORM_TABLES) {
      const row = rows.find(row => row.table_name === table)!
      let count = 0
      const hash = createHash('sha256')
      for (;;) {
        const page = await database.query<{ value: string }>(ordered(row), [count])
        if (!page.length) break
        for (const item of page) hash.update(item.value + '\n')
        await file.writeFile(JSON.stringify({ table: row.table_name, rows: page.map(item => item.value) }) + '\n')
        count += page.length
      }
      summaries.set(row.table_name, { count, sha256: hash.digest('hex') })
    }
    await file.sync()
    return summaries
  } finally {
    await file.close()
  }
}
async function importSchema(database: PlatformSql, archive: string): Promise<void> {
  const file = await open(archive, constants.O_RDONLY | constants.O_NOFOLLOW),
    stream = file.createReadStream({ autoClose: false })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    const info = await file.stat()
    if (!info.isFile() || (info.mode & 0o777) !== 0o600 || info.uid !== process.getuid?.()) throw Error('Invalid protected database archive')
    for await (const line of lines) {
      let page: { table: string; rows: string[] }
      try {
        page = JSON.parse(line) as typeof page
      } catch {
        throw Error('Invalid protected database archive page')
      }
      if (
        !PLATFORM_TABLES.includes(page.table as (typeof PLATFORM_TABLES)[number]) ||
        !Array.isArray(page.rows) ||
        page.rows.length > 500 ||
        page.rows.some(row => typeof row !== 'string')
      )
        throw Error('Invalid database archive inventory')
      await database.query(
        `INSERT INTO dsh_phalanx."${page.table}" OVERRIDING SYSTEM VALUE SELECT * FROM json_populate_recordset(NULL::dsh_phalanx."${page.table}",$1::json)`,
        ['[' + page.rows.join(',') + ']'],
      )
    }
  } finally {
    lines.close()
    stream.destroy()
    await file.close()
  }
}
async function tableSummary(database: PlatformSql, row: Layout): Promise<Summary> {
  let count = 0
  const hash = createHash('sha256')
  for (;;) {
    const page = await database.query<{ value: string }>(ordered(row), [count])
    if (!page.length) break
    for (const item of page) hash.update(item.value + '\n')
    count += page.length
  }
  return { count, sha256: hash.digest('hex') }
}
