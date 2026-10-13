import { createServer } from 'node:http'
import { once } from 'node:events'
import { Client, SdkHttpError, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { expect, it, vi } from 'vitest'
import { sharedMcpTransport } from '../src/dsh/mcp-shared-transport.js'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { memberSharedMcpClient } from '../src/dsh/mcp-shared-client.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/client'

it('continues a shared MCP tool call after its previous session has expired without replaying an executed call', async () => {
  let session = 'first', executions = 0, initializations = 0, authorized = true
  let hold = false, entered!: () => void, resume!: () => void
  const initializing = new Promise<void>(resolve => { entered = resolve })
  const resumed = new Promise<void>(resolve => { resume = resolve })
  const server = createServer(async (request, response) => {
    if (request.method === 'GET') { response.writeHead(405).end(); return }
    let raw = ''; for await (const chunk of request) raw += chunk
    const message = JSON.parse(raw)
    if (!authorized) { response.writeHead(403).end('{}'); return }
    if (message.method === 'initialize' && hold) { entered(); await resumed }
    if (message.method !== 'initialize' && request.headers['mcp-session-id'] !== session) { response.writeHead(404).end('{}'); return }
    if (message.method.startsWith('notifications/')) { response.writeHead(202).end(); return }
    const result = message.method === 'initialize'
      ? (initializations++, { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } })
      : { content: [{ type: 'text', text: String(++executions) }] }
    response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': session }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const origin = new URL(`http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`)
  const client = new Client({ name: 'fixture', version: '1' }, { capabilities: {} })
  try {
    const directory = await mkdtemp(join(tmpdir(), 'shared-relay-'))
    await writeFile(join(directory, 'client.mjs'), memberSharedMcpClient)
    try {
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(directory, 'client.mjs'), JSON.stringify({ module: fileURLToPath(import.meta.url), path: '/mcp' })], env: { PHALANX_MCP_GATEWAY_URL: origin.origin, PHALANX_MCP_GATEWAY_TOKEN: 'fixture' } }))
    } finally { await rm(directory, { recursive: true, force: true }) }
    expect(await client.callTool({ name: 'write' })).toMatchObject({ content: [{ text: '1' }] })
    session = 'second'
    expect(await client.callTool({ name: 'write' })).toMatchObject({ content: [{ text: '2' }] })
    expect(initializations).toBe(2); expect(executions).toBe(2)
    session = 'third'; hold = true
    const abort = new AbortController()
    const canceled = client.callTool({ name: 'write' }, { signal: abort.signal }).catch(() => 'canceled')
    await initializing; abort.abort()
    expect(await canceled).toBe('canceled')
    hold = false; resume()
    expect(await client.callTool({ name: 'write' })).toMatchObject({ content: [{ text: '3' }] })
    expect(executions).toBe(3)
    authorized = false
    await expect(client.callTool({ name: 'write' })).rejects.toThrow('authorization-denied')
    expect(executions).toBe(3)
  } finally { await client.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})

