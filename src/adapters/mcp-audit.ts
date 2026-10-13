import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { McpAuditPort, McpAuditRecord } from '../ports/mcp-services.js'

/** Bounded metadata-only audit outside member mounts. No payloads or upstream addresses are accepted. */
export class FileMcpAudit implements McpAuditPort {
  private rows: readonly McpAuditRecord[]
  constructor(private readonly path: string) {
    this.rows = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as McpAuditRecord[] : []
    if (!Array.isArray(this.rows)) throw new Error('Invalid MCP audit store')
  }
  append(record: McpAuditRecord): void {
    const row: McpAuditRecord = { username: record.username, service: record.service, method: record.method, ...(record.tool === undefined ? {} : { tool: record.tool }), status: record.status, startedAt: record.startedAt, durationMs: record.durationMs }
    const next = [...this.rows, row].slice(-10000)
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.${randomUUID()}`
    try { writeFileSync(temporary, JSON.stringify(next), { flag: 'wx', mode: 0o600 }); renameSync(temporary, this.path); this.rows = next }
    finally { rmSync(temporary, { force: true }) }
  }
}
