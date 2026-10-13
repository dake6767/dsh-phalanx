import type { McpWirePort } from '../ports/mcp-wire.js'
import { Readable } from 'node:stream'
import { McpProtocolError, mcpRecord } from '../domain/mcp-protocol.js'
const LIMIT = 16 * 1024 * 1024

/** Decode bounded JSON and incremental SSE records without buffering a notification stream. */
export function filterMcpStream(response: Response, filter: (value: unknown) => unknown): Response {
  const headers = new Headers(response.headers)
  for (const name of [...headers.keys()]) if (!['content-type', 'mcp-session-id', 'mcp-protocol-version', 'retry-after'].includes(name)) headers.delete(name)
  for (const [name, value] of headers) headers.set(name, String(filter(value)))
  if (!response.body || [202, 204, 205, 304].includes(response.status)) { void response.body?.cancel(); return new Response(null, { status: response.status, headers }) }
  const contentType = headers.get('content-type') ?? ''
  const source = response.body
  async function* json() {
    let text = '', bytes = 0
    const decoder = new TextDecoder('utf-8', { fatal: true })
    for await (const chunk of source!) { bytes += chunk.length; if (bytes > LIMIT) throw new McpProtocolError('MCP response exceeds the size limit'); text += decoder.decode(chunk, { stream: true }) }
    text += decoder.decode()
    yield Buffer.from(JSON.stringify(filter(JSON.parse(text))))
  }
  async function* sse() {
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let pending = '', frame: string[] = [], frameBytes = 0
    const render = () => {
      const data = frame.filter(line => line === 'data' || line.startsWith('data:')).map(line => line === 'data' ? '' : line.slice(5).replace(/^ /u, '')).join('\n')
      const result = data ? [...frame.filter(line => line !== 'data' && !line.startsWith('data:')).map(line => String(filter(line))), 'data: ' + JSON.stringify(filter(JSON.parse(data)))] : frame.map(line => String(filter(line)))
      frame = []; frameBytes = 0
      return Buffer.from(result.join('\n') + '\n\n')
    }
    for await (const chunk of source!) {
      pending += decoder.decode(chunk, { stream: true })
      if (Buffer.byteLength(pending) + frameBytes > LIMIT) throw new McpProtocolError('MCP event exceeds the size limit')
      while (true) {
        const match = /\r\n|\r|\n/u.exec(pending)
        if (!match || (match[0] === '\r' && match.index === pending.length - 1)) break
        const line = pending.slice(0, match.index); pending = pending.slice(match.index + match[0].length)
        if (line === '') yield render()
        else { frame.push(line); frameBytes += Buffer.byteLength(line) }
      }
    }
    pending += decoder.decode()
    if (pending === '\r') { if (frame.length) yield render(); pending = '' }
    if (pending.trim() || frame.some(line => line === 'data' || line.startsWith('data:'))) throw new McpProtocolError('Incomplete MCP event')
  }
  if (!contentType.includes('application/json') && !contentType.includes('text/event-stream')) {
    void source.cancel()
    throw new McpProtocolError('Unsupported MCP response content type')
  }
  return new Response(Readable.toWeb(Readable.from(contentType.includes('text/event-stream') ? sse() : json())) as ReadableStream<Uint8Array>, { status: response.status, headers })
}

export class McpHttpWire implements McpWirePort {
  filter(response: Response, filter: (value: unknown) => unknown): Response { return filterMcpStream(response, filter) }
  async reply(response: Response, id: number): Promise<Record<string, unknown>> {
    let reply: Record<string, unknown> | undefined
    const filtered = this.filter(response, value => {
      const rows = Array.isArray(value) ? value : [value]
      reply ??= rows.find(row => mcpRecord(row) && row.id === id && row.jsonrpc === '2.0')
      return value
    })
    const reader = filtered.body?.getReader()
    try {
      if (reader) while (!reply) { if ((await reader.read()).done) break }
      if (!reply || !mcpRecord(reply.result) || 'error' in reply) throw new McpProtocolError('MCP request did not return a successful response')
      return reply.result
    } finally { await reader?.cancel() }
  }
}
