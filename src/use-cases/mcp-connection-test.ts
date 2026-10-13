import type { CommunityAccountActor } from '../domain/community-account.js'
import type { CommunityMcpSettings, CommunityMcpTool } from '../domain/admin-contract.js'
import type { McpProbePort } from '../ports/mcp-services.js'
import type { McpServices } from './mcp-services.js'

/** Discovery does not hold the mutation queue; changed settings invalidate the result. */
export class McpConnectionTest {
  constructor(private readonly services: Pick<McpServices, 'list' | 'diagnostic' | 'recordTest'>, private readonly probe: McpProbePort, private readonly memberProbe?: McpProbePort) {}
  async execute(actor: CommunityAccountActor, name: string): Promise<CommunityMcpSettings> {
    this.services.list(actor)
    const service = this.services.diagnostic(actor.username, name)
    let tools: readonly CommunityMcpTool[] | undefined
    try { tools = await (service.run?.location === 'member' ? this.memberProbe! : this.probe).probe(actor.username, actor.spaceId, name) } catch { /* Persist only a redacted failure status. */ }
    await this.services.recordTest(actor, name, service.generation, tools)
    return this.services.list(actor).find(row => row.name === name)!
  }
}
