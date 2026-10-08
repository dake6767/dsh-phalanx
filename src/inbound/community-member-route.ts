import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CommunityInstanceActions } from '../use-cases/community-instance-actions.js'
import type { CommunityEntry } from '../use-cases/community-entry.js'
import type { CommunityRestartResult, CommunitySelfIdentity } from '../domain/admin-contract.js'
import { assertCommunityOrigin, readCommunityJson, CommunityRequestError } from './community-request.js'
import { handleCommunityFailure, sendCommunityJson } from './community-errors.js'
import { mountedDshCookie, secureDshCookie } from './platform-session.js'
import { sendHtml, sendText } from './http-response.js'
import { COMMUNITY_RECOVERY_PAGE } from './community-recovery-page.js'

export function createCommunityMemberRoute(deps: {
  readonly actions: CommunityInstanceActions
  readonly entry: CommunityEntry
}) {
  return async (request: IncomingMessage, response: ServerResponse, username: string, origin: URL): Promise<void> => {
    const url = new URL(request.url ?? '/', origin)
    if (url.pathname === '/account/identity') {
      if (request.method !== 'GET') { sendCommunityJson(response, 405, { error: 'Method Not Allowed', code: 'method-not-allowed' }); return }
      try { const identity: CommunitySelfIdentity = { username: deps.entry.account(username).username }; sendCommunityJson(response, 200, identity) }
      catch (error) { handleCommunityFailure(response, error, true) }
      return
    }
    if (url.pathname === '/recovery' && request.method === 'GET') { sendHtml(response, 200, COMMUNITY_RECOVERY_PAGE); return }
    if (url.pathname !== '/recovery/restart') { sendText(response, 404, 'Not Found'); return }
    if (request.method !== 'POST') { sendText(response, 405, 'Method Not Allowed'); return }
    try {
      assertCommunityOrigin(request, origin)
      const account = deps.entry.account(username)
      const input = await readCommunityJson(request)
      if (input === null || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).length !== 1 || (input as { confirmed?: unknown }).confirmed !== true)
        throw new CommunityRequestError(400, 'Confirm that running tasks will be interrupted', 'restart-confirmation-required')
      await deps.actions.restart({ username, spaceId: account.spaceId, sessionEpoch: account.sessionEpoch }, origin)
      const cookies = await deps.entry.openSpace(account, origin)
      const entry = deps.entry.spacePath(username)
      response.setHeader('set-cookie', cookies.map(cookie => secureDshCookie(mountedDshCookie(cookie, entry), origin)))
      const result: CommunityRestartResult = { entry }
      sendCommunityJson(response, 200, result)
    } catch (error) { handleCommunityFailure(response, error, true) }
  }
}
