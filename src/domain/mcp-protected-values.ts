import type { McpService } from './mcp-service.js'
import { mcpSecrets, redactMcpValue } from './mcp-protocol.js'

type Connection = Partial<
  Pick<McpService, 'url' | 'credential' | 'credentials' | 'headers' | 'query' | 'run' | 'protectedValues' | 'protectedCredentials' | 'catalogUpdate'>
>

/** Named platform credentials retain their origin while any connection still references them. */
export function mcpPlatformCredentials(service: Connection): readonly string[] {
  return [
    ...new Set(
      [
        service.credential ?? '',
        ...Object.values(service.credentials ?? {}),
        ...(service.protectedCredentials ?? []),
        ...(service.catalogUpdate?.candidate ? mcpPlatformCredentials(service.catalogUpdate.candidate) : []),
      ].filter(Boolean),
    ),
  ]
}

/** Identify literal or encoded references without excluding current secret slots. */
export function referencedMcpSecrets(service: Connection, known: readonly string[]): readonly string[] {
  const values = [
    service.url ?? '',
    service.credential ?? '',
    ...Object.values(service.credentials ?? {}),
    ...[...(service.headers ?? []), ...(service.query ?? []), ...(service.run?.env ?? [])].map(row => row.value),
    service.run?.command ?? '',
    ...(service.run?.args ?? []),
    service.run?.prepareCommand ?? '',
  ]
  return [...new Set(known)].filter(secret => secret && values.some(value => redactMcpValue(value, [secret]) !== value))
}

/** Keep historical literals only while a connection field still references them. */
export function retainedMcpSecrets(service: Connection, known: readonly string[]): readonly string[] {
  const inherent = new Set(mcpSecrets({ ...service, protectedValues: [] }))
  return referencedMcpSecrets(service, known).filter(secret => !inherent.has(secret))
}

/** Storage normalizes each current/candidate scope before encrypting its retained literals. */
export function withRetainedMcpSecrets(service: McpService, known: readonly string[], platformCredentials: readonly string[]): McpService {
  const base = { ...service }
  delete base.protectedValues
  delete base.protectedCredentials
  const protectedValues = retainedMcpSecrets(service, known)
  const currentCredentials = new Set(mcpPlatformCredentials({ credential: service.credential ?? '', credentials: service.credentials ?? {} }))
  const protectedCredentials = referencedMcpSecrets(service, platformCredentials).filter(value => !currentCredentials.has(value))
  return {
    ...base,
    ...(protectedValues.length ? { protectedValues } : {}),
    ...(protectedCredentials.length ? { protectedCredentials } : {}),
    ...(service.catalogUpdate?.candidate
      ? { catalogUpdate: { ...service.catalogUpdate, candidate: withRetainedMcpSecrets(service.catalogUpdate.candidate, known, platformCredentials) } }
      : {}),
  }
}

export interface McpSecretContext {
  readonly known: readonly string[]
  readonly platformCredentials: readonly string[]
}

function sanitizeDisplay(service: McpService, known: readonly string[]): McpService {
  const display = redactMcpValue({ description: service.description, ...(service.tools ? { tools: service.tools } : {}) }, known) as Pick<
    McpService,
    'description' | 'tools'
  >
  return {
    ...structuredClone(service),
    ...display,
    ...(service.catalogUpdate?.candidate
      ? { catalogUpdate: { ...service.catalogUpdate, candidate: sanitizeDisplay(service.catalogUpdate.candidate, known) } }
      : {}),
  }
}

export function mcpSecretContext(services: readonly McpService[]): McpSecretContext {
  return { known: [...new Set(services.flatMap(mcpSecrets))], platformCredentials: [...new Set(services.flatMap(mcpPlatformCredentials))] }
}
export function normalizeMcpProtectedValues(service: McpService, context: McpSecretContext): McpService {
  return sanitizeDisplay(withRetainedMcpSecrets(service, context.known, context.platformCredentials), context.known)
}