it('bounds recovery even when the initialized notification hangs and allows the next call', async () => {
  let session = 'first', hang = false, writes = 0
  let reached!: () => void
  const hanging = new Promise<void>(resolve => { reached = resolve })
  const server = createServer(async (request, response) => {
    if (request.method === 'GET') { response.writeHead(405).end(); return }
    let raw = ''; for await (const chunk of request) raw += chunk
    const message = JSON.parse(raw)
    if (message.method !== 'initialize' && request.headers['mcp-session-id'] !== session) { response.writeHead(404).end('{}'); return }
    if (message.method === 'notifications/initialized') { if (hang) { reached(); return }; response.writeHead(202).end(); return }
    const result = message.method === 'initialize'
      ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
      : { content: [{ type: 'text', text: String(++writes) }] }
    response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': session }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const origin = new URL(`http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`)
  const client = new Client({ name: 'fixture', version: '1' }, { capabilities: {} })
  try {
    await client.connect(sharedMcpTransport(() => new StreamableHTTPClientTransport(origin), error => error instanceof SdkHttpError && error.status === 404))
    hang = true; session = 'second'
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const result = client.callTool({ name: 'write' }).then(() => 'success', error => error.message)
    await hanging
    await vi.advanceTimersByTimeAsync(30_000)
    expect(await result).toContain('recovery-timeout')
    expect(writes).toBe(0)
    vi.useRealTimers(); hang = false
    expect(await client.callTool({ name: 'write' })).toMatchObject({ content: [{ text: '1' }] })
  } finally { vi.useRealTimers(); await client.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})

it('does not replay an unknown write and permits a later call after reinitialization fails', async () => {
  let session = 'first', writes = 0, unavailable = false, loseReply = false
  const server = createServer(async (request, response) => {
    if (request.method === 'GET') { response.writeHead(405).end(); return }
    let raw = ''; for await (const chunk of request) raw += chunk
    const message = JSON.parse(raw)
    if (message.method === 'initialize' && unavailable) { response.writeHead(503).end('{}'); return }
    if (message.method !== 'initialize' && request.headers['mcp-session-id'] !== session) { response.writeHead(404).end('{}'); return }
    if (message.method === 'notifications/initialized') { response.writeHead(202).end(); return }
    const result = message.method === 'initialize'
      ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
      : { content: [{ type: 'text', text: String(++writes) }] }
    if (message.method === 'tools/call' && loseReply) { response.writeHead(200, { 'content-type': 'text/event-stream' }).end(': reply lost\n\n'); return }
    response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': session }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const origin = new URL(`http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`)
  const client = new Client({ name: 'fixture', version: '1' }, { capabilities: {} })
  try {
    await client.connect(sharedMcpTransport(() => new StreamableHTTPClientTransport(origin), error => error instanceof SdkHttpError && error.status === 404))
    loseReply = true
    await expect(client.callTool({ name: 'write' })).rejects.toThrow()
    expect(writes).toBe(1)
    loseReply = false; session = 'second'; unavailable = true
    await expect(client.callTool({ name: 'write' })).rejects.toThrow()
    expect(writes).toBe(1)
    unavailable = false
    expect(await client.callTool({ name: 'write' })).toMatchObject({ content: [{ text: '2' }] })
    expect(writes).toBe(2)
  } finally { await client.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})

it('does not execute a concurrent request after already reporting its result as unknown', async () => {
  let session = 'first', writes = 0, waiting!: () => void
  const waitingForBody = new Promise<void>(resolve => { waiting = resolve })
  const replies: JSONRPCMessage[] = []
  const server = createServer(async (request, response) => {
    if (request.method === 'GET') { response.writeHead(405).end(); return }
    let raw = ''; for await (const chunk of request) raw += chunk
    const message = JSON.parse(raw)
    if (message.method !== 'initialize' && request.headers['mcp-session-id'] !== session) {
      response.writeHead(404, { 'content-type': 'application/json' })
      if (message.id === 2) { response.flushHeaders(); waiting(); return }
      response.end('{}'); return
    }
    if (message.method === 'notifications/initialized') { response.writeHead(202).end(); return }
    const result = message.method === 'initialize'
      ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
      : { content: [{ type: 'text', text: String(++writes) }] }
    response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': session }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const origin = new URL(`http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`)
  const transport = sharedMcpTransport(() => new StreamableHTTPClientTransport(origin), error => error instanceof SdkHttpError && error.status === 404)
  transport.onmessage = message => { replies.push(message) }
  try {
    await transport.start()
    await transport.send({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } } })
    session = 'second'
    const pending = transport.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'write' } })
    await waitingForBody
    await Promise.allSettled([pending, transport.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'write' } })])
    expect(replies.filter(row => 'id' in row && row.id === 2)).toHaveLength(1)
    expect(replies.find(row => 'id' in row && row.id === 2)).toHaveProperty('error')
    expect(writes).toBe(1)
  } finally { await transport.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})
