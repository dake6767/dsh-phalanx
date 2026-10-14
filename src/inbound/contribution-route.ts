import { PluginPreparationError } from '../domain/plugin-library.js'
import { enErrorMessages } from '../domain/platform-error-messages.js'
import { contributionUpload } from './contribution-upload.js'
import type { CommunityPluginUpstreamInput } from '../domain/admin-contract.js'
import type { ContributionDeclaration, ContributionSetup } from '../domain/member-contribution.js'
import { ContributionCheckError } from '../domain/contribution-check-error.js'
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
      const retainWarnings = new URL(request.url ?? '/', 'http://platform.invalid').searchParams.get('retainWarnings') === 'true'
      const url = new URL(request.url ?? '/', 'http://platform.invalid')
      if (url.searchParams.get('kind') === 'plugin' && request.headers['content-type'] === 'application/json') {
        const input = await readCommunityJson(request) as { packageName?: unknown, version?: unknown, declaration?: unknown }
        if (typeof input.packageName !== 'string' || typeof input.version !== 'string') throw new CommunityRequestError(400, 'Provide an exact npm package and version.', 'plugin-identity-invalid')
        sendCommunityJson(response, 200, await contributions.submitPlugin(actor, input.declaration as ContributionDeclaration, { source: 'npm', packageName: input.packageName, version: input.version }, controller.signal, retainWarnings)); return
      }
      const { declaration, content } = await contributionUpload(request, controller.signal)
      if (!declaration || typeof declaration !== 'object' || !('purpose' in declaration) || typeof declaration.purpose !== 'string') throw new CommunityRequestError(400, 'Describe the contribution purpose.', 'contribution-invalid')
      if (url.searchParams.get('kind') === 'plugin') {
        if (request.headers['content-type'] !== 'application/vnd.dsh-phalanx.contribution+tgz') throw new CommunityRequestError(400, 'Provide a plugin TGZ.', 'plugin-upload-extension')
        sendCommunityJson(response, 200, await contributions.submitPlugin(actor, declaration as ContributionDeclaration, { source: 'upload', filename: 'contribution.tgz', content }, controller.signal, retainWarnings))
      } else sendCommunityJson(response, 200, await contributions.submit(actor, declaration as ContributionDeclaration, content, controller.signal, retainWarnings))
    } catch (error) {
      if (error instanceof ContributionCheckError) sendCommunityJson(response, 400, { code: error.code, status: error.findings.some(row => row.severity === 'reject') ? 'rejected' : 'needs-review', findings: error.findings })
      else if (error instanceof PluginPreparationError) sendCommunityJson(response, ['plugin-cleanup-failed', 'plugin-runtime-required', 'plugin-job-interrupted'].includes(error.code) ? 503 : 400, { status: 'rejected', code: error.code, advice: enErrorMessages[error.code] })
      else if (error instanceof CommunityModelAccessError) sendCommunityJson(response, 401, { error: 'A current gateway token is required.', code: 'sign-in-required' })
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
    sendCommunityJson(response, 200, administration && url.searchParams.get('summary') === 'true' ? { skills: rows.filter(row => row.kind !== 'plugin' && row.status === 'pending').length, plugins: rows.filter(row => row.kind === 'plugin' && row.status === 'pending').length } : { contributions: rows }); return true
  }
  if (request.method !== 'POST') { sendCommunityJson(response, 405, { error: 'Method Not Allowed', code: 'method-not-allowed' }); return true }
  assertCommunityOrigin(request, origin)
  const input = await readCommunityJson(request, 6 * 1024 * 1024) as Record<string, unknown>
  if (!input || typeof input.id !== 'string') throw new CommunityRequestError(400, 'A contribution id is required.', 'contribution-invalid')
  if (administration && typeof input.revision !== 'string') throw new CommunityRequestError(400, 'Review the current contribution.', 'contribution-invalid')
  if (administration && input.action === 'inspect') { sendCommunityJson(response, 200, await contributions.inspect(actor, input.id, input.revision as string)); return true }
  if (administration && input.action === 'review') { sendCommunityJson(response, 200, await contributions.review(actor, input.id, input.revision as string)); return true }
  if (administration && input.action === 'test' && typeof input.token === 'string') { sendCommunityJson(response, 200, await contributions.testPlugin(actor, input.id, input.revision as string, input.token, input.upstream as CommunityPluginUpstreamInput)); return true }
  if (administration && input.action === 'adopt' && typeof input.token === 'string') await contributions.decide(actor, input.id, { action: 'adopt', revision: input.revision as string, token: input.token, ...(input.setup === undefined ? {} : { setup: input.setup as ContributionSetup }) })
  else if (administration && input.action === 'decline' && typeof input.reason === 'string') await contributions.decide(actor, input.id, { action: 'decline', reason: input.reason, revision: input.revision as string })
  else if (!administration && input.action === 'withdraw') await contributions.withdraw(actor, input.id)
  else throw new CommunityRequestError(400, 'Invalid contribution action.', 'contribution-invalid')
  sendCommunityJson(response, 200, { applied: true }); return true
}
