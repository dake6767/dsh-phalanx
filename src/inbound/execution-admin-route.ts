import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CommunityAccountActor } from '../domain/community-account.js'
import type { CommunityExecutionInput } from '../domain/admin-contract.js'
import type { ExecutionAdministration } from '../use-cases/execution-administration.js'
import { assertCommunityOrigin, readCommunityJson } from './community-request.js'
import { sendCommunityJson } from './community-errors.js'

export async function executionAdminRoute(request: IncomingMessage, response: ServerResponse, url: URL, actor: CommunityAccountActor, administration: ExecutionAdministration, origin: URL): Promise<boolean> {
  if (!['/admin/api/skills/execution', '/admin/api/skills/execution/prepare'].includes(url.pathname)) return false
  const owner = 'skill:' + (url.searchParams.get('name') ?? '')
  if (request.method === 'GET') sendCommunityJson(response, 200, await administration.view(actor, owner))
  else if (request.method === 'POST') {
    assertCommunityOrigin(request, origin)
    sendCommunityJson(response, 200, url.pathname.endsWith('/prepare') ? await administration.reprepare(actor, owner) : await administration.save(actor, owner, await readCommunityJson(request) as CommunityExecutionInput))
  } else sendCommunityJson(response, 405, { code: 'method-not-allowed', error: 'Method Not Allowed' })
  return true
}
