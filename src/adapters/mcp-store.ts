import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { validateMcpSettings, type McpState } from '../domain/mcp-service.js'
import type { McpStorePort } from '../ports/mcp-services.js'

/** Durable platform-only MCP library and grants, committed together. */
export class FileMcpStore implements McpStorePort {
  private state: McpState = { services: [], grants: {} }
  constructor(private readonly path: string) {
    if (!existsSync(path)) return
    const value = JSON.parse(readFileSync(path, 'utf8')) as McpState & { schema: number }
    if (value.schema !== 1 || !Array.isArray(value.services) || !value.grants || typeof value.grants !== 'object' || Array.isArray(value.grants)
      || new Set(value.services.map(row => row.name)).size !== value.services.length
      || Object.values(value.grants).some(names => !Array.isArray(names) || names.some(name => typeof name !== 'string'))) throw new Error('Invalid MCP store')
    for (const row of value.services) { validateMcpSettings(row); if (!Number.isSafeInteger(row.generation) || row.generation < 1) throw new Error('Invalid MCP generation') }
    if (value.revision !== undefined && (!Number.isSafeInteger(value.revision) || value.revision < Math.max(0, ...value.services.map(row => row.generation)))) throw new Error('Invalid MCP revision')
    if (value.selections !== undefined && (!value.selections || typeof value.selections !== 'object' || Array.isArray(value.selections) || Object.values(value.selections).some(names => !Array.isArray(names) || names.some(name => typeof name !== 'string')))) throw new Error('Invalid MCP selections')
    if (value.preferences !== undefined && (!value.preferences || typeof value.preferences !== 'object' || Array.isArray(value.preferences) || Object.values(value.preferences).some(row => !row || typeof row !== 'object' || Array.isArray(row) || Object.values(row).some(enabled => typeof enabled !== 'boolean')))) throw new Error('Invalid MCP preferences')
    this.state = { ...(value.preferences ? { preferences: value.preferences } : {}), ...(value.selections ? { selections: value.selections } : {}), services: value.services, grants: value.grants, revision: value.revision ?? Math.max(0, ...value.services.map(row => row.generation)) }
    chmodSync(path, 0o600)
  }
  read(): McpState { return structuredClone(this.state) }
  write(state: McpState): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const next = structuredClone(state), temporary = `${this.path}.${randomUUID()}`
    try { writeFileSync(temporary, JSON.stringify({ schema: 1, ...next }), { flag: 'wx', mode: 0o600 }); renameSync(temporary, this.path); this.state = next }
    finally { rmSync(temporary, { force: true }) }
  }
}
