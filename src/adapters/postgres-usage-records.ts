import type {
  UsageCapability,
  UsageEntry,
  UsageModelBucket,
  UsageModelQuery,
  UsageModelView,
  UsageQuery,
  UsageRecord,
  UsageRecordsView,
  UsageReportedBucket,
  UsageReportedQuery,
  UsageReportedView,
  UsageResult,
} from '../domain/usage-record.js'
import type { UsageRecordsPort } from '../ports/usage-records.js'
import type { PlatformDatabase, PlatformSql } from './platform-database.js'

type Row = Record<string, unknown>
const table = (name: string) => `dsh_phalanx.usage_${name}`
const day = (column: string) => `to_char(to_timestamp(${column}/1000.0) AT TIME ZONE 'UTC','YYYY-MM-DD')`
function filter(terms: readonly (readonly [string, string, unknown])[]) {
  const values: unknown[] = [],
    conditions: string[] = []
  for (const [column, operator, value] of terms)
    if (value !== undefined && value !== '') {
      values.push(value)
      conditions.push(`${column} ${operator} $${values.length}`)
    }
  return { values, where: conditions.length ? ' WHERE ' + conditions.join(' AND ') : '' }
}
function record(row: Row): UsageRecord {
  return {
    id: Number(row.id),
    username: String(row.username),
    groupId: row.group_id === null ? null : String(row.group_id),
    capability: {
      kind: row.kind as UsageCapability['kind'],
      id: String(row.capability),
      operation: String(row.operation),
      ...(row.first_argument === null ? {} : { firstArgument: String(row.first_argument) }),
    },
    startedAt: Number(row.started_at),
    durationMs: Number(row.duration_ms),
    outcome: row.outcome as UsageResult['outcome'],
    ...(row.exit_code === null ? {} : { exitCode: Number(row.exit_code) }),
    ...(row.is_error === null ? {} : { isError: Boolean(row.is_error) }),
    ...(row.http_status === null ? {} : { httpStatus: Number(row.http_status) }),
    ...(row.reason === null ? {} : { reason: row.reason as NonNullable<UsageResult['reason']> }),
  }
}
async function append(sql: PlatformSql, row: UsageEntry) {
  await sql.query(
    `INSERT INTO ${table('records')}(username,group_id,kind,capability,operation,started_at,duration_ms,outcome,http_status,reason,is_error,first_argument,exit_code) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      row.username,
      row.groupId,
      row.capability.kind,
      row.capability.id,
      row.capability.operation,
      row.startedAt,
      row.durationMs,
      row.outcome,
      row.httpStatus ?? null,
      row.reason ?? null,
      row.isError === undefined ? null : Number(row.isError),
      row.capability.firstArgument ?? null,
      row.exitCode ?? null,
    ],
  )
}
/** PostgreSQL owns all usage metadata; pool and schema lifetime belong to PlatformDatabase. */
export class PostgresUsageRecords implements UsageRecordsPort {
  constructor(private readonly db: PlatformDatabase) {}
  async append(row: UsageEntry): Promise<void> {
    await append(this.db, row)
  }
  async appendReported(rows: readonly UsageReportedBucket[]): Promise<void> {
    await this.db.transaction(async sql => {
      for (const row of rows) {
        const saved = await sql.query(
          `INSERT INTO ${table('reported_days')}(username,group_id,skill,day,count) VALUES($1,$2,$3,$4,$5)
          ON CONFLICT(username,group_id,skill,day) DO UPDATE SET count=usage_reported_days.count+excluded.count
          WHERE usage_reported_days.count <= 9007199254740991-excluded.count RETURNING count`,
          [row.username, row.groupId ?? '', row.skill, row.day, row.count],
        )
        if (saved.length !== 1) throw Error('Skill report count limit reached')
      }
    })
  }
  async appendModel(row: UsageModelBucket): Promise<void> {
    await this.db.query(
      `INSERT INTO ${table('model_hours')}(username,model_id,group_id,hour,requests,unknown_requests,denied_requests,input_tokens,output_tokens,cache_read,cache_write)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(username,model_id,group_id,hour) DO UPDATE SET
      requests=usage_model_hours.requests+excluded.requests, unknown_requests=usage_model_hours.unknown_requests+excluded.unknown_requests, denied_requests=usage_model_hours.denied_requests+excluded.denied_requests,
      input_tokens=CASE WHEN excluded.input_tokens IS NULL THEN usage_model_hours.input_tokens ELSE coalesce(usage_model_hours.input_tokens,0)+excluded.input_tokens END,
      output_tokens=CASE WHEN excluded.output_tokens IS NULL THEN usage_model_hours.output_tokens ELSE coalesce(usage_model_hours.output_tokens,0)+excluded.output_tokens END,
      cache_read=CASE WHEN excluded.cache_read IS NULL THEN usage_model_hours.cache_read ELSE coalesce(usage_model_hours.cache_read,0)+excluded.cache_read END,
      cache_write=CASE WHEN excluded.cache_write IS NULL THEN usage_model_hours.cache_write ELSE coalesce(usage_model_hours.cache_write,0)+excluded.cache_write END`,
      [
        row.username,
        row.modelId,
        row.groupId ?? '',
        row.hour,
        row.requests,
        row.unknownRequests,
        row.deniedRequests,
        row.tokens.input,
        row.tokens.output,
        row.tokens.cacheRead,
        row.tokens.cacheWrite,
      ],
    )
  }
  async prune(before: number): Promise<void> {
    await this.db.transaction(async sql => {
      await sql.query(`DELETE FROM ${table('records')} WHERE started_at < $1`, [before])
      await sql.query(`DELETE FROM ${table('model_hours')} WHERE hour + 3600000 <= $1`, [before])
      await sql.query(`DELETE FROM ${table('reported_days')} WHERE day + 86400000 <= $1`, [before])
    })
  }
  async retentionDays(): Promise<number> {
    return Number((await this.db.query(`SELECT retention_days FROM ${table('settings')} WHERE id=1`))[0]!.retention_days)
  }
  async saveRetention(days: number): Promise<void> {
    await this.db.query(`UPDATE ${table('settings')} SET retention_days=$1 WHERE id=1`, [days])
  }
  async view(query: UsageQuery): Promise<UsageRecordsView> {
    const { where, values } = filter([
      ['started_at', '>=', query.from],
      ['started_at', '<', query.until],
      ['username', '=', query.username],
      ['group_id', '=', query.groupId],
      ['capability', '=', query.capability],
      ['operation', '=', query.operation],
      ['outcome', '=', query.outcome],
    ])
    return this.db.transaction(async sql => {
      const total = Number((await sql.query(`SELECT count(*) AS total FROM ${table('records')}${where}`, values))[0]!.total)
      const pageCount = Math.max(1, Math.ceil(total / 50)),
        page = Math.min(query.page ?? 1, pageCount)
      const items = (
        await sql.query(`SELECT * FROM ${table('records')}${where} ORDER BY started_at DESC,id DESC LIMIT 50 OFFSET $${values.length + 1}`, [
          ...values,
          (page - 1) * 50,
        ])
      ).map(record)
      const capabilities = (
        await sql.query(
          `SELECT kind,capability,operation,count(*) AS count FROM ${table('records')}${where} GROUP BY kind,capability,operation ORDER BY count DESC,kind,capability,operation`,
          values,
        )
      ).map(row => ({
        key: JSON.stringify([row.kind, row.capability, row.operation]),
        count: Number(row.count),
        capability: { kind: row.kind as UsageCapability['kind'], id: String(row.capability), operation: String(row.operation) },
      }))
      return {
        items,
        total,
        page,
        pageCount,
        summaries: {
          members: await this.counts(sql, 'records', where, values, 'username'),
          groups: await this.counts(sql, 'records', where, values, 'group_id'),
          capabilities,
          days: await this.counts(sql, 'records', where, values, day('started_at')),
        },
      }
    })
  }
  async models(query: UsageModelQuery): Promise<UsageModelView> {
    const { where, values } = filter([
      ['hour', '>=', query.from],
      ['hour', '<', query.until],
      ['username', '=', query.username],
      ['group_id', '=', query.groupId],
      ['model_id', '=', query.modelId],
    ])
    return this.db.transaction(async sql => {
      const items = (
        await sql.query(
          `SELECT username,model_id,sum(requests) AS requests,sum(unknown_requests) AS unknown_requests,sum(denied_requests) AS denied_requests,sum(input_tokens) AS input_tokens,sum(output_tokens) AS output_tokens,sum(cache_read) AS cache_read,sum(cache_write) AS cache_write FROM ${table('model_hours')}${where} GROUP BY username,model_id ORDER BY username,model_id`,
          values,
        )
      ).map(row => ({
        username: String(row.username),
        modelId: String(row.model_id),
        requests: Number(row.requests),
        unknownRequests: Number(row.unknown_requests),
        deniedRequests: Number(row.denied_requests),
        tokens: {
          input: row.input_tokens === null ? null : Number(row.input_tokens),
          output: row.output_tokens === null ? null : Number(row.output_tokens),
          cacheRead: row.cache_read === null ? null : Number(row.cache_read),
          cacheWrite: row.cache_write === null ? null : Number(row.cache_write),
        },
      }))
      const counts = (column: string) => this.counts(sql, 'model_hours', where, values, column, 'sum(requests)')
      return {
        items,
        summaries: {
          members: await counts('username'),
          groups: await counts('group_id'),
          days: await counts(day('hour')),
          capabilities: (await counts('model_id')).map(row => ({ ...row, capability: { kind: 'model' as const, id: row.key, operation: 'messages' } })),
        },
      }
    })
  }
  async reported(query: UsageReportedQuery): Promise<UsageReportedView> {
    const { where, values } = filter([
      ['day', '>=', query.from],
      ['day', '<', query.until],
      ['username', '=', query.username],
      ['group_id', '=', query.groupId],
      ['skill', '=', query.skill],
    ])
    return this.db.transaction(async sql => {
      const items = (
        await sql.query(
          `SELECT username,skill,day,sum(count) AS count FROM ${table('reported_days')}${where} GROUP BY username,skill,day ORDER BY day DESC,username,skill`,
          values,
        )
      ).map(row => ({ username: String(row.username), skill: String(row.skill), day: Number(row.day), count: Number(row.count) }))
      const counts = (column: string) => this.counts(sql, 'reported_days', where, values, column, 'sum(count)')
      return {
        items,
        summaries: { members: await counts('username'), groups: await counts('group_id'), capabilities: await counts('skill'), days: await counts(day('day')) },
      }
    })
  }
  private async counts(sql: PlatformSql, name: string, where: string, values: readonly unknown[], column: string, count = 'count(*)') {
    return (await sql.query(`SELECT ${column} AS key,${count} AS count FROM ${table(name)}${where} GROUP BY ${column} ORDER BY count DESC,key`, values)).map(
      row => ({ key: row.key === null ? '' : String(row.key), count: Number(row.count) }),
    )
  }
}
