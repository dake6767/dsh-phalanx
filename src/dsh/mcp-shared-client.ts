import { sharedMcpTransport } from './mcp-shared-transport.js'

/** The official DSH stdio seam delegates only to the member's authenticated gateway. */
export const memberSharedMcpClient = `
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { createInterface } from 'node:readline'
const config = JSON.parse(process.argv[2])
const require = createRequire(config.module)
const { StreamableHTTPClientTransport, SdkHttpError } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/client')))
const sharedMcpTransport = ${sharedMcpTransport.toString()}
const url = new URL(config.path, process.env.PHALANX_MCP_GATEWAY_URL)
const headers = { Authorization: 'Bearer ' + process.env.PHALANX_MCP_GATEWAY_TOKEN }
const transport = sharedMcpTransport(() => new StreamableHTTPClientTransport(url, {
  requestInit: { headers }, reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
}), error => error instanceof SdkHttpError && error.status === 404, event => process.stderr.write('Shared MCP: ' + event + '\\n'))
const write = message => process.stdout.write(JSON.stringify(message) + '\\n')
let initializeId, closing = false, handshake = Promise.resolve()
const handshakeAbort = new AbortController()
const pending = new Map()
transport.onmessage = message => {
  if (closing) return
  if (message.id !== undefined && !message.method) pending.delete(message.id)
  if (message.id === initializeId && typeof message.result?.protocolVersion === 'string') transport.setProtocolVersion(message.result.protocolVersion)
  write(message)
}
const stop = async () => { if (closing) return; closing = true; handshakeAbort.abort(); await transport.close(); process.stdin.destroy() }
process.once('SIGTERM', () => { void stop() }); process.once('SIGINT', () => { void stop() })
await transport.start()
try {
  for await (const line of createInterface({ input: process.stdin })) {
    if (Buffer.byteLength(line) > 16 * 1024 * 1024) throw Error('MCP message exceeds limit')
    if (!line.trim()) continue
    const message = JSON.parse(line)
    if (message.method === 'notifications/cancelled') pending.get(message.params?.requestId)?.abort()
    const abort = message.method && message.id !== undefined ? new AbortController() : undefined
    if (abort) pending.set(message.id, abort)
    if (message.method === 'initialize') initializeId = message.id
    const initialized = message.method === 'notifications/initialized'
    const sending = handshake.then(() => {
      if (closing || abort?.signal.aborted) return
      return transport.send(message, { requestSignal: initialized
        ? AbortSignal.any([handshakeAbort.signal, AbortSignal.timeout(30_000)]) : abort?.signal })
    }).catch(error => {
      if (abort) pending.delete(message.id)
      if (closing || abort?.signal.aborted) return
      const http = error instanceof SdkHttpError ? error : error.cause instanceof SdkHttpError ? error.cause : undefined
      const reason = http && [401, 403].includes(http.status) ? 'authorization-denied'
        : ['recovery-timeout', 'initialization-rejected'].includes(error.reason) ? error.reason
        : http?.status === 404 ? 'session-expired' : 'unknown-result'
      process.stderr.write('Shared MCP: ' + reason + '\\n')
      if (message.method && message.id !== undefined && !closing && !abort?.signal.aborted) write({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'Shared MCP: ' + reason + (reason === 'unknown-result' ? '. Do not automatically repeat the call.' : '. Retry only after the connection or access problem is resolved.') } })
    })
    // Preserve stdio handshake order across independent HTTP requests.
    if (initialized) handshake = sending
  }
} catch { process.stderr.write('Shared MCP transport failed.\\n') }
finally { await stop() }
`
