import type { UsageMember } from '../domain/usage-record.js'
import type { UsagePolicy } from '../use-cases/usage-policy.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { CommunityModelAccessError } from '../domain/community-model.js'
import { BusinessRuleError } from '../domain/business-error.js'
import { PluginUpstreamTransportError } from '../domain/plugin-upstream.js'
import { filterMcpResponse, inspectMcpRequest, mcpCredentialTarget, mcpSecrets, mcpRecord, McpProtocolError, type McpCallMetadata } from '../domain/mcp-protocol.js'
import type { CommunityModelAuthorization } from '../use-cases/community-model-authorization.js'
import type { McpServices } from '../use-cases/mcp-services.js'
import type { PluginUpstreamTransportPort } from '../ports/plugin-upstreams.js'
import type { SessionRegistryPort } from '../ports/session-registry.js'
import { CommunityRequestError, readCommunityJson } from './community-request.js'
import type { McpSharedRuntimePort } from '../ports/mcp-shared-runtime.js'
import type { McpWirePort } from '../ports/mcp-wire.js'
import { downstreamAbort, pipeUpstreamBody } from './upstream-stream.js'

/** Every MCP exchange uses current access from all holding sources; administrator diagnostics can only initialize and discover tools. */
export function createMcpGateway(deps: { authorization: Pick<CommunityModelAuthorization, 'authorize'>,
  services: Pick<McpServices, 'effective'> & Partial<Pick<McpServices, 'diagnostic' | 'accessible'>>, transport: PluginUpstreamTransportPort,
  usage?: Pick<UsagePolicy, 'begin'>, shared?: McpSharedRuntimePort, sharedTransport?: PluginUpstreamTransportPort, wire: McpWirePort, connections: Pick<SessionRegistryPort, 'track' | 'untrack'> }) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const { controller, cleanup } = downstreamAbort(request, response)
    const attempts: { metadata: McpCallMetadata, attempt: ReturnType<UsagePolicy['begin']> }[] = []
    let member: UsageMember | undefined, policyDenied = false, failureReason: 'transport' | 'cancelled' | undefined
    const toolErrors = new Map<string, boolean>()
    const results = new Map<string, 'success' | 'failed'>(), admittedIds = new Set<string>()
    let username: string | undefined, name: string | undefined, methods: readonly McpCallMetadata[] = [], status: 'success' | 'failed' | 'denied' = 'failed'
    try {
      const match = /^\/mcp(-test)?\/(p-[A-Za-z0-9_-]{1,30})(?:\?generation=[1-9][0-9]*)?$/u.exec(request.url ?? '')
      if (!match) { failure(response, 404); return }
      name = match[2]!; const diagnostic = Boolean(match[1])
      if (!['POST', 'GET', 'DELETE'].includes(request.method ?? '')) { failure(response, 405); return }
      const authHeaders = request.rawHeaders.filter((_value, index) => index % 2 === 0 && request.rawHeaders[index]!.toLowerCase() === 'authorization')
      const token = authHeaders.length === 1 ? /^Bearer ([A-Za-z0-9_-]+)$/u.exec(request.headers.authorization ?? '')?.[1] : undefined
      const authorize = (initial = false) => {
        username = deps.authorization.authorize(token, initial ? identity => { member = identity } : undefined)
        const service = diagnostic ? deps.services.diagnostic?.(username, name!) : (deps.services.accessible?.(username) ?? deps.services.effective(username)).find(row => row.name === name)
        if (!service) throw new CommunityModelAccessError('forbidden')
        return service
      }
      let service: ReturnType<typeof authorize> | undefined, accessError: unknown
      try { service = authorize(true) }
      catch (error) { if (!member || request.method !== 'POST') throw error; accessError = error }
      deps.connections.track(member?.username ?? username!, request.socket)
      let body: unknown
      if (request.method === 'POST') {
        let inspected: ReturnType<typeof inspectMcpRequest>
        try { body = await readCommunityJson(request, 16 * 1024 * 1024); inspected = inspectMcpRequest(body, diagnostic ? [] : service?.disabledTools ?? []) }
        catch (error) { throw accessError ?? error }
        methods = inspected.methods
        if (member && deps.usage) for (const metadata of methods) if (metadata.method === 'tools/call') attempts.push({ metadata, attempt: deps.usage.begin(member, { kind: 'mcp', id: name, operation: metadata.tool! }) })
        if (accessError) throw accessError
        service = authorize()
        for (const row of methods) if (row.id !== undefined) admittedIds.add(JSON.stringify(row.id))
        if (diagnostic && methods.some(row => !['initialize', 'notifications/initialized', 'tools/list', 'ping'].includes(row.method))) throw new CommunityModelAccessError('forbidden')
        if (attempts.some(row => !row.attempt.allowed)) {
          policyDenied = true; status = 'denied'
          const replies = methods.filter(row => row.id !== undefined).map(row => ({ jsonrpc: '2.0', id: row.id, ...(row.method === 'tools/call' ? { result: { isError: true, content: [{ type: 'text', text: 'This use is not allowed.' }], code: 'usage-not-allowed' } } : { error: { code: -32600, message: 'This request batch was not forwarded.' } }) }))
          response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(Array.isArray(body) ? replies : replies[0] ?? { jsonrpc: '2.0', id: null, result: { isError: true, content: [{ type: 'text', text: 'This use is not allowed.' }], code: 'usage-not-allowed' } })); return
        }
        if (inspected.denied) {
          status = 'denied'; response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(inspected.error)); return
        }
      } else methods = [{ method: request.method! }]
      if (!service) throw new CommunityModelAccessError('forbidden')
      const headers = { ...request.headers, 'content-type': 'application/json', 'accept-encoding': 'identity' }
      delete headers['content-length']
      if (service.run?.location === 'shared') delete headers.origin
      const target = service.run?.location === 'shared' ? await deps.shared?.connect(username!, service, diagnostic) : { name, ...mcpCredentialTarget(service) }
      if (!target) throw new CommunityModelAccessError('forbidden')
      const admitted = authorize()
      // Starting/recovering a carrier can outlive a concurrent administrative edit.
      if (service.run?.location === 'shared' && admitted.generation !== service.generation) { failure(response, 404); return }
      if (body !== undefined) {
        const inspected = inspectMcpRequest(body, diagnostic ? [] : admitted.disabledTools ?? [])
        if (inspected.denied) {
          status = 'denied'; response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(inspected.error)); return
        }
      }
      const transport = service.run?.location === 'shared' ? deps.sharedTransport ?? deps.transport : deps.transport
      const upstream = await transport.send({ headerMode: 'literal', upstream: target, path: null, method: request.method!, headers,
        body: new Blob(body === undefined ? [] : [JSON.stringify(body)]).stream(), signal: controller.signal })
      try { authorize() } catch (error) { controller.abort(); await upstream.body?.cancel(); throw error }
      if (controller.signal.aborted) { await upstream.body?.cancel(); return }
      if (!upstream.ok) { await upstream.body?.cancel(); failure(response, upstream.status); return }
      const filtered = deps.wire.filter(upstream, value => {
        const current = authorize()
        const rows = Array.isArray(value) ? value : [value]
        for (const row of rows) if (mcpRecord(row) && row.id !== undefined && admittedIds.has(JSON.stringify(row.id)) && mcpRecord(row.result) && !toolErrors.has(JSON.stringify(row.id))) toolErrors.set(JSON.stringify(row.id), row.result.isError === true)
        for (const row of rows) if (mcpRecord(row) && row.id !== undefined && admittedIds.has(JSON.stringify(row.id)) && !results.has(JSON.stringify(row.id)) && ('result' in row || 'error' in row)) results.set(JSON.stringify(row.id), 'error' in row || mcpRecord(row.result) && row.result.isError === true ? 'failed' : 'success')
        // Also mask the credential used for this in-flight request after rotation.
        return filterMcpResponse(value, diagnostic ? [] : current.disabledTools ?? [], [...mcpSecrets(service), ...mcpSecrets(current)])
      })
      response.writeHead(filtered.status, { ...Object.fromEntries(filtered.headers), 'cache-control': 'no-store' })
      // Socket idle timeout observes raw bytes, including partial SSE records and heartbeat comments.
      const completed = await pipeUpstreamBody(response, filtered.body, controller)
      status = upstream.ok && completed ? 'success' : 'failed'
    } catch (error) {
      if (error instanceof CommunityModelAccessError || error instanceof BusinessRuleError && error.kind === 'forbidden') status = 'denied'
      else failureReason = controller.signal.aborted ? 'cancelled' : 'transport'
      controller.abort()
      if (response.destroyed) return
      if (response.headersSent) { response.destroy(); return }
      failure(response, error instanceof CommunityModelAccessError ? error.kind === 'unauthenticated' ? 401 : 403
        : error instanceof BusinessRuleError ? error.kind === 'forbidden' ? 403 : 404
          : error instanceof CommunityRequestError ? error.status : error instanceof McpProtocolError ? 400 : error instanceof PluginUpstreamTransportError ? error.status : 502)
    } finally {
      cleanup(); deps.connections.untrack(request.socket)
      try {
        for (const { metadata, attempt } of attempts) attempt.finish({ outcome: status === 'denied' ? 'denied' : status === 'success' && metadata.id !== undefined && results.get(JSON.stringify(metadata.id)) === 'success' ? 'succeeded' : 'failed', httpStatus: response.statusCode, ...(metadata.id !== undefined && toolErrors.has(JSON.stringify(metadata.id)) ? { isError: toolErrors.get(JSON.stringify(metadata.id))! } : {}), ...(status === 'denied' ? { reason: policyDenied ? 'policy' as const : 'access' as const } : failureReason ? { reason: failureReason } : controller.signal.aborted ? { reason: 'cancelled' as const } : {}) })
      } catch { console.warn('Usage record could not be saved') }
    }
  }
}
function failure(response: ServerResponse, status: number): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  response.end(JSON.stringify({ error: status === 401 ? 'MCP authentication required' : status === 403 ? 'MCP service is not enabled for this member' : 'MCP service unavailable' }))
}
