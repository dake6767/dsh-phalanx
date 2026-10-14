import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { expect, it } from 'vitest'
import { memberSharedMcpClient } from '../src/dsh/mcp-shared-client.js'

it('preserves the initialization barrier while allowing concurrent ordinary requests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-client-order-'))
  const module = join(root, 'node_modules/@modelcontextprotocol/client')
  await mkdir(module, { recursive: true })
  await writeFile(join(module, 'package.json'), JSON.stringify({ type: 'module', main: 'index.js' }))
  // A network transport may complete the notification on a later event-loop turn.
  // Ordinary requests need concurrency: request 2 waits for request 3 to arrive.
  await writeFile(join(module, 'index.js'), `
export class SdkHttpError extends Error {}
export class StreamableHTTPClientTransport {
  initialized = false; release;
  async start() {} async close() {} setProtocolVersion() {}
  async send(message) {
    if (message.method === 'notifications/initialized') {
      await new Promise(resolve => setImmediate(resolve)); this.initialized = true; return
    }
    if (message.id === 2) await new Promise(resolve => { this.release = resolve })
    if (message.id === 3) this.release()
    this.onmessage({jsonrpc:'2.0',id:message.id,result:message.method==='initialize'
      ? {protocolVersion:'2025-03-26'} : {initialized:this.initialized}})
  }
}`)
  await writeFile(join(root, 'client.mjs'), memberSharedMcpClient)
  const child = spawn(process.execPath, [join(root, 'client.mjs'), JSON.stringify({ module: join(root, 'package.json'), path: '/mcp' })], {
    env: { ...process.env, PHALANX_MCP_GATEWAY_URL: 'http://127.0.0.1', PHALANX_MCP_GATEWAY_TOKEN: 'fixture' }, stdio: ['pipe', 'pipe', 'pipe'],
  })
  const exited = once(child, 'exit'), lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  child.stderr.resume()
  try {
    child.stdin.write([
      { id: 1, method: 'initialize' }, { method: 'notifications/initialized' },
      { id: 2, method: 'tools/list' }, { id: 3, method: 'resources/list' },
    ].map(message => JSON.stringify({ jsonrpc: '2.0', ...message })).join('\n') + '\n')
    const replies = []
    for (let index = 0; index < 3; index++) replies.push(JSON.parse((await lines.next()).value!))
    expect(replies.filter(row => row.id !== 1).map(row => row.result)).toEqual([{ initialized: true }, { initialized: true }])
  } finally { child.kill('SIGTERM'); await exited; await rm(root, { recursive: true, force: true }) }
})

it('closes on stdin EOF while the initial HTTP notification is hanging', async () => {
  const { createServer } = await import('node:http')
  const { fileURLToPath } = await import('node:url')
  let reached!: () => void
  const hanging = new Promise<void>(resolve => { reached = resolve })
  const server = createServer(async (request, response) => {
    if (request.method === 'GET') { response.writeHead(405).end(); return }
    let body = ''; for await (const chunk of request) body += chunk
    const message = JSON.parse(body)
    if (message.method === 'notifications/initialized') { reached(); return }
    response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'fixture' }).end(JSON.stringify({
      jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'fixture', version: '1' } },
    }))
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const root = await mkdtemp(join(tmpdir(), 'mcp-client-close-'))
  await writeFile(join(root, 'client.mjs'), memberSharedMcpClient)
  const child = spawn(process.execPath, [join(root, 'client.mjs'), JSON.stringify({ module: fileURLToPath(import.meta.url), path: '/mcp' })], {
    env: { ...process.env, PHALANX_MCP_GATEWAY_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}`, PHALANX_MCP_GATEWAY_TOKEN: 'fixture' }, stdio: ['pipe', 'pipe', 'pipe'],
  })
  const exited = once(child, 'exit'), lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  child.stderr.resume()
  try {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } } }) + '\n')
    expect(JSON.parse((await lines.next()).value!).id).toBe(1)
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
    await hanging
    child.stdin.end()
    expect((await exited)[0]).toBe(0)
  } finally { child.kill('SIGKILL'); await exited; server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }) }
})
