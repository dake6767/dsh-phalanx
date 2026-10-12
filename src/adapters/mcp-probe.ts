import type { CommunityMcpTool } from '../domain/admin-contract.js'
import { discoverMcpTools } from './mcp-discovery.js'
import { McpProtocolError } from '../domain/mcp-protocol.js'
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
      return await discoverMcpTools(send, version => { headers['mcp-protocol-version'] = version })
    } finally {
      if (headers['mcp-session-id'] && !controller.signal.aborted) {
        try { const response = await fetch(url, { method: 'DELETE', headers, signal: controller.signal, redirect: 'error' }); await response.body?.cancel() } catch { /* Session cleanup is best effort within the diagnostic deadline. */ }
      }
      clearTimeout(timer); controller.abort(); this.active.delete(controller); done()
    }
  }
  async stop(): Promise<void> { this.stopped = true; const pending = [...this.active.entries()]; for (const [controller] of pending) controller.abort(); await Promise.all(pending.map(([, promise]) => promise)) }
}
