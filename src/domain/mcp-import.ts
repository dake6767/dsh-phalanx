import type { CommunityMcpInput, CommunityMcpTemplate } from './admin-contract.js'
import { mcpRecord } from './mcp-protocol.js'
import { validateMcpSettings } from './mcp-service.js'

export class McpImportError extends Error {
  constructor(readonly kind: 'json' | 'shape' | 'unknown' | 'conflict', readonly path: string) { super(`MCP import ${kind}: ${path}`) }
}
export interface McpImportDraft { readonly input: CommunityMcpInput, readonly credentialSources: readonly string[] }
const suspicious = (name: string, value: string) => /(?:key|token|secret|password|authorization|credential)/iu.test(name) || /^(?:Bearer |Basic |gh[pousr]_|github_pat_|sk-|ctx7sk|eyJ)/u.test(value)
/** Preview only: never execute commands, resolve local environment or persist pasted JSON. */
export function parseMcpServers(text: string): readonly McpImportDraft[] {
  let value: unknown
  if (text.length > 1024 * 1024) throw new McpImportError('shape', 'mcpServers')
  try { value = JSON.parse(text) } catch { throw new McpImportError('json', 'mcpServers') }
  if (!mcpRecord(value) || !mcpRecord(value.mcpServers) || !Object.keys(value.mcpServers).length || Object.keys(value.mcpServers).length > 100) throw new McpImportError('shape', 'mcpServers')
  for (const key of Object.keys(value)) if (key !== 'mcpServers') throw new McpImportError('unknown', key)
  return Object.entries(value.mcpServers).map(([name, row]) => parseServer(name, row))
}
function parseServer(name: string, row: unknown): McpImportDraft {
  const path = `mcpServers.${name}`
  if (!mcpRecord(row)) throw new McpImportError('shape', path)
  for (const key of Object.keys(row)) if (!['url', 'type', 'headers', 'command', 'args', 'env'].includes(key)) throw new McpImportError('unknown', path + '.' + key)
  const remote = typeof row.url === 'string'
  if ((remote && row.command !== undefined) || (!remote && typeof row.command !== 'string') || row.type !== undefined && !(remote ? ['http', 'sse', 'streamable-http'] : ['stdio']).includes(String(row.type))) throw new McpImportError('conflict', path)
  if (remote && (row.env !== undefined || row.args !== undefined) || !remote && row.headers !== undefined) throw new McpImportError('conflict', path)
  let credential: string | undefined
  const credentials: Record<string, string> = {}, credentialSources: string[] = []
  const move = (name: string, value: string, source: string) => {
    if (!suspicious(name, value) || !value) return value
    credentialSources.push(source)
    const prefix = /^(Bearer |Basic )/u.exec(value)?.[0] ?? '', secret = value.slice(prefix.length)
    if (credential === undefined || credential === secret) { credential = secret; return prefix + '{credential}' }
    const existing = Object.entries(credentials).find(([, current]) => current === secret)?.[0]
    const key = existing ?? 'imported' + (Object.keys(credentials).length + 1)
    credentials[key] = secret; return prefix + '{credential:' + key + '}'
  }
  const templates = (kind: 'headers' | 'env'): CommunityMcpTemplate[] => {
    const values = row[kind]
    if (values === undefined) return []
    if (!mcpRecord(values) || Object.values(values).some(value => typeof value !== 'string')) throw new McpImportError('shape', path + '.' + kind)
    return Object.entries(values).map(([name, value]) => ({ name, value: move(name, value as string, kind + '.' + name) }))
  }
  const headers = templates('headers'), env = templates('env'), query: CommunityMcpTemplate[] = []
  let url = ''
  if (remote) {
    let parsed: URL
    try { parsed = new URL(row.url as string) } catch { throw new McpImportError('shape', path + '.url') }
    for (const [name, value] of [...parsed.searchParams]) if (suspicious(name, value)) { query.push({ name, value: move(name, value, 'query.' + name) }); parsed.searchParams.delete(name) }
    url = parsed.href
  }
  if (row.args !== undefined && (!Array.isArray(row.args) || row.args.some(arg => typeof arg !== 'string'))) throw new McpImportError('shape', path + '.args')
  const input: CommunityMcpInput = { name: name.startsWith('p-') ? name : 'p-' + name, description: '', url, headers, query,
    ...(credential === undefined ? {} : { credential }), ...(Object.keys(credentials).length ? { credentials } : {}),
    run: remote ? null : { location: 'shared', command: row.command as string, args: row.args as string[] ?? [], env, prepareCommand: '' } }
  // Names remain editable in the confirmation form; all other fields use the save validator.
  validateMcpSettings({ ...input, name: 'p-preview' })
  return { input, credentialSources }
}
