import { createHash } from 'node:crypto'
import type { McpSnapshot, McpStateQueryPort } from '../ports/mcp-services.js'
import { repositoryTransaction, type RowRepositoryConnection } from './postgres-row-repository.js'
import { PostgresMcpStore } from './postgres-mcp-store.js'
import { PostgresMcpPolicies } from './postgres-mcp-policies.js'
import { PostgresMcpMetadata } from './postgres-mcp-metadata.js'

/** A request-local projection of rows; no aggregate is retained or written back. */
export class PostgresMcpStateQuery implements McpStateQueryPort {
  constructor(
    private readonly connection: RowRepositoryConnection,
    private readonly policyOnly = false,
  ) {}
  read(): Promise<McpSnapshot> {
    return repositoryTransaction(this.connection, async sql => {
      if (!('sql' in this.connection)) await sql.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
      const connection = { sql, cipher: 'sql' in this.connection ? this.connection.cipher : this.connection.cipher() }
      const rows = new PostgresMcpStore(connection),
        policies = new PostgresMcpPolicies(connection),
        metadata = new PostgresMcpMetadata(connection)
      const services = this.policyOnly ? await rows.policyRows() : await rows.list()
      const groups = await policies.groups(),
        members = await policies.members()
      const protectedRows = await sql.query('SELECT service,scope,field,value FROM dsh_phalanx.mcp_secrets ORDER BY service,scope,field')
      return {
        services,
        protectedRevision: createHash('sha256').update(JSON.stringify(protectedRows)).digest('hex'),
        grants: Object.fromEntries(groups.map(row => [row.groupId, row.names])),
        selections: Object.fromEntries(members.flatMap(row => (row.selections === undefined ? [] : [[row.spaceId, row.selections]]))),
        preferences: Object.fromEntries(members.flatMap(row => (row.preferences === undefined ? [] : [[row.spaceId, row.preferences]]))),
        revision: await metadata.generation(),
        catalogRequests: await metadata.requests(),
        versions: {
          services: Object.fromEntries(services.map(row => [row.name, row.rowRevision!])),
          groups: Object.fromEntries(groups.map(row => [row.groupId, row.revision])),
          members: Object.fromEntries(members.map(row => [row.spaceId, row.revision])),
        },
      }
    })
  }
}
