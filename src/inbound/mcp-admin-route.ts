import type { McpConnectionTest } from '../use-cases/mcp-connection-test.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CommunityAccountActor } from '../domain/community-account.js'
import type { CommunityMcpInput } from '../domain/admin-contract.js'
import type { McpServices } from '../use-cases/mcp-services.js'
import { assertCommunityOrigin, CommunityRequestError, readCommunityJson } from './community-request.js'
import { sendCommunityJson } from './community-errors.js'

export async function mcpAdminRoute(request: IncomingMessage, response: ServerResponse, url: URL, actor: CommunityAccountActor, services: McpServices, origin: URL, test?: McpConnectionTest): Promise<boolean> {
  const group = /^\/admin\/api\/groups\/([^/]+)\/mcp$/u.exec(url.pathname)
  const testing = url.pathname === '/admin/api/mcp/test'
  if (url.pathname !== '/admin/api/mcp' && !testing && !group) return false
  if (request.method === 'GET' && !testing) {
    sendCommunityJson(response, 200, group ? services.group(actor, group[1]!) : services.list(actor)); return true
  }
  if (request.method !== 'POST') { sendCommunityJson(response, 405, { error: 'Method Not Allowed', code: 'method-not-allowed' }); return true }
  assertCommunityOrigin(request, origin)
  const value = await readCommunityJson(request, 2 * 1024 * 1024) as { create?: unknown, action?: unknown, service?: CommunityMcpInput, name?: unknown, names?: unknown }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CommunityRequestError(400, 'Invalid MCP request', 'mcp-service-invalid')
  if (testing) {
    if (!test || typeof value.name !== 'string') throw new CommunityRequestError(400, 'Invalid MCP test', 'mcp-service-invalid')
    sendCommunityJson(response, 200, await test.execute(actor, value.name)); return true
  }
  if (group && Array.isArray(value.names) && value.names.every(name => typeof name === 'string')) {
    await services.grant(actor, group[1]!, value.names as string[])
    sendCommunityJson(response, 200, services.group(actor, group[1]!)); return true
  }
  if (!group && value.action === 'save' && value.service && (value.create === undefined || typeof value.create === 'boolean')) await services.save(actor, value.service, value.create)
  else if (!group && value.action === 'remove' && typeof value.name === 'string') await services.remove(actor, value.name)
  else throw new CommunityRequestError(400, 'Invalid MCP request', 'mcp-service-invalid')
  sendCommunityJson(response, 200, services.list(actor)); return true
}
