import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CommunityAccountActor } from '../domain/community-account.js'
import type { SkillLibrary } from '../use-cases/skill-library.js'
import { assertCommunityOrigin, CommunityRequestError, readCommunityJson } from './community-request.js'
import { sendCommunityJson } from './community-errors.js'

/** Uses the same authenticated member entry as the plugin market. */
export async function skillMarketRoute(request: IncomingMessage, response: ServerResponse, actor: CommunityAccountActor, skills: SkillLibrary, origin: URL): Promise<boolean> {
  const url = new URL(request.url ?? '/', origin)
  if (!['/market/api/skills', '/market/api/skills/detail'].includes(url.pathname)) return false
  if (request.method === 'GET') {
    sendCommunityJson(response, 200, url.pathname.endsWith('/detail') ? await skills.marketDetail(actor, url.searchParams.get('name') ?? '') : await skills.market(actor)); return true
  }
  if (request.method !== 'POST' || url.pathname.endsWith('/detail')) { sendCommunityJson(response, 405, { code: 'method-not-allowed', error: 'Method Not Allowed' }); return true }
  assertCommunityOrigin(request, origin)
  const value = await readCommunityJson(request) as Record<string, unknown>
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2 || typeof value.name !== 'string' || !['install', 'uninstall'].includes(String(value.action))) throw new CommunityRequestError(400, 'Invalid skill action.', 'skill-unavailable')
  sendCommunityJson(response, 200, await skills.select(actor, value.name, value.action === 'install')); return true
}
