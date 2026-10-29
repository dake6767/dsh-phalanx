import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CommunityAccountActor } from '../domain/community-account.js'
import type { CommunityMarketMcpAction } from '../domain/admin-contract.js'
import type { McpServices } from '../use-cases/mcp-services.js'
import { assertCommunityOrigin, CommunityRequestError, readCommunityJson } from './community-request.js'
import { sendCommunityJson } from './community-errors.js'

export async function mcpMarketRoute(
  request: IncomingMessage,
  response: ServerResponse,
  actor: CommunityAccountActor,
  services: McpServices,
  origin: URL,
): Promise<void> {
  if (request.method === 'GET') {
    sendCommunityJson(response, 200, await services.market(actor))
    return
  }
  if (request.method !== 'POST') {
    sendCommunityJson(response, 405, { code: 'method-not-allowed', error: 'Method Not Allowed' })
    return
  }
  assertCommunityOrigin(request, origin)
  const value = (await readCommunityJson(request)) as CommunityMarketMcpAction
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== 2 ||
    typeof value.name !== 'string' ||
    !['enable', 'disable'].includes(value.action)
  )
    throw new CommunityRequestError(400, 'Invalid MCP selection.', 'mcp-grant-invalid')
  await services.toggle(actor, value.name, value.action === 'enable')
  sendCommunityJson(response, 200, await services.market(actor))
}
