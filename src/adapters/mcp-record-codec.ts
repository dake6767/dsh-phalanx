import type { McpService, McpState } from '../domain/mcp-service.js'
import { redactMcpValue } from '../domain/mcp-protocol.js'

export interface McpProtectedField {
  readonly service: string
  readonly scope: string
  readonly field: string
}
const identity = ({ service, scope, field }: McpProtectedField) => JSON.stringify([service, scope, field])
export function mapMcpProtectedValues(
  service: McpService,
  visit: (scope: string, field: string, value: string, sensitive?: boolean) => string,
  scope = 'current',
): McpService {
  return {
    ...service,
    url: visit(scope, 'url', service.url, false),
    ...(service.protectedValues?.length
      ? { protectedValues: service.protectedValues.map((value, index) => visit(scope, 'protectedValues/' + index, value)) }
      : {}),
    ...(service.protectedCredentials?.length
      ? { protectedCredentials: service.protectedCredentials.map((value, index) => visit(scope, 'protectedCredentials/' + index, value)) }
      : {}),
    ...(service.catalogUpdate?.candidate
      ? { catalogUpdate: { ...service.catalogUpdate, candidate: mapMcpProtectedValues(service.catalogUpdate.candidate, visit, scope + '/candidate') } }
      : {}),
    ...(service.credential !== undefined ? { credential: visit(scope, 'credential', service.credential) } : {}),
    ...(service.credentials
      ? { credentials: Object.fromEntries(Object.entries(service.credentials).map(([name, value]) => [name, visit(scope, 'credentials/' + name, value)])) }
      : {}),
    ...(service.headers ? { headers: service.headers.map(row => ({ ...row, value: visit(scope, 'headers/' + row.name.toLowerCase(), row.value) })) } : {}),
    ...(service.query ? { query: service.query.map(row => ({ ...row, value: visit(scope, 'query/' + row.name, row.value) })) } : {}),
    ...(service.run
      ? {
          run: {
            ...service.run,
            command: visit(scope, 'run/command', service.run.command, false),
            args: service.run.args.map((value, index) => visit(scope, 'run/args/' + index, value, false)),
            ...(service.run.prepareCommand !== undefined ? { prepareCommand: visit(scope, 'run/prepareCommand', service.run.prepareCommand, false) } : {}),
            env: service.run.env.map(row => ({ ...row, value: visit(scope, 'env/' + row.name, row.value) })),
          },
        }
      : {}),
  }
}

/** Invalidate every protected slot and retained candidate after an explicit lost-key reset. */
export function resetMcpStateSecrets(state: McpState, fields: readonly McpProtectedField[]): McpState {
  const protectedFields = new Set(fields.map(identity))
  const invalidate = (service: McpService, rootName: string, scope = 'current'): McpService => {
    if (service.generation >= Number.MAX_SAFE_INTEGER) throw Error('MCP generation is exhausted')
    const generation = service.generation + 1
    const { dependencyPromotion, dependencyTarget, ...retained } = service
    void dependencyPromotion
    void dependencyTarget
    return {
      ...retained,
      generation,
      testStatus: 'untested',
      ...(fields.some(field => field.service === rootName && field.scope === scope) ? { configurationRequired: true as const } : {}),
      protectedValues: [],
      protectedCredentials: [],
      ...(service.catalogUpdate
        ? {
            catalogUpdate: {
              ...service.catalogUpdate,
              status: 'failed',
              baseGeneration: generation,
              ...(service.catalogUpdate.candidate ? { candidate: invalidate(service.catalogUpdate.candidate, rootName, scope + '/candidate') } : {}),
            },
          }
        : {}),
    }
  }
  const services = state.services.map(service =>
    invalidate(
      mapMcpProtectedValues(service, (scope, field, value) => (protectedFields.has(identity({ service: service.name, scope, field })) ? '' : value)),
      service.name,
    ),
  )
  const revision = Math.max(state.revision ?? 0, ...services.map(service => service.generation))
  if (!Number.isSafeInteger(revision)) throw Error('MCP revision is exhausted')
  return { ...state, revision, services }
}

export function encodeMcpRecord(service: McpService, known: readonly string[]) {
  const fields: McpProtectedField[] = []
  const secrets: { position: McpProtectedField; value: string }[] = []
  const metadata = mapMcpProtectedValues(service, (scope, field, value, sensitive = true) => {
    if (!value) return value
    let fallback = sensitive ? '' : String(redactMcpValue(value, known))
    if (field === 'url') {
      try {
        const url = new URL(value)
        if (!url.search) fallback = String(redactMcpValue(value, known))
        else {
          for (const name of [...url.searchParams.keys()]) url.searchParams.set(name, '')
          fallback = String(redactMcpValue(url.href, known))
        }
      } catch {
        /* Shared services can use an empty URL. */
      }
    }
    if (!sensitive && fallback === value) return value
    const position = { service: service.name, scope, field }
    fields.push(position)
    secrets.push({ position, value })
    return fallback
  })
  return { metadata, fields, secrets }
}
