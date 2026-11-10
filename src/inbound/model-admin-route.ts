import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CommunityAccountActor } from '../domain/community-account.js'
import type { CommunityModelAction } from '../domain/admin-contract.js'
import type { SharedModelAdministration } from '../use-cases/shared-model-administration.js'
import { assertCommunityOrigin, CommunityRequestError, readCommunityJson } from './community-request.js'
import { sendCommunityJson } from './community-errors.js'

export async function modelAdminRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  caller: CommunityAccountActor,
  models: SharedModelAdministration,
  origin: URL,
): Promise<boolean> {
  if (url.pathname !== '/admin/api/models') return false
  if (request.method === 'GET') {
    sendCommunityJson(response, 200, await models.list(caller))
    return true
  }
  if (request.method === 'POST') {
    assertCommunityOrigin(request, origin)
    const input = (await readCommunityJson(request)) as CommunityModelAction
    if (
      input === null ||
      typeof input !== 'object' ||
      !['save-provider', 'delete-provider', 'set-default'].includes(input.action) ||
      !Number.isSafeInteger(input.revision) ||
      (input.action === 'set-default' && typeof input.defaultModelId !== 'string') ||
      (input.action === 'delete-provider' && typeof input.providerId !== 'string') ||
      (input.action === 'save-provider' && (input.provider === null || typeof input.provider !== 'object'))
    )
      throw new CommunityRequestError(400, 'Invalid model settings action', 'model-action-invalid')
    sendCommunityJson(response, 200, await models.execute(caller, input))
    return true
  }
  sendCommunityJson(response, 405, { error: 'Method Not Allowed', code: 'method-not-allowed' })
  return true
}
