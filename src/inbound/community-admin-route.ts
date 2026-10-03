import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CommunityAccountRecord } from '../domain/community-account.js'
import type { CommunityAccountActionResult, CommunityAccountView, CommunityAccountsPageData, CommunitySessionInfo } from '../domain/admin-contract.js'
import type { CommunityAccountAdministration } from '../use-cases/community-account-administration.js'
import type { CommunityRuntimePort } from '../ports/community-runtime.js'
import type { CommunityOnboarding } from '../use-cases/community-onboarding.js'
import type { AdminAssetServer } from './admin-assets.js'
import { assertCommunityOrigin, communityAccountActionInput, communityAccountInput, CommunityRequestError, readCommunityJson } from './community-request.js'
import { handleCommunityFailure, sendCommunityJson } from './community-errors.js'
import { sendText } from './http-response.js'

export function createCommunityAdminRoute(deps: {
  readonly authenticate: (request: IncomingMessage) => string | undefined
  readonly onboarding: CommunityOnboarding
  readonly administration: CommunityAccountAdministration
  readonly runtime: Pick<CommunityRuntimePort, 'status'>
  readonly assets: AdminAssetServer
  readonly origin: () => URL
}) {
  const view = (account: CommunityAccountRecord): CommunityAccountView => ({
    username: account.username, email: account.email, admin: account.admin, disabled: account.disabled,
    instance: { state: deps.runtime.status(account.username).state },
  })
  return async (request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> => {
    const api = url.pathname.startsWith('/admin/api/')
    const actor = deps.authenticate(request)
    if (actor === undefined) {
      if (api) sendCommunityJson(response, 401, { error: 'Sign in is required' })
      else { response.writeHead(303, { location: '/login' }); response.end() }
      return
    }
    try {
      const viewer = deps.onboarding.viewer(actor)
      const caller = { username: viewer.username, sessionEpoch: viewer.sessionEpoch }
      if (url.pathname === '/admin/api/session' && request.method === 'GET') {
        const body: CommunitySessionInfo = { username: viewer.username, admin: viewer.admin }
        sendCommunityJson(response, 200, body); return
      }
      if (url.pathname === '/admin/api/accounts') {
        if (request.method === 'GET') {
          const accounts = deps.onboarding.list(actor)
          const body: CommunityAccountsPageData = { total: accounts.length, page: 1, pageCount: 1, items: accounts.map(view) }
          sendCommunityJson(response, 200, body); return
        }
        if (request.method === 'POST') {
          assertCommunityOrigin(request, deps.origin())
          const input = communityAccountInput(await readCommunityJson(request))
          const created = await deps.administration.createMember(caller, input)
          sendCommunityJson(response, 201, view(created)); return
        }
        sendCommunityJson(response, 405, { error: 'Method Not Allowed' }); return
      }
      const actionRoute = /^\/admin\/api\/accounts\/([^/]+)\/actions$/u.exec(url.pathname)
      if (actionRoute !== null) {
        if (request.method !== 'POST') { sendCommunityJson(response, 405, { error: 'Method Not Allowed' }); return }
        assertCommunityOrigin(request, deps.origin())
        let username: string
        try { username = decodeURIComponent(actionRoute[1]!) }
        catch { throw new CommunityRequestError(400, 'Invalid account path') }
        const input = communityAccountActionInput(await readCommunityJson(request))
        const updated = await deps.administration.execute(caller, username, input)
        const body: CommunityAccountActionResult = updated === undefined
          ? { kind: 'deleted', username, userSpace: 'preserved' } : { kind: 'updated', account: view(updated) }
        sendCommunityJson(response, 200, body); return
      }
      if (api) { sendCommunityJson(response, 404, { error: 'Not Found' }); return }
      if (!['/admin', '/admin/', '/admin/accounts'].includes(url.pathname)
        && !url.pathname.startsWith('/admin/assets/')) { sendText(response, 404, 'Not Found'); return }
      if (!await deps.assets.serve(request, response, url.pathname)) sendText(response, 404, 'Not Found')
    } catch (error) { handleCommunityFailure(response, error, api) }
  }
}
