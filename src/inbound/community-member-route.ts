import { CommunityEnvironmentRecoveryError } from '../domain/community-environment.js'
import type { CommunityEnvironmentRecovery } from '../use-cases/community-environment-recovery.js'
import { requestLanguage } from './platform-language.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CommunityEntry } from '../use-cases/community-entry.js'
import type { CommunityRestartResult, CommunitySelfIdentity, CommunitySelfEnvironmentResetResult, CommunitySelfEnvironmentResetFailure } from '../domain/admin-contract.js'
import { assertCommunityOrigin, readCommunityJson, CommunityRequestError } from './community-request.js'
import { handleCommunityFailure, sendCommunityJson } from './community-errors.js'
import { mountedDshCookie, secureDshCookie } from './platform-session.js'
import { sendHtml, sendText } from './http-response.js'
import { communityRecoveryPage } from './community-recovery-page.js'

export function createCommunityMemberRoute(deps: {
  readonly entry: CommunityEntry
  readonly environment: CommunityEnvironmentRecovery
}) {
  return async (request: IncomingMessage, response: ServerResponse, username: string, origin: URL): Promise<void> => {
    const url = new URL(request.url ?? '/', origin)
    if (url.pathname === '/account/startup') {
      if (request.method !== 'GET') { sendCommunityJson(response, 405, { error: 'Method Not Allowed', code: 'method-not-allowed' }); return }
      try { sendCommunityJson(response, 200, deps.entry.startup(username)) }
      catch (error) { handleCommunityFailure(response, error, true) }
      return
    }
    if (url.pathname === '/account/identity') {
      if (request.method !== 'GET') { sendCommunityJson(response, 405, { error: 'Method Not Allowed', code: 'method-not-allowed' }); return }
      try { const identity: CommunitySelfIdentity = { username: deps.entry.account(username).username }; sendCommunityJson(response, 200, identity) }
      catch (error) { handleCommunityFailure(response, error, true) }
      return
    }
    if (url.pathname === '/recovery' && request.method === 'GET') { const { locale, preference } = requestLanguage(request); sendHtml(response, 200, communityRecoveryPage(locale, preference)); return }
    const reset = url.pathname === '/recovery/reset'
    if (!reset && url.pathname !== '/recovery/restart') { sendText(response, 404, 'Not Found'); return }
    if (request.method !== 'POST') { sendText(response, 405, 'Method Not Allowed'); return }
    try {
      assertCommunityOrigin(request, origin)
      const account = deps.entry.account(username)
      const input = await readCommunityJson(request)
      if (input === null || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).length !== 1 || (input as { confirmed?: unknown }).confirmed !== true)
        throw new CommunityRequestError(400, reset ? 'Confirm that tasks will be interrupted and configuration and self-installed plugins will be reset.' : 'Confirm that running tasks will be interrupted', reset ? 'environment-reset-confirmation-required' : 'restart-confirmation-required')
      if (reset) {
        const result = await deps.environment.reset(account, username, origin)
        const body: CommunitySelfEnvironmentResetResult = { entry: result.entry }
        sendCommunityJson(response, 200, body); return
      }
      const cookies = await deps.entry.restart(account, origin)
      const entry = deps.entry.spacePath(username)
      response.setHeader('set-cookie', cookies.map(cookie => secureDshCookie(mountedDshCookie(cookie, entry), origin)))
      const result: CommunityRestartResult = { entry }
      sendCommunityJson(response, 200, result)
    } catch (error) {
      if (reset && error instanceof CommunityEnvironmentRecoveryError) {
        const body: CommunitySelfEnvironmentResetFailure = { error: 'Environment reset did not complete. Contact an administrator for help.', code: 'environment-self-reset-failed', phase: error.phase, params: { phase: error.phase } }
        sendCommunityJson(response, 503, body); return
      }
      handleCommunityFailure(response, error, true)
    }
  }
}
