import type { CommunitySystemUpdate } from '../use-cases/community-system-update.js'
import { communitySystemUpdateInput } from './community-system-update-request.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CommunityAccountRecord } from '../domain/community-account.js'
import type { CommunityAccountActionResult, CommunityAccountView, CommunityAccountsPageData, CommunityManagementSession } from '../domain/admin-contract.js'
import type { CommunityAccountAdministration } from '../use-cases/community-account-administration.js'
import type { CommunityRuntimePort } from '../ports/community-runtime.js'
import type { CommunityOnboarding } from '../use-cases/community-onboarding.js'
import type { AdminAssetServer } from './admin-assets.js'
import { assertCommunityOrigin, communityAccountActionInput, communityAccountInput, CommunityRequestError, readCommunityJson } from './community-request.js'
import { handleCommunityFailure, sendCommunityJson } from './community-errors.js'
import { sendText } from './http-response.js'
import type { CommunityEnvironmentRecovery } from '../use-cases/community-environment-recovery.js'
import type { SharedModelAdministration } from '../use-cases/shared-model-administration.js'
import type { CommunityModelAction } from '../domain/admin-contract.js'

export function createCommunityAdminRoute(deps: {
  readonly authenticate: (request: IncomingMessage) => string | undefined
  readonly onboarding: CommunityOnboarding
  readonly administration: CommunityAccountAdministration
  readonly runtime: Pick<CommunityRuntimePort, 'status'>
  readonly assets: AdminAssetServer
  readonly origin: () => URL
  readonly models: SharedModelAdministration
  readonly environment: CommunityEnvironmentRecovery
  readonly updates: CommunitySystemUpdate
}) {
  const view = (account: CommunityAccountRecord): CommunityAccountView => ({
    username: account.username, spaceId: account.spaceId, email: account.email, admin: account.admin, disabled: account.disabled,
    instance: { state: deps.runtime.status(account.username).state },
  })
  return async (request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> => {
    const api = url.pathname.startsWith('/admin/api/')
    const actor = deps.authenticate(request)
    if (actor === undefined) {
      if (api) sendCommunityJson(response, 401, { error: 'Sign in is required', code: 'sign-in-required' })
      else { response.writeHead(303, { location: '/login' }); response.end() }
      return
    }
    try {
      const viewer = deps.onboarding.viewer(actor)
      const caller = { username: viewer.username, spaceId: viewer.spaceId, sessionEpoch: viewer.sessionEpoch }
      if (url.pathname === '/admin/api/session' && request.method === 'GET') {
        const body: CommunityManagementSession = { username: viewer.username, admin: viewer.admin,
          modelState: deps.models.configured() ? 'configured' : 'unconfigured' }
        sendCommunityJson(response, 200, body); return
      }
      if (url.pathname === '/admin/api/system-update') {
        if (request.method === 'GET') {
          if ([...url.searchParams.keys()].some(key => key !== 'operation') || url.searchParams.getAll('operation').length > 1)
            throw new CommunityRequestError(400, 'Invalid update status query', 'update-query-invalid')
          sendCommunityJson(response, 200, await deps.updates.status(caller, url.searchParams.get('operation') ?? undefined)); return
        }
        if (request.method === 'POST') {
          assertCommunityOrigin(request, deps.origin())
          sendCommunityJson(response, 200, await deps.updates.execute(caller, communitySystemUpdateInput(await readCommunityJson(request)))); return
        }
        sendCommunityJson(response, 405, { error: 'Method Not Allowed', code: 'method-not-allowed' }); return
      }
      if (url.pathname === '/admin/api/models') {
        if (request.method === 'GET') { sendCommunityJson(response, 200, deps.models.list(caller)); return }
        if (request.method === 'POST') {
          assertCommunityOrigin(request, deps.origin())
          const input = await readCommunityJson(request) as CommunityModelAction
          if (input === null || typeof input !== 'object' || !['save-provider', 'delete-provider', 'set-default'].includes(input.action)
            || !Number.isSafeInteger(input.revision) || (input.action === 'set-default' && typeof input.defaultModelId !== 'string')
            || (input.action === 'delete-provider' && typeof input.providerId !== 'string') || (input.action === 'save-provider' && (input.provider === null || typeof input.provider !== 'object')))
            throw new CommunityRequestError(400, 'Invalid model settings action', 'model-action-invalid')
          sendCommunityJson(response, 200, deps.models.execute(caller, input)); return
        }
        sendCommunityJson(response, 405, { error: 'Method Not Allowed', code: 'method-not-allowed' }); return
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
        sendCommunityJson(response, 405, { error: 'Method Not Allowed', code: 'method-not-allowed' }); return
      }
      const resetRoute = /^\/admin\/api\/accounts\/([^/]+)\/reset-environment$/u.exec(url.pathname)
      if (resetRoute !== null) {
        if (request.method !== 'POST') { sendCommunityJson(response, 405, { error: 'Method Not Allowed', code: 'method-not-allowed' }); return }
        assertCommunityOrigin(request, deps.origin())
        let username: string
        try { username = decodeURIComponent(resetRoute[1]!) } catch { throw new CommunityRequestError(400, 'Invalid account path', 'account-path-invalid') }
        const input = await readCommunityJson(request)
        if (input === null || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1
          || (input as { confirmed?: unknown }).confirmed !== true) throw new CommunityRequestError(400, 'Confirm that running tasks will be interrupted', 'restart-confirmation-required')
        sendCommunityJson(response, 200, await deps.environment.reset(caller, username, deps.origin())); return
      }
      const actionRoute = /^\/admin\/api\/accounts\/([^/]+)\/actions$/u.exec(url.pathname)
      if (actionRoute !== null) {
        if (request.method !== 'POST') { sendCommunityJson(response, 405, { error: 'Method Not Allowed', code: 'method-not-allowed' }); return }
        assertCommunityOrigin(request, deps.origin())
        let username: string
        try { username = decodeURIComponent(actionRoute[1]!) }
        catch { throw new CommunityRequestError(400, 'Invalid account path', 'account-path-invalid') }
        const input = communityAccountActionInput(await readCommunityJson(request))
        const updated = await deps.administration.execute(caller, username, input)
        const body: CommunityAccountActionResult = updated === undefined
          ? { kind: 'deleted', username, userSpace: 'preserved' } : { kind: 'updated', account: view(updated) }
        sendCommunityJson(response, 200, body); return
      }
      if (api) { sendCommunityJson(response, 404, { error: 'Not Found', code: 'not-found' }); return }
      if (!deps.assets.handles(url.pathname)) { sendText(response, 404, 'Not Found'); return }
      if (!await deps.assets.serve(request, response, url.pathname)) sendText(response, 404, 'Not Found')
    } catch (error) { handleCommunityFailure(response, error, api) }
  }
}
