import { expect, it } from 'vitest'
import { filterMcpStream } from '../src/adapters/mcp-wire.js'
import { filterMcpResponse } from '../src/domain/mcp-protocol.js'
it('filters JSON and multi-line SSE events across arbitrary UTF-8 and CRLF chunk boundaries', async () => {
  const message = { jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'write', description: 'hidden' }, { name: 'read', description: '中文 secret' }], nextCursor: 'next' } }
  const filter = (value: unknown) => filterMcpResponse(value, ['write'], 'secret')
  const response = filterMcpStream(new Response(JSON.stringify(message), { headers: { 'content-type': 'application/json', 'content-length': '100', 'x-credential': 'secret' } }), filter)
  expect((await response.json()).result.tools).toEqual([{ name: 'read', description: '中文 [redacted]' }])
  expect(response.headers.has('content-length')).toBe(false); expect(response.headers.has('x-credential')).toBe(false)
  const event = 'id: event-1\r\nevent: message\r\ndata: ' + JSON.stringify(message) + '\r\n\r\n: heartbeat\r\n\r\n'
  const bytes = new TextEncoder().encode(event)
  const stream = new ReadableStream<Uint8Array>({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close() } })
  const result = await filterMcpStream(new Response(stream, { headers: { 'content-type': 'text/event-stream' } }), filter).text()
  expect(result).toContain('id: event-1\nevent: message\ndata: '); expect(result).not.toContain('hidden'); expect(result).not.toContain('secret'); expect(result).toContain('中文 [redacted]'); expect(result).toContain(': heartbeat\n\n')
})
it('fails closed for invalid/incomplete SSE and non-protocol response bodies', async () => {
  const response = (data: string) => new Response(data, { headers: { 'content-type': 'text/event-stream' } })
  await expect(filterMcpStream(response('data: {bad}\n\n'), value => value).text()).rejects.toThrow()
  await expect(filterMcpStream(response('data: {"result":{}}'), value => value).text()).rejects.toThrow()
  expect(() => filterMcpStream(new Response('secret', { headers: { 'content-type': 'text/plain' } }), value => value)).toThrow()
})
