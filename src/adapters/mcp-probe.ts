import type { CommunityMcpTool } from '../domain/admin-contract.js'
import { McpProtocolError, mcpRecord } from '../domain/mcp-protocol.js'
import type { CommunityModelAccessPort } from '../ports/community-model-access.js'
import type { McpProbePort } from '../ports/mcp-services.js'
import type { McpWirePort } from '../ports/mcp-wire.js'

/** Platform diagnostics use the same authenticated HTTP gateway as the official client. */
export class GatewayMcpProbe implements McpProbePort {
  private stopped = false
  private readonly active = new Map<AbortController, Promise<void>>()
  constructor(private readonly origin: () => URL, private readonly access: Pick<CommunityModelAccessPort, 'forUser'>, private readonly wire: McpWirePort) {}
  async probe(username: string, spaceId: string, name: string): Promise<readonly CommunityMcpTool[]> {
    if (this.stopped) throw new McpProtocolError('MCP diagnostics stopped')
    const url = new URL('/mcp-test/' + encodeURIComponent(name), this.origin())
    const headers: Record<string, string> = { authorization: 'Bearer ' + this.access.forUser(username, spaceId), 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30_000)
    let done!: () => void
    this.active.set(controller, new Promise<void>(resolve => { done = resolve }))
    let id = 0
    const send = async (method: string, params?: unknown, notification = false) => {
      const requestId = ++id
      const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', ...(!notification ? { id: requestId } : {}), method, ...(params ? { params } : {}) }), signal: controller.signal, redirect: 'error' })
      if (!response.ok) { await response.body?.cancel(); throw new McpProtocolError('MCP diagnostic failed') }
      if (method === 'initialize') { const session = response.headers.get('mcp-session-id'); if (session) headers['mcp-session-id'] = session }
      if (notification) { await response.body?.cancel(); return {} }
      return this.wire.reply(response, requestId)
    }
    try {
      const initialized = await send('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'dsh-phalanx-diagnostics', version: '1' } })
      if (!['2024-11-05', '2025-03-26', '2025-06-18'].includes(String(initialized.protocolVersion))) throw new McpProtocolError('Unsupported MCP protocol version')
      headers['mcp-protocol-version'] = String(initialized.protocolVersion)
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
    } finally {
      if (headers['mcp-session-id'] && !controller.signal.aborted) {
        try { const response = await fetch(url, { method: 'DELETE', headers, signal: controller.signal, redirect: 'error' }); await response.body?.cancel() } catch { /* Session cleanup is best effort within the diagnostic deadline. */ }
      }
      clearTimeout(timer); controller.abort(); this.active.delete(controller); done()
    }
  }
  async stop(): Promise<void> { this.stopped = true; const pending = [...this.active.entries()]; for (const [controller] of pending) controller.abort(); await Promise.all(pending.map(([, promise]) => promise)) }
}
