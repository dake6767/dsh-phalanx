#!/usr/bin/env node
// Manual timing diagnostic: a connected TCP tunnel and HTTP body remain idle for 61 seconds.
// This is separate from quick functional tests. All peers and bytes are controlled loopback fixtures.
import { createServer as createTcpServer } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import { once } from 'node:events'
import { setTimeout } from 'node:timers'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
const option = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1] }
const modulePath = resolve(option('--transport') ?? fileURLToPath(new URL('../../dist/adapters/public-network.js', import.meta.url)))
const expected = option('--expect') ?? 'open', output = option('--output')
if (!['open', 'closed'].includes(expected) || !output) throw Error('Use --expect open|closed --output FILE, optionally --transport MODULE')
const { NodeNetworkTransport } = await import(pathToFileURL(modulePath).href)
const result = { schema: 1, moduleSha256: createHash('sha256').update(await readFile(modulePath)).digest('hex'), idleWindowMs: 61000, expected }
const peers = new Set()
const tcp = createTcpServer(socket => { peers.add(socket); socket.on('error', () => {}); socket.on('data', data => socket.write(data)); socket.once('close', () => peers.delete(socket)) })
let httpResponse
const http = createHttpServer((_request, response) => { httpResponse = response; response.on('error', () => {}); response.writeHead(200); response.write('before-idle') })
const listen = async server => {
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address(); if (!address || typeof address === 'string') throw Error('No listener address')
  return { hostname: 'fixture.test', address: '127.0.0.1', port: address.port }
}
let socket, outgoing, incoming, failure
try {
  const transport = new NodeNetworkTransport()
  socket = await transport.connect(await listen(tcp)); socket.on('error', () => {})
  const exchange = transport.http(await listen(http), { method: 'GET', path: '/', headers: {} })
  outgoing = exchange.request; outgoing.on('error', () => {}); outgoing.end()
  incoming = await exchange.response
  const chunks = [], first = once(incoming, 'data')
  const finished = new Promise(resolveDone => { incoming.once('end', resolveDone); incoming.once('aborted', resolveDone); incoming.once('error', resolveDone) })
  incoming.on('data', chunk => chunks.push(Buffer.from(chunk))); incoming.on('error', () => {})
  await first
  await new Promise(resolveWait => setTimeout(resolveWait, result.idleWindowMs))
  result.tcpOpen = !socket.destroyed; result.httpOpen = !incoming.destroyed
  if (result.tcpOpen) {
    const echo = once(socket, 'data', { signal: AbortSignal.timeout(10000) }); socket.write('after-idle')
    result.tcpEcho = (await echo)[0].toString() === 'after-idle'
  }
  httpResponse.end('after-idle'); await finished
  result.httpBody = Buffer.concat(chunks).toString()
  const open = result.tcpOpen && result.httpOpen && result.tcpEcho && result.httpBody === 'before-idleafter-idle'
  const closed = !result.tcpOpen && !result.httpOpen
  if (!(expected === 'open' ? open : closed)) throw Error('Connected transport did not match the expected idle behavior')
} catch (error) { failure = error } finally {
  socket?.destroy(); outgoing?.destroy(); incoming?.destroy()
  for (const peer of peers) peer.destroy()
  http.closeAllConnections()
  const cleanup = await Promise.allSettled([tcp, http].map(server => server.listening ? new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose())) : undefined))
  result.cleanupPassed = cleanup.every(value => value.status === 'fulfilled')
  result.passed = failure === undefined && result.cleanupPassed
  await writeFile(output, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 })
}
if (!result.passed) throw failure ?? Error('Network idle diagnostic cleanup failed')
process.stdout.write(`Network idle diagnostic passed (expected ${expected})\n`)
