import { createHash } from 'node:crypto'
import type { McpPolicyView, McpSnapshot } from '../ports/mcp-services.js'
import type { PlatformDatabase } from './platform-database.js'
import { PostgresCommittedView } from './postgres-committed-view.js'
import { PostgresMcpStateQuery } from './postgres-mcp-state-query.js'

export const mcpFactTables = [
  'groups',
  'accounts',
  'mcp_services',
  'mcp_secrets',
  'mcp_metadata',
  'mcp_group_settings',
  'mcp_group_grants',
  'mcp_member_settings',
  'mcp_selections',
  'mcp_preferences',
  'mcp_catalog_requests',
  'mcp_runtime_dependencies',
].map(table => 'dsh_phalanx.' + table)

/** Sole publication owner for the synchronous MCP policy fence; plaintext secrets are never loaded. */
export class PostgresMcpFacts implements McpPolicyView {
  private readonly committed: PostgresCommittedView<McpSnapshot>
  constructor(database: PlatformDatabase) {
    this.committed = new PostgresCommittedView(database, mcpFactTables, () => new PostgresMcpStateQuery(database, true).read())
  }
  initialize(): Promise<void> {
    return this.committed.initialize()
  }
  close(): Promise<void> {
    return this.committed.close()
  }
  read(): McpSnapshot {
    return this.committed.read(snapshot => snapshot)
  }
  version(): string {
    return this.committed.read(snapshot => createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'))
  }
}
