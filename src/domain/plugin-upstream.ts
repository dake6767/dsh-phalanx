import type { CommunityPluginUpstreamInput } from './admin-contract.js'
import { BusinessRuleError } from './business-error.js'

export interface PluginUpstream extends Omit<CommunityPluginUpstreamInput, 'credential'> { readonly credential: string }
export class PluginUpstreamAccessError extends Error {
  constructor(readonly status: 401 | 403 | 404 | 503, message: string) { super(message) }
}
export const PLUGIN_BODY_LIMIT = 64 * 1024 * 1024
export const PLUGIN_TIMEOUT_MS = 600_000
export const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'])
export function upstreamInput(input: CommunityPluginUpstreamInput): void {
  const invalid = () => new BusinessRuleError('invalid', 'Invalid plugin upstream name, address, credential or headers', 'plugin-upstream-invalid')
  if (!input || typeof input !== 'object' || typeof input.name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u.test(input.name)
    || typeof input.baseUrl !== 'string' || (input.credential !== undefined && (typeof input.credential !== 'string' || /[^\x20-\x7e]/u.test(input.credential)))) throw invalid()
  let url: URL
  try { url = new URL(input.baseUrl) } catch { throw invalid() }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw invalid()
  if (!Array.isArray(input.headers) || input.headers.length > 32) throw invalid()
  const seen = new Set<string>()
  for (const header of input.headers) {
    if (!header || typeof header.name !== 'string' || typeof header.value !== 'string' || !/^[!#$%&'*+.^_`|~\da-z-]+$/iu.test(header.name)
      || /[^\x20-\x7e]/u.test(header.value)) throw invalid()
    const name = header.name.toLowerCase()
    if (seen.has(name) || HOP_HEADERS.has(name) || name.startsWith('proxy-') || ['host', 'content-length', 'expect', 'set-cookie'].includes(name)) throw invalid()
    seen.add(name)
  }
}

export class PluginUpstreamTransportError extends Error {
  constructor(readonly status: 413 | 502 | 504, message: string) { super(message) }
}
