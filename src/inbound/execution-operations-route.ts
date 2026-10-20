import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CommunityAccountActor } from '../domain/community-account.js'
import type { CommunityExecutionLimits } from '../domain/admin-contract.js'
import type { ExecutionOperations } from '../use-cases/execution-operations.js'
import { assertCommunityOrigin, readCommunityJson } from './community-request.js'
import { sendCommunityJson } from './community-errors.js'

export async function executionOperationsRoute(request: IncomingMessage, response: ServerResponse, url: URL, actor: CommunityAccountActor, operations: ExecutionOperations, origin: URL): Promise<boolean> {
  if (!['/admin/api/execution/settings', '/admin/api/execution/trial'].includes(url.pathname)) return false
  if (request.method === 'GET' && url.pathname.endsWith('/settings')) sendCommunityJson(response, 200, operations.settings(actor))
  else if (request.method === 'POST') {
    assertCommunityOrigin(request, origin)
    if (url.pathname.endsWith('/settings')) sendCommunityJson(response, 200, operations.save(actor, await readCommunityJson(request) as CommunityExecutionLimits))
    else {
      const input = await readCommunityJson(request) as { owner: string, line: string }
      const controller = new AbortController(), cancel = () => controller.abort()
      response.once('close', cancel)
      try { sendCommunityJson(response, 200, await operations.trial(actor, input?.owner, input?.line, controller.signal)) }
      finally { response.removeListener('close', cancel) }
    }
  } else sendCommunityJson(response, 405, { code: 'method-not-allowed', error: 'Method Not Allowed' })
  return true
}
