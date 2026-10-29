import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CommunityAccountActor } from '../domain/community-account.js'
import type { InstanceResources } from '../use-cases/instance-resources.js'
import { assertCommunityOrigin, CommunityRequestError, readCommunityJson } from './community-request.js'
import { sendCommunityJson } from './community-errors.js'

export async function instanceResourceRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  actor: CommunityAccountActor,
  resources: InstanceResources,
  origin: URL,
): Promise<boolean> {
  if (url.pathname !== '/admin/api/instance-resources') return false
  if (request.method === 'GET') {
    if ([...url.searchParams.keys()].some(key => key !== 'username') || url.searchParams.getAll('username').length > 1) throw invalid()
    const username = url.searchParams.get('username')
    sendCommunityJson(response, 200, username === null ? await resources.settings(actor) : await resources.member(actor, username))
  } else if (request.method === 'POST') {
    assertCommunityOrigin(request, origin)
    const input = (await readCommunityJson(request)) as { action?: string }
    if (!input || typeof input !== 'object') throw invalid()
    if (input.action === 'save-defaults') sendCommunityJson(response, 200, await resources.saveDefaults(actor, input))
    else if (input.action === 'save-member') sendCommunityJson(response, 200, await resources.saveMember(actor, input))
    else if (input.action === 'apply') sendCommunityJson(response, 200, await resources.apply(actor, input, origin))
    else throw invalid()
  } else sendCommunityJson(response, 405, { code: 'method-not-allowed', error: 'Method Not Allowed' })
  return true
}
function invalid() {
  return new CommunityRequestError(400, 'Review the instance resource request.', 'instance-resource-invalid')
}
