import type { McpCatalogImports } from '../use-cases/mcp-catalog-imports.js'
import type { McpConnectionTest } from '../use-cases/mcp-connection-test.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CommunityAccountActor } from '../domain/community-account.js'
import type { CommunityMcpInput } from '../domain/admin-contract.js'
import type { McpServices } from '../use-cases/mcp-services.js'
import { assertCommunityOrigin, CommunityRequestError, readCommunityJson } from './community-request.js'
import { sendCommunityJson } from './community-errors.js'

export async function mcpAdminRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  actor: CommunityAccountActor,
  services: McpServices,
  origin: URL,
  test?: McpConnectionTest,
  imports?: McpCatalogImports,
): Promise<boolean> {
  const group = /^\/admin\/api\/groups\/([^/]+)\/mcp$/u.exec(url.pathname)
  const testing = url.pathname === '/admin/api/mcp/test'
  const updating = url.pathname === '/admin/api/mcp/catalog/update'
  if (updating) {
    if (request.method === 'GET') {
      sendCommunityJson(response, 200, await services.catalogUpdatePreview(actor, url.searchParams.get('name') ?? ''))
      return true
    }
    if (request.method !== 'POST') {
      sendCommunityJson(response, 405, { code: 'method-not-allowed' })
      return true
    }
    assertCommunityOrigin(request, origin)
    const value = (await readCommunityJson(request, 32 * 1024)) as import('../domain/admin-contract.js').CommunityMcpCatalogUpdateInput
    if (!imports) throw new CommunityRequestError(400, 'Invalid MCP update', 'mcp-service-invalid')
    await imports.update(actor, value)
    sendCommunityJson(response, 202, await services.list(actor))
    return true
  }
  const catalog = url.pathname === '/admin/api/mcp/catalog'
  if (catalog) {
    if (request.method === 'GET') {
      sendCommunityJson(response, 200, await services.catalog(actor))
      return true
    }
    if (request.method !== 'POST') {
      sendCommunityJson(response, 405, { code: 'method-not-allowed' })
      return true
    }
    assertCommunityOrigin(request, origin)
    const value = (await readCommunityJson(request, 32 * 1024)) as {
      action?: string
      input?: import('../domain/admin-contract.js').CommunityMcpCatalogInput
      name?: string
    }
    if (!imports || !value || typeof value !== 'object') throw new CommunityRequestError(400, 'Invalid MCP import', 'mcp-service-invalid')
    if (value.action === 'import' && value.input) await imports.import(actor, value.input)
    else if (value.action === 'retry' && typeof value.name === 'string') await imports.retry(actor, value.name)
    else throw new CommunityRequestError(400, 'Invalid MCP import', 'mcp-service-invalid')
    sendCommunityJson(response, 202, await services.list(actor))
    return true
  }
  if (url.pathname !== '/admin/api/mcp' && !testing && !group) return false
  if (request.method === 'GET' && !testing) {
    sendCommunityJson(
      response,
      200,
      group
        ? await services.group(actor, group[1]!)
        : url.searchParams.has('impact')
          ? await services.removalImpact(actor, url.searchParams.get('impact')!)
          : await services.list(actor),
    )
    return true
  }
  if (request.method !== 'POST') {
    sendCommunityJson(response, 405, { error: 'Method Not Allowed', code: 'method-not-allowed' })
    return true
  }
  assertCommunityOrigin(request, origin)
  const value = (await readCommunityJson(request, 2 * 1024 * 1024)) as {
    originalName?: unknown
    create?: unknown
    action?: unknown
    published?: unknown
    service?: CommunityMcpInput
    name?: unknown
    names?: unknown
    revision?: unknown
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CommunityRequestError(400, 'Invalid MCP request', 'mcp-service-invalid')
  if (testing) {
    if (!test || typeof value.name !== 'string') throw new CommunityRequestError(400, 'Invalid MCP test', 'mcp-service-invalid')
    sendCommunityJson(response, 200, await test.execute(actor, value.name))
    return true
  }
  if (group && Array.isArray(value.names) && value.names.every(name => typeof name === 'string')) {
    await services.grant(actor, group[1]!, value.names as string[])
    sendCommunityJson(response, 200, await services.group(actor, group[1]!))
    return true
  }
  if (
    !group &&
    value.action === 'save' &&
    value.service &&
    (value.create === undefined || typeof value.create === 'boolean') &&
    (value.originalName === undefined || typeof value.originalName === 'string')
  )
    await services.save(actor, value.service, value.create, value.originalName)
  else if (!group && value.action === 'publish' && typeof value.name === 'string' && typeof value.published === 'boolean')
    await services.publish(actor, value.name, value.published)
  else if (!group && value.action === 'prepare' && typeof value.name === 'string') await services.reprepare(actor, value.name)
  else if (!group && value.action === 'remove' && typeof value.name === 'string' && (value.revision === undefined || typeof value.revision === 'string'))
    await services.remove(actor, value.name, value.revision)
  else throw new CommunityRequestError(400, 'Invalid MCP request', 'mcp-service-invalid')
  sendCommunityJson(response, 200, await services.list(actor))
  return true
}
