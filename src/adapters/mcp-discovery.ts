import type { CommunityMcpTool } from '../domain/admin-contract.js'
import { McpProtocolError, mcpRecord } from '../domain/mcp-protocol.js'

/** Bounded protocol discovery shared by HTTP and member stdio diagnostics. */
export async function discoverMcpTools(send: (method: string, params?: unknown, notification?: boolean) => Promise<Record<string, unknown>>, initializedVersion: (version: string) => void = () => {}): Promise<readonly CommunityMcpTool[]> {
  const initialized = await send('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'dsh-phalanx-diagnostics', version: '1' } })
  if (!['2024-11-05', '2025-03-26', '2025-06-18'].includes(String(initialized.protocolVersion))) throw new McpProtocolError('Unsupported MCP protocol version')
  initializedVersion(String(initialized.protocolVersion))
  await send('notifications/initialized', undefined, true)
  const tools: CommunityMcpTool[] = [], cursors = new Set<string>(), names = new Set<string>()
  let cursor: string | undefined, size = 0
  for (let page = 0; page < 100; page++) {
    const result = await send('tools/list', cursor ? { cursor } : {})
    if (!Array.isArray(result.tools)) throw new McpProtocolError('Invalid MCP tools response')
    for (const tool of result.tools) {
      if (!mcpRecord(tool) || typeof tool.name !== 'string' || !tool.name || tool.name.length > 256 || names.has(tool.name) || !mcpRecord(tool.inputSchema) || (tool.description !== undefined && typeof tool.description !== 'string') || tools.length >= 10000) throw new McpProtocolError('Invalid MCP tool')
      size += Buffer.byteLength(JSON.stringify(tool)); if (size > 16 * 1024 * 1024) throw new McpProtocolError('MCP tool snapshot exceeds the size limit')
      names.add(tool.name); tools.push({ name: tool.name, ...(typeof tool.description === 'string' ? { description: tool.description } : {}), inputSchema: tool.inputSchema })
    }
    if (result.nextCursor === undefined) return tools
    if (typeof result.nextCursor !== 'string' || !result.nextCursor || cursors.has(result.nextCursor)) throw new McpProtocolError('Invalid MCP pagination')
    cursor = result.nextCursor; cursors.add(cursor)
  }
  throw new McpProtocolError('MCP tool pagination limit exceeded')
}
