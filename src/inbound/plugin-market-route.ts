import type { Experts } from '../use-cases/experts.js'
import { expertMarketRoute } from './expert-market-route.js'
import type { MemberContributions } from '../use-cases/member-contributions.js'
import { contributionBrowserRoute } from './contribution-route.js'
import type { McpServices } from '../use-cases/mcp-services.js'
import { mcpMarketRoute } from './mcp-market-route.js'
import type { SkillPacks } from '../use-cases/skill-packs.js'
import { skillPackRoute } from './skill-pack-route.js'
import type { SkillLibrary } from '../use-cases/skill-library.js'
import { skillMarketRoute } from './skill-market-route.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CommunityMarketInstallAction } from '../domain/admin-contract.js'
import type { CommunityEntry } from '../use-cases/community-entry.js'
import type { PluginMarket } from '../use-cases/plugin-market.js'
import { assertCommunityOrigin, CommunityRequestError, readCommunityJson } from './community-request.js'
import { handleCommunityFailure, sendCommunityJson } from './community-errors.js'
import { sendText } from './http-response.js'
export function createPluginMarketRoute(deps: { experts?: Experts, contributions?: MemberContributions, mcp?: McpServices, market: PluginMarket, skills: SkillLibrary, skillPacks?: SkillPacks, entry: Pick<CommunityEntry, 'account'> }) {
  return async (request: IncomingMessage, response: ServerResponse, username: string, origin: URL) => {
    const controller = new AbortController()
    const close = () => controller.abort()
    response.once('close', close)
    try {
      const path = new URL(request.url ?? '/', origin).pathname
      if (path === '/market/api/experts' && deps.experts) { await expertMarketRoute(request, response, deps.entry.account(username), deps.experts, origin); return }
      if (deps.contributions && await contributionBrowserRoute(request, response, new URL(request.url ?? '/', origin), deps.entry.account(username), deps.contributions, origin)) return
      if (path === '/market/api/mcp' && deps.mcp) { await mcpMarketRoute(request, response, deps.entry.account(username), deps.mcp, origin); return }
      if (deps.skillPacks && await skillPackRoute(request, response, new URL(request.url ?? '/', origin), deps.entry.account(username), deps.skillPacks, origin)) return
      if (path.startsWith('/market/api/skills') && await skillMarketRoute(request, response, deps.entry.account(username), deps.skills, origin)) return
      if (path === '/market/api/plugins/contribution') { if (request.method !== 'GET') { sendText(response, 405, 'Method Not Allowed'); return }; sendCommunityJson(response, 200, await deps.market.contributionDetailsFor(deps.entry.account(username), new URL(request.url ?? '/', origin).searchParams.get('packageName') ?? '', origin)); return }
      if (path === '/market/api/plugins/local-copy') {
        if (request.method !== 'POST') { sendText(response, 405, 'Method Not Allowed'); return }
        assertCommunityOrigin(request, origin)
        const input = await readCommunityJson(request) as { packageName?: unknown, enabled?: unknown }
        if (!input || typeof input.packageName !== 'string' || typeof input.enabled !== 'boolean' || Object.keys(input).some(key => !['packageName', 'enabled'].includes(key))) throw new CommunityRequestError(400, 'Choose a local copy state.', 'plugin-package-invalid')
        sendCommunityJson(response, 200, await deps.market.useLocalCopy(deps.entry.account(username), input.packageName, input.enabled, origin)); return
      }
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
