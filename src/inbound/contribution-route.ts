import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CommunityAccountActor } from '../domain/community-account.js'
import type { MemberContributions } from '../use-cases/member-contributions.js'
import type { CommunityModelAuthorization } from '../use-cases/community-model-authorization.js'
import { CommunityModelAccessError } from '../domain/community-model.js'
import { CommunityRequestError, assertCommunityOrigin, readCommunityJson } from './community-request.js'
import { sendCommunityJson, handleCommunityFailure } from './community-errors.js'
import { downstreamAbort } from './upstream-stream.js'

export function createContributionGateway(contributions: MemberContributions, authorization: CommunityModelAuthorization, account: (username: string) => CommunityAccountActor) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const { controller, cleanup } = downstreamAbort(request, response)
    try {
      const actor = account(authorization.authorize(request.headers['x-api-key']))
      if (request.method === 'GET') { sendCommunityJson(response, 200, { contributions: contributions.list(actor) }); return }
      if (request.method !== 'POST') { sendCommunityJson(response, 405, { error: 'Method Not Allowed', code: 'method-not-allowed' }); return }
      const action = new URL(request.url ?? '/', 'http://platform.invalid').searchParams.get('action')
      if (action === 'withdraw') {
        const input = await readCommunityJson(request) as { id?: unknown }
        if (typeof input?.id !== 'string') throw new CommunityRequestError(400, 'A contribution id is required.', 'contribution-invalid')
        await contributions.withdraw(actor, input.id); sendCommunityJson(response, 200, { applied: true }); return
      }
      if (action !== 'submit') throw new CommunityRequestError(400, 'Choose submit or withdraw.', 'contribution-invalid')
      const header = request.headers['x-contribution-declaration']
      let declaration: unknown
      try { declaration = typeof header === 'string' ? JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) : undefined }
      catch { throw new CommunityRequestError(400, 'Provide a contribution declaration.', 'contribution-invalid') }
      if (!declaration || typeof declaration !== 'object' || !('purpose' in declaration) || typeof declaration.purpose !== 'string') throw new CommunityRequestError(400, 'Describe the contribution purpose.', 'contribution-invalid')
      sendCommunityJson(response, 200, await contributions.submit(actor, { purpose: declaration.purpose }, request, controller.signal))
    } catch (error) {
      if (error instanceof CommunityModelAccessError) sendCommunityJson(response, 401, { error: 'A current gateway token is required.', code: 'sign-in-required' })
      else if (!response.destroyed) handleCommunityFailure(response, error, true)
    } finally { cleanup() }
  }
}

/** Browser sessions can review/withdraw but cannot upload on behalf of the tool. */
export async function contributionBrowserRoute(request: IncomingMessage, response: ServerResponse, url: URL, actor: CommunityAccountActor, contributions: MemberContributions, origin: URL): Promise<boolean> {
  const administration = url.pathname === '/admin/api/contributions'
  if (!administration && url.pathname !== '/market/api/contributions') return false
  if (request.method === 'GET') {
    const rows = contributions.list(actor, administration)
    sendCommunityJson(response, 200, administration && url.searchParams.get('summary') === 'true' ? { skills: rows.filter(row => row.status === 'pending').length } : { contributions: rows }); return true
  }
  if (request.method !== 'POST') { sendCommunityJson(response, 405, { error: 'Method Not Allowed', code: 'method-not-allowed' }); return true }
  assertCommunityOrigin(request, origin)
  const input = await readCommunityJson(request) as Record<string, unknown>
  if (!input || typeof input.id !== 'string') throw new CommunityRequestError(400, 'A contribution id is required.', 'contribution-invalid')
  if (administration && typeof input.revision !== 'string') throw new CommunityRequestError(400, 'Review the current contribution.', 'contribution-invalid')
  if (administration && input.action === 'review') { sendCommunityJson(response, 200, await contributions.review(actor, input.id, input.revision as string)); return true }
  if (administration && input.action === 'adopt' && typeof input.token === 'string') await contributions.decide(actor, input.id, { action: 'adopt', revision: input.revision as string, token: input.token })
  else if (administration && input.action === 'decline' && typeof input.reason === 'string') await contributions.decide(actor, input.id, { action: 'decline', reason: input.reason, revision: input.revision as string })
  else if (!administration && input.action === 'withdraw') await contributions.withdraw(actor, input.id)
  else throw new CommunityRequestError(400, 'Invalid contribution action.', 'contribution-invalid')
  sendCommunityJson(response, 200, { applied: true }); return true
}
