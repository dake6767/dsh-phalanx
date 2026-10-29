import { BusinessRuleError } from '../domain/business-error.js'
import type { McpMetadataRowsPort } from '../ports/mcp-services.js'
import { repositorySql, repositoryTransaction, type RowRepositoryConnection } from './postgres-row-repository.js'

/** Domain generation allocation is separate from service and relationship optimistic revisions. */
export class PostgresMcpMetadata implements McpMetadataRowsPort {
  constructor(private readonly connection: RowRepositoryConnection) {}
  async generation(): Promise<number> {
    const row = (await repositorySql(this.connection).query<{ last_generation: string }>('SELECT last_generation FROM dsh_phalanx.mcp_metadata WHERE id=1'))[0]
    const generation = Number(row?.last_generation ?? 0)
    if (!Number.isSafeInteger(generation) || generation < 0) throw Error('Invalid MCP generation')
    return generation
  }
  async advance(previous: number, next: number, exclusive = false): Promise<void> {
    if (!Number.isSafeInteger(next) || next < previous) throw Error('Invalid MCP generation')
    if (next === previous) return
    const saved = await repositorySql(this.connection).query(
      exclusive
        ? 'UPDATE dsh_phalanx.mcp_metadata SET last_generation=$2 WHERE id=1 AND last_generation=$1 RETURNING id'
        : 'UPDATE dsh_phalanx.mcp_metadata SET last_generation=$1 WHERE id=1 AND last_generation<$1 RETURNING id',
      exclusive ? [previous, next] : [next],
    )
    if (exclusive && !saved.length) throw new BusinessRuleError('conflict', 'MCP generation changed. Reload before saving.', 'platform-configuration-conflict')
  }
  async requests(): Promise<readonly string[]> {
    return (
      await repositorySql(this.connection).query<{ request_id: string }>('SELECT request_id FROM dsh_phalanx.mcp_catalog_requests ORDER BY position')
    ).map(row => row.request_id)
  }
  async appendRequests(names: readonly string[]): Promise<void> {
    if (!names.length) return
    await repositoryTransaction(this.connection, async sql => {
      const counter = (await sql.query<{ last_request: string }>('SELECT last_request FROM dsh_phalanx.mcp_metadata WHERE id=1 FOR UPDATE'))[0]
      let position = Number(counter!.last_request)
      for (const request of [...new Set(names)]) {
        if (!Number.isSafeInteger(++position)) throw Error('MCP request sequence is exhausted')
        const saved = await sql.query(
          'INSERT INTO dsh_phalanx.mcp_catalog_requests(request_id,position) VALUES($1,$2) ON CONFLICT(request_id) DO NOTHING RETURNING request_id',
          [request, position],
        )
        if (!saved.length) throw new BusinessRuleError('conflict', 'This import identity was already used. Start a new import.', 'mcp-import-retired')
      }
      await sql.query('UPDATE dsh_phalanx.mcp_metadata SET last_request=$1 WHERE id=1', [position])
    })
  }
}
