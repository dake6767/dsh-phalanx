import type { SkillLibrary } from '../use-cases/skill-library.js'
import { skillMarketRoute } from './skill-market-route.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CommunityMarketInstallAction } from '../domain/admin-contract.js'
import type { CommunityEntry } from '../use-cases/community-entry.js'
import type { PluginMarket } from '../use-cases/plugin-market.js'
import type { AdminAssetServer } from './admin-assets.js'
import { assertCommunityOrigin, CommunityRequestError, readCommunityJson } from './community-request.js'
import { handleCommunityFailure, sendCommunityJson } from './community-errors.js'
import { sendText } from './http-response.js'
export function createPluginMarketRoute(deps: { market: PluginMarket, skills: SkillLibrary, entry: Pick<CommunityEntry, 'account'>, assets: AdminAssetServer }) {
  return async (request: IncomingMessage, response: ServerResponse, username: string, origin: URL) => {
    const controller = new AbortController()
    const close = () => controller.abort()
    response.once('close', close)
    try {
      const path = new URL(request.url ?? '/', origin).pathname
      if (path === '/market') { await deps.assets.serve(request, response, path); return }
      if (path.startsWith('/market/api/skills') && await skillMarketRoute(request, response, deps.entry.account(username), deps.skills, origin)) return
      if (path !== '/market/api/plugins') { sendText(response, 404, 'Not Found'); return }
      const actor = deps.entry.account(username)
      if (request.method === 'GET') { sendCommunityJson(response, 200, await deps.market.list(actor, origin, controller.signal)); return }
      if (request.method === 'POST') {
        assertCommunityOrigin(request, origin)
        const input = await readCommunityJson(request) as CommunityMarketInstallAction
        if (!input || typeof input !== 'object' || typeof input.packageName !== 'string' || input.action !== undefined && !['install', 'uninstall'].includes(input.action)) throw new CommunityRequestError(400, 'Invalid plugin request', 'plugin-package-invalid')
        sendCommunityJson(response, 200, await (input.action === 'uninstall' ? deps.market.uninstall(actor, input.packageName, origin, controller.signal) : deps.market.install(actor, input.packageName, origin, controller.signal))); return
      }
      sendText(response, 405, 'Method Not Allowed')
    } catch (error) { if (!response.destroyed) handleCommunityFailure(response, error, true) }
    finally { response.removeListener('close', close) }
  }
}
