import type { CommunityMcpService, CommunityMcpInput, CommunityMcpTemplate, CommunityMcpTool, CommunityMcpSettings } from './admin-contract.js'
import { HOP_HEADERS } from './plugin-upstream.js'
import { BusinessRuleError } from './business-error.js'

export interface McpService extends CommunityMcpService {
  readonly generation: number
  readonly credential?: string
  readonly headers?: readonly CommunityMcpTemplate[]
  readonly query?: readonly CommunityMcpTemplate[]
  readonly disabledTools?: readonly string[]
  readonly tools?: readonly CommunityMcpTool[]
  readonly testStatus?: 'untested' | 'passed' | 'failed'
}
export function mcpSettings(service: McpService): CommunityMcpSettings {
  return { name: service.name, description: service.description, url: service.url, credentialConfigured: Boolean(service.credential), headers: service.headers ?? [], query: service.query ?? [], disabledTools: service.disabledTools ?? [], tools: service.tools ?? [], testStatus: service.testStatus ?? 'untested' }
}
export interface McpState {
  readonly revision?: number
  readonly services: readonly McpService[]
  readonly grants: Readonly<Record<string, readonly string[]>>
}
export function validateMcpService(value: CommunityMcpService): void {
  const invalid = () => new BusinessRuleError('invalid', 'Use a p- prefixed name of 3–32 letters, digits, underscores or hyphens and an HTTP address.', 'mcp-service-invalid')
  if (!value || typeof value !== 'object' || typeof value.name !== 'string' || !/^p-[A-Za-z0-9_-]{1,30}$/u.test(value.name)
    || typeof value.description !== 'string' || value.description.length > 4000 || typeof value.url !== 'string') throw invalid()
  let url: URL
  try { url = new URL(value.url) } catch { throw invalid() }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw invalid()
}

export function validateMcpSettings(value: CommunityMcpInput): void {
  validateMcpService(value)
  const invalid = () => new BusinessRuleError('invalid', 'Invalid MCP credential, templates or disabled tools.', 'mcp-service-invalid')
  if (value.credential !== undefined && (typeof value.credential !== 'string' || value.credential.length > 16384 || /[^\x20-\x7e]/u.test(value.credential))) throw invalid()
  for (const [kind, rows] of [['headers', value.headers], ['query', value.query]] as const) {
    if (rows === undefined) continue
    if (!Array.isArray(rows) || rows.length > 32) throw invalid()
    const seen = new Set<string>()
    for (const row of rows) {
      if (!row || typeof row.name !== 'string' || typeof row.value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/u.test(row.name) || row.value.length > 16384 || /[^\x20-\x7e]/u.test(row.value)) throw invalid()
      const name = kind === 'headers' ? row.name.toLowerCase() : row.name
      if (seen.has(name) || (kind === 'headers' && (HOP_HEADERS.has(name) || name.startsWith('proxy-') || ['host', 'content-length', 'content-type', 'accept', 'accept-encoding', 'expect', 'cookie', 'set-cookie', 'mcp-session-id', 'mcp-protocol-version'].includes(name)))) throw invalid()
      seen.add(name)
    }
  }
  if (value.disabledTools !== undefined && (!Array.isArray(value.disabledTools) || value.disabledTools.length > 10000 || value.disabledTools.some(name => typeof name !== 'string' || !name || name.length > 256))) throw invalid()
}
