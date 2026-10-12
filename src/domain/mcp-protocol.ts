import type { CommunityMcpTemplate } from './admin-contract.js'
export interface McpCallMetadata { readonly method: string, readonly tool?: string, readonly id?: string | number | null }
export class McpProtocolError extends Error {}
export function mcpRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }

/** Pure request admission retains only metadata, never arguments. A forbidden batch is rejected as a whole. */
export function inspectMcpRequest(value: unknown, disabled: readonly string[]) {
  const rows = Array.isArray(value) ? value : [value]
  if (rows.length === 0 || rows.length > 100) throw new McpProtocolError('Invalid JSON-RPC batch')
  const methods: McpCallMetadata[] = []
  let denied = false
  const ids = new Set<string>()
  for (const row of rows) {
    if (!mcpRecord(row) || row.jsonrpc !== '2.0' || (row.id !== undefined && typeof row.id !== 'string' && typeof row.id !== 'number' && row.id !== null)) throw new McpProtocolError('Invalid JSON-RPC message')
    if (row.id !== undefined) { const id = JSON.stringify(row.id); if (ids.has(id)) throw new McpProtocolError('Duplicate JSON-RPC request id'); ids.add(id) }
    // Bidirectional MCP may send client responses to server-initiated requests.
    if (row.method === undefined && ('result' in row || 'error' in row)) { methods.push({ method: 'response' }); continue }
    if (typeof row.method !== 'string' || row.method.length > 128) throw new McpProtocolError('Invalid JSON-RPC method')
    if (row.method !== 'tools/call') { methods.push({ method: row.method, ...(row.id !== undefined ? { id: row.id as string | number | null } : {}) }); continue }
    const tool = mcpRecord(row.params) ? row.params.name : undefined
    if (typeof tool !== 'string' || !tool || tool.length > 256) throw new McpProtocolError('Invalid tool name')
    methods.push({ method: row.method, tool, ...(row.id !== undefined ? { id: row.id as string | number | null } : {}) }); denied ||= disabled.includes(tool)
  }
  const errors = rows.filter(row => mcpRecord(row) && row.id !== undefined).map(row => ({ jsonrpc: '2.0', id: (row as Record<string, unknown>).id, error: { code: -32602, message: 'An administrator has disabled a requested tool. This request was not forwarded.' } }))
  return { methods, denied, error: Array.isArray(value) ? errors : errors[0] ?? { jsonrpc: '2.0', id: null, error: { code: -32602, message: 'This tool is disabled by an administrator.' } } }
}

/** Filter list replies in JSON or SSE envelopes, including resumed/batched responses. */
export function filterMcpResponse(value: unknown, disabled: readonly string[], credential: string): unknown {
  if (Array.isArray(value)) return value.map(row => filterMcpResponse(row, disabled, credential))
  if (!mcpRecord(value)) return redactMcpValue(value, credential)
  let next = value
  if (value.jsonrpc === '2.0' && mcpRecord(value.result) && Array.isArray(value.result.tools)) next = { ...value, result: { ...value.result, tools: value.result.tools.filter(tool => mcpRecord(tool) && typeof tool.name === 'string' && !disabled.includes(tool.name)) } }
  return redactMcpValue(next, credential)
}
export function redactMcpValue(value: unknown, credential: string): unknown {
  if (!credential) return value
  if (typeof value === 'string') {
    for (const pattern of new Set([credential, encodeURIComponent(credential), new URLSearchParams({ key: credential }).toString().slice(4)])) value = (value as string).replaceAll(pattern, '[redacted]')
    return value
  }
  if (Array.isArray(value)) return value.map(row => redactMcpValue(row, credential))
  if (mcpRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, row]) => [String(redactMcpValue(key, credential)), redactMcpValue(row, credential)]))
  return value
}
export function mcpCredentialTarget(service: { url: string, credential?: string, headers?: readonly CommunityMcpTemplate[], query?: readonly CommunityMcpTemplate[] }) {
  const url = new URL(service.url), credential = service.credential ?? ''
  for (const row of service.query ?? []) url.searchParams.set(row.name, row.value.replaceAll('{credential}', credential))
  return { baseUrl: url.href, credential, headers: service.headers ?? [] }
}
