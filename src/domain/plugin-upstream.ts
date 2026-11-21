import type { CommunityPluginUpstreamInput, CommunityPluginUpstreamView } from './admin-contract.js'
import { BusinessRuleError } from './business-error.js'

export interface PluginUpstream extends Omit<CommunityPluginUpstreamInput, 'credential' | 'clearCredential'> {
  readonly credential: string
  readonly secretUnavailable?: true
  readonly nativeServiceOnly?: true
}

export function imageUpstreamReady(upstream: PluginUpstream | undefined): upstream is PluginUpstream & { readonly model: string } {
  return !!upstream?.baseUrl && /^[\x21-\x7e]+$/u.test(upstream.credential) && validUpstreamModel(upstream.model) && !upstream.secretUnavailable
}

function validUpstreamModel(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value && !/\p{Cc}/u.test(value)
}

export const managedImageUpstreamHeaders = [{ name: 'Authorization', value: 'Bearer {credential}' }] as const
export const managedImageUpstreamTest = { method: 'GET', path: '/models' } as const
/** Diagnostic input is protected even when it carries no separately declared credential. */
export function upstreamTestSecrets(request: NonNullable<PluginUpstream['testRequest']>): string[] {
  const values: string[] = []
  const collect = (value: unknown): void => {
    if (typeof value === 'string' && value) values.push(value)
    else if (Array.isArray(value)) value.forEach(collect)
    else if (value && typeof value === 'object')
      for (const [key, item] of Object.entries(value)) {
        collect(key)
        collect(item)
      }
  }
  collect(request.body)
  collect(request.path)
  const url = new URL(request.path, 'http://localhost')
  for (const value of url.searchParams.values()) collect(value)
  for (const pair of url.search.slice(1).split('&')) if (pair.includes('=')) collect(pair.slice(pair.indexOf('=') + 1))
  for (const value of url.pathname.split('/')) {
    try {
      collect(decodeURIComponent(value))
    } catch {
      collect(value)
    }
  }
  return values
}
/** A redacted read becomes a blank write, retaining saved values by name. */
export function upstreamWriteInput(row: CommunityPluginUpstreamView, declaration?: CommunityPluginUpstreamInput): CommunityPluginUpstreamInput {
  return {
    name: row.name,
    baseUrl: row.baseUrl,
    ...(row.model ? { model: row.model } : {}),
    headers: row.headers.map(header => ({
      name: header.name,
      value: header.configured ? '' : (declaration?.headers.find(value => value.name.toLowerCase() === header.name.toLowerCase())?.value ?? ''),
    })),
    ...(row.testRequest && !('configured' in row.testRequest) ? { testRequest: row.testRequest } : {}),
  }
}
export function mergeUpstreamInput(input: CommunityPluginUpstreamInput, prior?: PluginUpstream): PluginUpstream {
  upstreamInput(input)
  if (prior?.secretUnavailable && ((!input.credential && !input.clearCredential) || input.headers.some(header => !header.value))) {
    throw new BusinessRuleError('invalid', 'Replace the credential and all locked headers to repair this upstream', 'plugin-upstream-invalid')
  }
  const model = input.model ?? prior?.model
  return {
    name: input.name,
    baseUrl: input.baseUrl,
    ...(model === undefined ? {} : { model }),
    ...(prior?.nativeServiceOnly ? { nativeServiceOnly: true as const } : {}),
    headers: input.headers.map(header => ({
      name: header.name,
      value: header.value || prior?.headers.find(old => old.name.toLowerCase() === header.name.toLowerCase())?.value || '',
    })),
    credential: input.clearCredential ? '' : input.credential || prior?.credential || '',
    ...(input.testRequest !== undefined ? { testRequest: input.testRequest } : prior?.testRequest ? { testRequest: prior.testRequest } : {}),
  }
}
export function usesSharedPluginCredential(upstreams: readonly Pick<PluginUpstream, 'credential' | 'secretUnavailable'>[]): boolean {
  return upstreams.some(row => row.credential.length > 0 || row.secretUnavailable)
}
export class PluginUpstreamAccessError extends Error {
  constructor(
    readonly status: 401 | 403 | 404 | 503,
    message: string,
  ) {
    super(message)
  }
}
export const PLUGIN_BODY_LIMIT = 64 * 1024 * 1024
export const PLUGIN_TIMEOUT_MS = 600_000
export const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'])
export function upstreamInput(input: CommunityPluginUpstreamInput): void {
  const invalid = () => new BusinessRuleError('invalid', 'Invalid plugin upstream name, address, credential or headers', 'plugin-upstream-invalid')
  if (
    !input ||
    typeof input !== 'object' ||
    typeof input.name !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u.test(input.name) ||
    typeof input.baseUrl !== 'string' ||
    (input.model !== undefined && !validUpstreamModel(input.model)) ||
    (input.credential !== undefined && (typeof input.credential !== 'string' || /[^\x20-\x7e]/u.test(input.credential)))
  )
    throw invalid()
  if ((input.clearCredential !== undefined && typeof input.clearCredential !== 'boolean') || (input.clearCredential && input.credential)) throw invalid()
  let url: URL
  try {
    url = new URL(input.baseUrl)
  } catch {
    throw invalid()
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw invalid()
  if (!Array.isArray(input.headers) || input.headers.length > 32) throw invalid()
  if (input.testRequest !== undefined && input.testRequest !== null) {
    const test = input.testRequest
    if (
      typeof test !== 'object' ||
      typeof test.method !== 'string' ||
      !['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(test.method) ||
      typeof test.path !== 'string' ||
      !test.path.startsWith('/') ||
      test.path.startsWith('//') ||
      /[\s#\\]/u.test(test.path)
    )
      throw invalid()
    try {
      if (test.body !== undefined && JSON.stringify(test.body) === undefined) throw invalid()
    } catch {
      throw invalid()
    }
  }
  const seen = new Set<string>()
  for (const header of input.headers) {
    if (
      !header ||
      typeof header.name !== 'string' ||
      typeof header.value !== 'string' ||
      !/^[!#$%&'*+.^_`|~\da-z-]+$/iu.test(header.name) ||
      /[^\x20-\x7e]/u.test(header.value)
    )
      throw invalid()
    const name = header.name.toLowerCase()
    if (seen.has(name) || HOP_HEADERS.has(name) || name.startsWith('proxy-') || ['host', 'content-length', 'expect', 'set-cookie'].includes(name))
      throw invalid()
    seen.add(name)
  }
}

export class PluginUpstreamTransportError extends Error {
  constructor(
    readonly status: 413 | 502 | 504,
    message: string,
  ) {
    super(message)
  }
}
