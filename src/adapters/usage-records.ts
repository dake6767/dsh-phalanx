import { isExecutionFailureCode } from '../domain/platform-execution.js'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { UsageCapability, UsageEntry, UsageQuery, UsageRecord, UsageRecordsView, UsageResult, UsageModelBucket, UsageModelQuery, UsageModelView, UsageReportedBucket, UsageReportedQuery, UsageReportedView } from '../domain/usage-record.js'
import type { UsageRecordsPort } from '../ports/usage-records.js'

/** Independent versioned metadata database, outside member-controlled spaces. */
export class SqliteUsageRecords implements UsageRecordsPort {
  private readonly db: DatabaseSync
  private closed = false
  constructor(path: string, legacy?: { readonly mcpAuditPath: string; readonly executionAuditPath?: string }) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    try {
      this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;')
      const version = this.db.prepare('PRAGMA user_version').get()?.user_version
      if (version === 0) {
        if (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").get()) throw Error('usage records require a fresh database')
        this.db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE usage_records (
            id INTEGER PRIMARY KEY, username TEXT NOT NULL, group_id TEXT,
            kind TEXT NOT NULL, capability TEXT NOT NULL, operation TEXT NOT NULL,
            started_at INTEGER NOT NULL, duration_ms INTEGER NOT NULL,
            outcome TEXT NOT NULL CHECK(outcome IN ('succeeded','failed','denied')), http_status INTEGER, reason TEXT
          );
          CREATE INDEX usage_started ON usage_records(started_at);
          CREATE INDEX usage_member ON usage_records(username, started_at);
          CREATE TABLE usage_settings (id INTEGER PRIMARY KEY CHECK(id=1), retention_days INTEGER NOT NULL CHECK(retention_days BETWEEN 1 AND 3650));
          INSERT INTO usage_settings VALUES(1,180);
          PRAGMA user_version=1; COMMIT;`)
      } else if (version !== 1 && version !== 2 && version !== 3 && version !== 4 && version !== 5) throw Error('unsupported usage records schema')
      if (version === 0 || version === 1) this.db.exec(`BEGIN IMMEDIATE; ALTER TABLE usage_records ADD COLUMN is_error INTEGER; CREATE TABLE usage_imports (source TEXT PRIMARY KEY); PRAGMA user_version=2; COMMIT;`)
      if (version !== 3 && version !== 4 && version !== 5) this.db.exec('BEGIN IMMEDIATE; ALTER TABLE usage_records ADD COLUMN first_argument TEXT; ALTER TABLE usage_records ADD COLUMN exit_code INTEGER; PRAGMA user_version=3; COMMIT;')
      if (version !== 4 && version !== 5) this.db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE usage_model_hours (username TEXT NOT NULL, model_id TEXT NOT NULL, group_id TEXT NOT NULL, hour INTEGER NOT NULL,
          requests INTEGER NOT NULL, unknown_requests INTEGER NOT NULL, denied_requests INTEGER NOT NULL,
          input_tokens INTEGER, output_tokens INTEGER, cache_read INTEGER, cache_write INTEGER, PRIMARY KEY(username,model_id,group_id,hour));
        CREATE INDEX usage_model_hour ON usage_model_hours(hour);
        PRAGMA user_version=4; COMMIT;`)
      if (version !== 5) this.db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE usage_reported_days (username TEXT NOT NULL, group_id TEXT NOT NULL, skill TEXT NOT NULL, day INTEGER NOT NULL,
          count INTEGER NOT NULL CHECK(count BETWEEN 1 AND 9007199254740991), PRIMARY KEY(username,group_id,skill,day));
        CREATE INDEX usage_reported_day ON usage_reported_days(day);
        PRAGMA user_version=5; COMMIT;`)
      if (legacy) this.importMcp(legacy.mcpAuditPath)
      if (legacy?.executionAuditPath) this.importExecution(legacy.executionAuditPath)
    } catch (error) { this.db.close(); throw error }
  }
  appendReported(rows: readonly UsageReportedBucket[]): void {
    const insert = this.db.prepare(`INSERT INTO usage_reported_days(username,group_id,skill,day,count) VALUES(?,?,?,?,?)
      ON CONFLICT(username,group_id,skill,day) DO UPDATE SET count=count+excluded.count WHERE count <= 9007199254740991-excluded.count`)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const row of rows) if (insert.run(row.username, row.groupId ?? '', row.skill, row.day, row.count).changes !== 1) throw Error('Skill report count limit reached')
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  reported(query: UsageReportedQuery): UsageReportedView {
    const conditions: string[] = [], values: (string | number)[] = []
    for (const [column, operator, value] of [['day', '>=', query.from], ['day', '<', query.until], ['username', '=', query.username], ['group_id', '=', query.groupId], ['skill', '=', query.skill]] as const)
      if (value !== undefined && value !== '') { conditions.push(`${column} ${operator} ?`); values.push(value) }
    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''
    const items = this.db.prepare(`SELECT username,skill,day,sum(count) AS count FROM usage_reported_days${where} GROUP BY username,skill,day ORDER BY day DESC,username,skill`).all(...values)
      .map(row => ({ username: String(row.username), skill: String(row.skill), day: Number(row.day), count: Number(row.count) }))
    const counts = (column: string) => this.db.prepare(`SELECT ${column} AS key,sum(count) AS count FROM usage_reported_days${where} GROUP BY ${column} ORDER BY count DESC,key`).all(...values).map(row => ({ key: String(row.key), count: Number(row.count) }))
    return { items, summaries: { members: counts('username'), groups: counts('group_id'), capabilities: counts('skill'), days: counts("strftime('%Y-%m-%d',day/1000,'unixepoch')") } }
  }
  append(row: UsageEntry): void {
    this.db.prepare(`INSERT INTO usage_records(username,group_id,kind,capability,operation,started_at,duration_ms,outcome,http_status,reason,is_error,first_argument,exit_code) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(row.username, row.groupId, row.capability.kind, row.capability.id, row.capability.operation, row.startedAt, row.durationMs, row.outcome, row.httpStatus ?? null, row.reason ?? null, row.isError === undefined ? null : Number(row.isError), row.capability.firstArgument ?? null, row.exitCode ?? null)
  }
  appendModel(row: UsageModelBucket): void {
    this.db.prepare(`INSERT INTO usage_model_hours(username,model_id,group_id,hour,requests,unknown_requests,denied_requests,input_tokens,output_tokens,cache_read,cache_write)
      VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(username,model_id,group_id,hour) DO UPDATE SET
      requests=requests+excluded.requests, unknown_requests=unknown_requests+excluded.unknown_requests, denied_requests=denied_requests+excluded.denied_requests,
      input_tokens=CASE WHEN excluded.input_tokens IS NULL THEN input_tokens ELSE coalesce(input_tokens,0)+excluded.input_tokens END,
      output_tokens=CASE WHEN excluded.output_tokens IS NULL THEN output_tokens ELSE coalesce(output_tokens,0)+excluded.output_tokens END,
      cache_read=CASE WHEN excluded.cache_read IS NULL THEN cache_read ELSE coalesce(cache_read,0)+excluded.cache_read END,
      cache_write=CASE WHEN excluded.cache_write IS NULL THEN cache_write ELSE coalesce(cache_write,0)+excluded.cache_write END`)
      .run(row.username, row.modelId, row.groupId ?? '', row.hour, row.requests, row.unknownRequests, row.deniedRequests, row.tokens.input, row.tokens.output, row.tokens.cacheRead, row.tokens.cacheWrite)
  }
  models(query: UsageModelQuery): UsageModelView {
    const conditions: string[] = [], values: (string | number)[] = []
    for (const [column, operator, value] of [['hour', '>=', query.from], ['hour', '<', query.until], ['username', '=', query.username], ['group_id', '=', query.groupId], ['model_id', '=', query.modelId]] as const)
      if (value !== undefined && value !== '') { conditions.push(`${column} ${operator} ?`); values.push(value) }
    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''
    const items = this.db.prepare(`SELECT username,model_id,sum(requests) AS requests,sum(unknown_requests) AS unknown_requests,sum(denied_requests) AS denied_requests,
      sum(input_tokens) AS input_tokens,sum(output_tokens) AS output_tokens,sum(cache_read) AS cache_read,sum(cache_write) AS cache_write
      FROM usage_model_hours${where} GROUP BY username,model_id ORDER BY username,model_id`).all(...values).map(row => ({ username: String(row.username), modelId: String(row.model_id),
      requests: Number(row.requests), unknownRequests: Number(row.unknown_requests), deniedRequests: Number(row.denied_requests),
      tokens: { input: row.input_tokens === null ? null : Number(row.input_tokens), output: row.output_tokens === null ? null : Number(row.output_tokens), cacheRead: row.cache_read === null ? null : Number(row.cache_read), cacheWrite: row.cache_write === null ? null : Number(row.cache_write) } }))
    const counts = (column: string) => this.db.prepare(`SELECT ${column} AS key,sum(requests) AS count FROM usage_model_hours${where} GROUP BY ${column} ORDER BY count DESC,key`).all(...values).map(row => ({ key: String(row.key), count: Number(row.count) }))
    return { items, summaries: { members: counts('username'), groups: counts('group_id'), days: counts("strftime('%Y-%m-%d',hour/1000,'unixepoch')"),
      capabilities: counts('model_id').map(row => ({ ...row, capability: { kind: 'model', id: row.key, operation: 'messages' } })) } }
  }
  prune(before: number): void { this.db.prepare('DELETE FROM usage_records WHERE started_at < ?').run(before); this.db.prepare('DELETE FROM usage_model_hours WHERE hour + 3600000 <= ?').run(before); this.db.prepare('DELETE FROM usage_reported_days WHERE day + 86400000 <= ?').run(before) }
  retentionDays(): number { return Number(this.db.prepare('SELECT retention_days FROM usage_settings WHERE id=1').get()!.retention_days) }
  saveRetention(days: number): void { this.db.prepare('UPDATE usage_settings SET retention_days=? WHERE id=1').run(days) }
  view(query: UsageQuery): UsageRecordsView {
    const conditions: string[] = [], values: (string | number)[] = []
    for (const [column, operator, value] of [
      ['started_at', '>=', query.from], ['started_at', '<', query.until], ['username', '=', query.username], ['group_id', '=', query.groupId],
      ['capability', '=', query.capability], ['operation', '=', query.operation], ['outcome', '=', query.outcome],
    ] as const) if (value !== undefined && value !== '') { conditions.push(`${column} ${operator} ?`); values.push(value) }
    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''
    const total = Number(this.db.prepare(`SELECT count(*) AS total FROM usage_records${where}`).get(...values)!.total)
    const pageCount = Math.max(1, Math.ceil(total / 50)), page = Math.min(query.page ?? 1, pageCount)
    const items: UsageRecord[] = this.db.prepare(`SELECT * FROM usage_records${where} ORDER BY started_at DESC,id DESC LIMIT 50 OFFSET ?`).all(...values, (page - 1) * 50).map(row => ({
      id: Number(row.id), username: String(row.username), groupId: row.group_id === null ? null : String(row.group_id),
      capability: { kind: row.kind as UsageCapability['kind'], id: String(row.capability), operation: String(row.operation), ...(row.first_argument === null ? {} : { firstArgument: String(row.first_argument) }) },
      startedAt: Number(row.started_at), durationMs: Number(row.duration_ms), outcome: row.outcome as UsageResult['outcome'],
      ...(row.exit_code === null ? {} : { exitCode: Number(row.exit_code) }),
      ...(row.is_error === null ? {} : { isError: Boolean(row.is_error) }),
      ...(row.http_status === null ? {} : { httpStatus: Number(row.http_status) }), ...(row.reason === null ? {} : { reason: row.reason as NonNullable<UsageResult['reason']> }),
    }))
    const counts = (column: string) => this.db.prepare(`SELECT ${column} AS key,count(*) AS count FROM usage_records${where} GROUP BY ${column} ORDER BY count DESC,key`).all(...values).map(row => ({ key: row.key === null ? '' : String(row.key), count: Number(row.count) }))
    return { items, total, page, pageCount, summaries: { members: counts('username'), groups: counts('group_id'), capabilities: this.db.prepare(`SELECT kind,capability,operation,count(*) AS count FROM usage_records${where} GROUP BY kind,capability,operation ORDER BY count DESC,kind,capability,operation`).all(...values).map(row => ({ key: JSON.stringify([row.kind, row.capability, row.operation]), count: Number(row.count), capability: { kind: row.kind as UsageCapability['kind'], id: String(row.capability), operation: String(row.operation) } })), days: counts("strftime('%Y-%m-%d',started_at/1000,'unixepoch')") } }
  }
  private importMcp(path: string): void {
    const source = 'mcp-json-v1'
    if (this.db.prepare('SELECT source FROM usage_imports WHERE source=?').get(source)) return
    let input: unknown
    try { input = JSON.parse(readFileSync(path, 'utf8')) as unknown }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw Error('Invalid legacy MCP usage records'); input = [] }
    if (!Array.isArray(input)) throw Error('Invalid legacy MCP usage records')
    const entries: UsageEntry[] = []
    for (const row of input) {
      if (!row || typeof row !== 'object' || typeof row.username !== 'string' || typeof row.service !== 'string' || typeof row.method !== 'string'
        || !['success', 'failed', 'denied'].includes(row.status) || !Number.isSafeInteger(row.startedAt) || row.startedAt < 0
        || !Number.isFinite(row.durationMs) || row.durationMs < 0 || row.tool !== undefined && typeof row.tool !== 'string') throw Error('Invalid legacy MCP usage records')
      if (row.method === 'tools/call') entries.push({ username: row.username, groupId: null, capability: { kind: 'mcp', id: row.service, operation: row.tool ?? '' },
        startedAt: row.startedAt, durationMs: row.durationMs, outcome: row.status === 'success' ? 'succeeded' : row.status })
    }
    this.db.exec('BEGIN IMMEDIATE')
    try { for (const entry of entries) this.append(entry); this.db.prepare('INSERT INTO usage_imports(source) VALUES(?)').run(source); this.db.exec('COMMIT') }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  private importExecution(path: string): void {
    const source = 'execution-json-v1'
    if (this.db.prepare('SELECT source FROM usage_imports WHERE source=?').get(source)) return
    let input: unknown
    try { input = JSON.parse(readFileSync(path, 'utf8')) as unknown }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw Error('Invalid legacy execution usage records'); input = [] }
    if (!Array.isArray(input)) throw Error('Invalid legacy execution usage records')
    const entries: UsageEntry[] = []
    for (const row of input) {
      if (!row || typeof row !== 'object' || typeof row.username !== 'string' || typeof row.owner !== 'string' || typeof row.command !== 'string'
        || !Number.isSafeInteger(row.startedAt) || row.startedAt < 0 || !Number.isFinite(row.durationMs) || row.durationMs < 0
        || row.exitCode !== undefined && !Number.isSafeInteger(row.exitCode)
        || row.reason !== undefined && row.reason !== 'cancelled' && !isExecutionFailureCode(row.reason)
        || row.exitCode === undefined && row.reason === undefined) throw Error('Invalid legacy execution usage records')
      const denied = row.reason !== undefined && ['unauthorized', 'disabled', 'not-ready', 'command-missing', 'concurrency'].includes(row.reason)
      entries.push({ username: row.username, groupId: null, capability: { kind: 'execution', id: row.owner, operation: row.command }, startedAt: row.startedAt, durationMs: row.durationMs,
        outcome: denied ? 'denied' : row.reason !== undefined || row.exitCode !== 0 ? 'failed' : 'succeeded', ...(row.reason === undefined ? {} : { reason: row.reason }), ...(row.exitCode === undefined ? {} : { exitCode: row.exitCode }) })
    }
    this.db.exec('BEGIN IMMEDIATE')
    try { for (const entry of entries) this.append(entry); this.db.prepare('INSERT INTO usage_imports(source) VALUES(?)').run(source); this.db.exec('COMMIT') }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  close(): void { if (!this.closed) { this.closed = true; this.db.close() } }
}
