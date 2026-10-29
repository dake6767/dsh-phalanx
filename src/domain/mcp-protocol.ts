import type { CommunityMcpTemplate } from './admin-contract.js'
import type { McpService } from './mcp-service.js'
export interface McpCallMetadata {
  readonly method: string
  readonly tool?: string
  readonly id?: string | number | null
}
export class McpProtocolError extends Error {}
export function mcpRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Pure request admission retains only metadata, never arguments. A forbidden batch is rejected as a whole. */
export function inspectMcpRequest(value: unknown, disabled: readonly string[]) {
  const rows = Array.isArray(value) ? value : [value]
  if (rows.length === 0 || rows.length > 100) throw new McpProtocolError('Invalid JSON-RPC batch')
  const methods: McpCallMetadata[] = []
  let denied = false
  const ids = new Set<string>()
  for (const row of rows) {
    if (!mcpRecord(row) || row.jsonrpc !== '2.0' || (row.id !== undefined && typeof row.id !== 'string' && typeof row.id !== 'number' && row.id !== null))
      throw new McpProtocolError('Invalid JSON-RPC message')
    if (row.id !== undefined) {
      const id = JSON.stringify(row.id)
      if (ids.has(id)) throw new McpProtocolError('Duplicate JSON-RPC request id')
      ids.add(id)
    }
    // Bidirectional MCP may send client responses to server-initiated requests.
    if (row.method === undefined && ('result' in row || 'error' in row)) {
      methods.push({ method: 'response' })
      continue
    }
    if (typeof row.method !== 'string' || row.method.length > 128) throw new McpProtocolError('Invalid JSON-RPC method')
    if (row.method !== 'tools/call') {
      methods.push({ method: row.method, ...(row.id !== undefined ? { id: row.id as string | number | null } : {}) })
      continue
    }
    const tool = mcpRecord(row.params) ? row.params.name : undefined
    if (typeof tool !== 'string' || !tool || tool.length > 256) throw new McpProtocolError('Invalid tool name')
    methods.push({ method: row.method, tool, ...(row.id !== undefined ? { id: row.id as string | number | null } : {}) })
    denied ||= disabled.includes(tool)
  }
  const errors = rows
    .filter(row => mcpRecord(row) && row.id !== undefined)
    .map(row => ({
      jsonrpc: '2.0',
      id: (row as Record<string, unknown>).id,
      error: { code: -32602, message: 'An administrator has disabled a requested tool. This request was not forwarded.' },
    }))
  return {
    methods,
    denied,
    error: Array.isArray(value)
      ? errors
      : (errors[0] ?? { jsonrpc: '2.0', id: null, error: { code: -32602, message: 'This tool is disabled by an administrator.' } }),
  }
}

/** Filter list replies in JSON or SSE envelopes, including resumed/batched responses. */
export function filterMcpResponse(value: unknown, disabled: readonly string[], credential: string | readonly string[]): unknown {
  if (Array.isArray(value)) return value.map(row => filterMcpResponse(row, disabled, credential))
  if (!mcpRecord(value)) return redactMcpValue(value, credential)
  let next = value
  if (value.jsonrpc === '2.0' && mcpRecord(value.result) && Array.isArray(value.result.tools))
    next = {
      ...value,
      result: { ...value.result, tools: value.result.tools.filter(tool => mcpRecord(tool) && typeof tool.name === 'string' && !disabled.includes(tool.name)) },
    }
  return redactMcpValue(next, credential)
}
export function redactMcpValue(value: unknown, credential: string | readonly string[]): unknown {
  const secrets = typeof credential === 'string' ? [credential] : credential
  const patterns = [
    ...new Set(
      secrets
        .filter(Boolean)
        .flatMap(secret => [
          secret,
          encodeURIComponent(secret),
          new URLSearchParams({ key: secret }).toString().slice(4),
          JSON.stringify(secret).slice(1, -1),
          JSON.stringify(secret).slice(1, -1).replaceAll('/', '\\/'),
        ]),
    ),
  ].sort((a, b) => b.length - a.length)
  if (!patterns.length) return value
  const expression = new RegExp(patterns.map(pattern => pattern.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|'), 'gu')
  return redactMcpFields(value, expression)
}
/** Recursive worker stays self-contained when embedded in the member wrapper. */
export function redactMcpFields(value: unknown, expression: RegExp): unknown {
  if (typeof value === 'string') return value.replace(expression, '[redacted]')
  if (Array.isArray(value)) return value.map(row => redactMcpFields(row, expression))
  if (mcpRecord(value))
    return Object.fromEntries(Object.entries(value).map(([key, row]) => [String(redactMcpFields(key, expression)), redactMcpFields(row, expression)]))
  return value
}

export function mcpCredentialTarget(service: {
  url: string
  credential?: string
  credentials?: Readonly<Record<string, string>>
  headers?: readonly CommunityMcpTemplate[]
  query?: readonly CommunityMcpTemplate[]
}) {
  const url = new URL(service.url),
    credential = service.credential ?? ''
  for (const row of service.query ?? []) url.searchParams.set(row.name, mcpTemplateValue(row.value, service))
  return { baseUrl: url.href, credential, headers: (service.headers ?? []).map(row => ({ ...row, value: mcpTemplateValue(row.value, service) })) }
}

export function mcpTemplateValue(value: string, service: { credential?: string; credentials?: Readonly<Record<string, string>> }): string {
  return value.replace(/\{credential(?::([A-Za-z][A-Za-z0-9_-]{0,63}))?\}/gu, (_match, name: string | undefined) =>
    name ? (service.credentials && Object.hasOwn(service.credentials, name) ? service.credentials[name]! : '') : (service.credential ?? ''),
  )
}
export function mcpSecrets(
  service: Partial<
    Pick<McpService, 'credential' | 'credentials' | 'headers' | 'query' | 'run' | 'url' | 'catalogUpdate' | 'protectedValues' | 'protectedCredentials'>
  >,
): readonly string[] {
  const templates = [...(service.headers ?? []), ...(service.query ?? []), ...(service.run?.env ?? [])]
  let query: string[] = []
  try {
    query = [...new URL(service.url ?? '').searchParams.values()]
  } catch {
    /* Process services need no remote URL. */
  }
  return [
    ...new Set(
      [
        service.credential ?? '',
        ...Object.values(service.credentials ?? {}),
        ...(service.protectedValues ?? []),
        ...(service.protectedCredentials ?? []),
        ...query,
        ...templates.flatMap(row => [row.value, mcpTemplateValue(row.value, service)]),
        ...(service.catalogUpdate?.candidate ? mcpSecrets(service.catalogUpdate.candidate) : []),
      ].filter(Boolean),
    ),
  ]
}
