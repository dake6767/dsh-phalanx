import { preparedMcpCommand } from '../dsh/mcp-command.js'

/** Runs inside the isolated carrier. Only protocol traffic crosses its authenticated loopback endpoint. */
export const sharedMcpBridge = String.raw`
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import { join, resolve } from 'node:path'
import { readFileSync, mkdirSync, existsSync } from 'node:fs'
const chunks = []; let inputSize = 0
for await (const chunk of process.stdin) { inputSize += chunk.length; if (inputSize > 1024 * 1024) process.exit(1); chunks.push(chunk) }
const config = JSON.parse(Buffer.concat(chunks).toString())
const directory = config.directory, environment = { ...config.environment }
if (environment.HOME) mkdirSync(environment.HOME, { recursive: true, mode: 0o700 })
const preparedMcpCommand = ${preparedMcpCommand.toString()}
const { command, args } = preparedMcpCommand(config, { node: process.execPath, read: path => readFileSync(path, 'utf8'), exists: existsSync, join, resolve })
const child = spawn(command, args, { cwd: directory, env: environment, stdio: ['pipe', 'pipe', 'pipe'] })
child.stderr.resume(); child.stdin.on('error', () => shutdown())
const session = randomUUID(), pending = new Map(), requests = new Set(), queued = []
let sequence = 0, subscription, queueBytes = 0, initialized, initializePending = false, closing = false
const active = (event = { type: 'activity' }) => process.stdout.write(JSON.stringify(event) + '\n')
const fail = (response, status) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(status === 202 ? undefined : '{}') }
const open = response => {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'mcp-session-id': session }); response.flushHeaders()
  // Transport comments prevent client body-idle timeouts without renewing tool activity.
  const heartbeat = setInterval(() => {
    if (!response.destroyed && !response.writableEnded && !response.writableNeedDrain) response.write(': keepalive\n\n')
  }, 30000)
  heartbeat.unref()
  const clear = () => clearInterval(heartbeat)
  response.once('finish', clear); response.once('close', clear)
}
const emit = (response, value) => { if (response.writableLength > 16 * 1024 * 1024) { response.destroy(); return }; response.write('data: ' + JSON.stringify(value) + '\n\n') }
function shutdown() {
  if (closing) return; closing = true
  server.close(); server.closeAllConnections(); child.stdin.end()
  const timer = setTimeout(() => { child.kill('SIGKILL'); process.exit(1) }, 1000); timer.unref()
}
function write(message) {
  if (message.method === 'notifications/cancelled') {
    for (const [id, entry] of pending) if (entry.id === message.params?.requestId) { child.stdin.write(JSON.stringify({ ...message, params: { ...message.params, requestId: id } }) + '\n'); active({ type: 'cancelled', id }) }
  } else child.stdin.write(JSON.stringify(message) + '\n')
}
function unsolicited(message) {
  const target = subscription ?? [...requests][0]?.response
  if (target && !target.destroyed) emit(target, message)
  else { const size = Buffer.byteLength(JSON.stringify(message)); queueBytes += size; if (queued.length >= 100 || queueBytes > 16 * 1024 * 1024) return shutdown(); queued.push(message) }
}
const server = createServer(async (request, response) => {
  try {
    if (request.url !== '/mcp') return fail(response, 404)
    if (request.headers.authorization !== 'Bearer ' + config.token) return fail(response, 401)
    if (request.headers.origin) return fail(response, 403)
    if (!['POST', 'GET', 'DELETE'].includes(request.method)) return fail(response, 405)
    if (closing) return fail(response, 503)
    if (request.method !== 'POST') {
      if (!initialized || request.headers['mcp-session-id'] !== session) return fail(response, 404)
      if (request.method === 'DELETE') { fail(response, 200); shutdown(); return }
      if (subscription) return fail(response, 409)
      subscription = response; open(response)
      for (const row of queued.splice(0)) emit(response, row); queueBytes = 0
      response.once('close', () => { if (subscription === response) subscription = undefined })
      return
    }
    const buffers = []; let bytes = 0
    for await (const chunk of request) { bytes += chunk.length; if (bytes > 16 * 1024 * 1024) return fail(response, 413); buffers.push(chunk) }
    const body = JSON.parse(Buffer.concat(buffers).toString()), rows = Array.isArray(body) ? body : [body]
    if (!rows.length || rows.length > 100 || rows.some(row => !row || row.jsonrpc !== '2.0')) return fail(response, 400)
    const initialize = rows.length === 1 && rows[0].method === 'initialize'
    if (!initialize && (!initialized || request.headers['mcp-session-id'] !== session)) return fail(response, 404)
    if (initialize && (rows[0].id === undefined || initializePending)) return fail(response, 409)
    active()
    if (initialize && initialized) { open(response); emit(response, { ...initialized, id: rows[0].id }); response.end(); return }
    const outbound = rows.filter(row => row.method !== undefined && row.id !== undefined)
    if (child.stdin.writableLength > 16 * 1024 * 1024 || pending.size + outbound.length > 100) return fail(response, 429)
    if (!outbound.length) { for (const row of rows) write(row); fail(response, 202); return }
    if (initialize) initializePending = true
    const group = { response, ids: new Set(), completed: [] }; requests.add(group); open(response)
    response.once('finish', () => { for (const event of group.completed) active(event) })
    response.once('close', () => {
      if (!response.writableFinished && !closing) for (const event of group.completed) active({ type: 'cancelled', id: event.id })
      const cancelled = !closing
      requests.delete(group)
      if (initialize && group.ids.size) shutdown()
      for (const id of group.ids) { pending.delete(id); if (cancelled) { if (!closing) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id } }) + '\n'); active({ type: 'cancelled', id }) } }
    })
    for (const row of rows) {
      let message = row
      if (row.method !== undefined && row.id !== undefined) {
        const id = ++sequence; pending.set(id, { id: row.id, group, initialize }); group.ids.add(id); message = { ...row, id }; active({ type: 'started', id })
      }
      write(message)
    }
  } catch { if (response.headersSent) response.destroy(); else fail(response, 400) }
})
child.once('error', shutdown)
child.once('exit', code => { shutdown(); process.exitCode = code ?? 1 })
process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown)
server.listen(config.port, config.host, () => { process.stdout.write(JSON.stringify({ port: server.address().port }) + '\n') })
const decoder = new StringDecoder('utf8'); let text = ''
try {
  for await (const chunk of child.stdout) {
    text += decoder.write(chunk); let end
    while ((end = text.indexOf('\n')) !== -1) {
      const line = text.slice(0, end); text = text.slice(end + 1)
      if (Buffer.byteLength(line) > 16 * 1024 * 1024) throw Error('Large message')
      if (!line.trim()) continue
      const message = JSON.parse(line); active()
      const entry = message.method === undefined ? pending.get(message.id) : undefined
      if (!entry) { unsolicited(message); continue }
      pending.delete(message.id); entry.group.ids.delete(message.id)
      entry.group.completed.push({ type: 'completed', id: message.id, failed: !!message.error || message.result?.isError === true })
      if (entry.initialize) { initializePending = false; if (message.result) initialized = message }
      emit(entry.group.response, { ...message, id: entry.id })
      if (!entry.group.ids.size) { requests.delete(entry.group); entry.group.response.end() }
    }
    if (Buffer.byteLength(text) > 16 * 1024 * 1024) throw Error('Large message')
  }
} catch { shutdown() }
`
