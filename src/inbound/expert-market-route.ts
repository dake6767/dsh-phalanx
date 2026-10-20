import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CommunityAccountActor } from '../domain/community-account.js'
import type { Experts } from '../use-cases/experts.js'
import { assertCommunityOrigin, CommunityRequestError, readCommunityJson } from './community-request.js'
import { sendCommunityJson } from './community-errors.js'

/** Member selections refer to published experts in the current member space. */
export async function expertMarketRoute(request: IncomingMessage, response: ServerResponse, actor: CommunityAccountActor, experts: Experts, origin: URL): Promise<void> {
  if (request.method === 'GET') { sendCommunityJson(response, 200, experts.market(actor)); return }
  if (request.method !== 'POST') { sendCommunityJson(response, 405, { code: 'method-not-allowed' }); return }
  assertCommunityOrigin(request, origin)
  const value = await readCommunityJson(request) as Record<string, unknown>
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2 || typeof value.name !== 'string' || typeof value.action !== 'string' || !['summon', 'dismiss'].includes(value.action)) throw new CommunityRequestError(400, 'Invalid expert action.', 'expert-invalid')
  sendCommunityJson(response, 200, await experts.select(actor, value.name, value.action === 'summon'))
}
