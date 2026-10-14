import { MAX_EXECUTION_TIMEOUT_SECONDS } from './execution-control.js'
import type { CommunityMcpService, CommunityMcpInput, CommunityMcpTemplate, CommunityMcpTool, CommunityMcpSettings } from './admin-contract.js'
import { HOP_HEADERS } from './plugin-upstream.js'
import { BusinessRuleError } from './business-error.js'

export interface McpService extends CommunityMcpService {
  readonly catalog?: import('./admin-contract.js').CommunityMcpCatalogSource
  readonly catalogRequestId?: string
  readonly preparationName?: string
  readonly catalogUpdate?: {
    readonly name: string
    readonly requestId: string
    readonly version: string
    readonly testedPreparation?: string
    readonly baseGeneration: number
    readonly actor: import('./community-account.js').CommunityAccountActor
    readonly status: 'preparing' | 'testing' | 'failed' | 'applied'
    readonly candidate?: McpService | undefined
  }
  readonly dependencyName?: string
  readonly dependencyTarget?: string
  readonly dependencyPromotion?: { readonly from: string, readonly to: string }
  readonly prepared?: { readonly directory: string, readonly dependencies?: readonly import('./runtime-dependency.js').RuntimeDependencyVersion[], readonly legacy?: boolean }
  readonly published?: boolean
  readonly required?: boolean
  readonly generation: number
  readonly credentials?: Readonly<Record<string, string>>
  readonly credential?: string
  readonly headers?: readonly CommunityMcpTemplate[]
  readonly query?: readonly CommunityMcpTemplate[]
  readonly disabledTools?: readonly string[]
  readonly tools?: readonly CommunityMcpTool[]
  readonly testStatus?: 'untested' | 'passed' | 'failed'
}
export function mcpSettings(service: McpService): CommunityMcpSettings {
  return { ...(service.catalogUpdate ? { catalogUpdate: { version: service.catalogUpdate.version, status: service.catalogUpdate.status } } : {}), ...(service.catalog ? { catalog: service.catalog } : {}), run: service.run ?? null, credentialNames: Object.keys(service.credentials ?? {}).filter(name => Boolean(service.credentials?.[name])), published: service.published ?? false, required: service.required ?? false, name: service.name, description: service.description, url: service.url, credentialConfigured: Boolean(service.credential), headers: service.headers ?? [], query: service.query ?? [], disabledTools: service.disabledTools ?? [], tools: service.tools ?? [], testStatus: service.testStatus ?? 'untested' }
}
export interface McpState {
  readonly catalogRequests?: readonly string[]
  readonly revision?: number
  readonly preferences?: Readonly<Record<string, Readonly<Record<string, boolean>>>>
  readonly selections?: Readonly<Record<string, readonly string[]>>
  readonly services: readonly McpService[]
  readonly grants: Readonly<Record<string, readonly string[]>>
}
export function validateMcpService(value: CommunityMcpService): void {
  const invalid = () => new BusinessRuleError('invalid', 'Use a p- prefixed name of 3–32 letters, digits, underscores or hyphens and an HTTP address.', 'mcp-service-invalid')
  if (!value || typeof value !== 'object' || typeof value.name !== 'string' || !/^p-[A-Za-z0-9_-]{1,30}$/u.test(value.name)
    || typeof value.description !== 'string' || value.description.length > 4000 || typeof value.url !== 'string') throw invalid()
  if (value.run != null) {
    const run = value.run
    if (!['shared', 'member'].includes(run.location) || typeof run.command !== 'string' || !run.command.trim() || run.command.length > 4096 || /[\r\n\0]/u.test(run.command) || !Array.isArray(run.args) || run.args.length > 128 || run.args.some(arg => typeof arg !== 'string' || arg.length > 16384 || arg.includes('\0')) || !Array.isArray(run.env) || (run.prepareCommand !== undefined && (typeof run.prepareCommand !== 'string' || run.prepareCommand.length > 32768)) || (run.runtimeDependencies !== undefined && (!Array.isArray(run.runtimeDependencies) || run.runtimeDependencies.some(name => typeof name !== 'string' || !name) || new Set(run.runtimeDependencies).size !== run.runtimeDependencies.length))) throw invalid()
    return
  }
  let url: URL
  try { url = new URL(value.url) } catch { throw invalid() }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw invalid()
}

export function validateMcpSettings(value: CommunityMcpInput): void {
  validateMcpService(value)
  const invalid = () => new BusinessRuleError('invalid', 'Invalid MCP credential, templates or disabled tools.', 'mcp-service-invalid')
  if (value.credentials !== undefined && (!value.credentials || typeof value.credentials !== 'object' || Array.isArray(value.credentials) || Object.entries(value.credentials).length > 32 || Object.entries(value.credentials).some(([name, secret]) => !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(name) || typeof secret !== 'string' || secret.length > 16384 || /[^\x20-\x7e]/u.test(secret)))) throw invalid()
  if (value.required !== undefined && typeof value.required !== 'boolean') throw invalid()
  if (value.credential !== undefined && (typeof value.credential !== 'string' || value.credential.length > 16384 || /[^\x20-\x7e]/u.test(value.credential))) throw invalid()
  for (const [kind, rows] of [['headers', value.headers], ['query', value.query], ['env', value.run?.env]] as const) {
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
  if (value.run?.location === 'member' && (value.credential || Object.values(value.credentials ?? {}).some(Boolean) || value.run.env.some(row => /\{credential(?::[^}]+)?\}/u.test(row.value)))) throw invalid()
  if (value.disabledTools !== undefined && (!Array.isArray(value.disabledTools) || value.disabledTools.length > 10000 || value.disabledTools.some(name => typeof name !== 'string' || !name || name.length > 256))) throw invalid()
}

// Shared execution owns per-call deadlines; outer clients leave room for recovery.
export const SHARED_MCP_REQUEST_CEILING_MS = MAX_EXECUTION_TIMEOUT_SECONDS * 1000 + 30_000
