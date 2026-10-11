import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CommunityAccountActor } from '../domain/community-account.js'
import type { CommunitySkillPackInput } from '../domain/admin-contract.js'
import type { SkillPacks } from '../use-cases/skill-packs.js'
import { assertCommunityOrigin, CommunityRequestError, readCommunityJson } from './community-request.js'
import { sendCommunityJson } from './community-errors.js'

export async function skillPackRoute(request: IncomingMessage, response: ServerResponse, url: URL, actor: CommunityAccountActor, packs: SkillPacks, origin: URL): Promise<boolean> {
  const market = url.pathname === '/market/api/skill-packs'
  if (!market && !['/admin/api/skill-packs', '/admin/api/skill-packs/detail'].includes(url.pathname)) return false
  if (request.method === 'GET') {
    sendCommunityJson(response, 200, market ? packs.market(actor) : url.pathname.endsWith('/detail') ? packs.detail(actor, url.searchParams.get('name') ?? '') : { packs: packs.list(actor), revision: packs.revision(actor) }); return true
  }
  if (request.method !== 'POST' || url.pathname.endsWith('/detail')) { sendCommunityJson(response, 405, { code: 'method-not-allowed', error: 'Method Not Allowed' }); return true }
  assertCommunityOrigin(request, origin)
  const body = await readCommunityJson(request, 1024 * 1024) as Record<string, unknown>
  const invalid = () => new CommunityRequestError(400, 'Invalid skill pack action.', 'skill-pack-invalid')
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid()
  if (market) {
    if (Object.keys(body).length !== 2 || typeof body.name !== 'string' || !['install', 'uninstall'].includes(String(body.action))) throw invalid()
    await packs.select(actor, body.name, body.action === 'install'); sendCommunityJson(response, 200, { applied: true }); return true
  }
  if (typeof body.revision !== 'string') throw invalid()
  if (body.action === 'remove' && Object.keys(body).length === 4 && typeof body.name === 'string' && typeof body.deleteSkills === 'boolean') {
    await packs.remove(actor, body.name, body.deleteSkills, body.revision); sendCommunityJson(response, 200, { removed: true }); return true
  }
  if (body.action !== 'save' || Object.keys(body).length !== (body.previousName === undefined ? 3 : 4) || (body.previousName !== undefined && typeof body.previousName !== 'string') || !body.pack || typeof body.pack !== 'object' || Array.isArray(body.pack)) throw invalid()
  const input = body.pack as Record<string, unknown>
  if (Object.keys(input).length !== 5 || typeof input.name !== 'string' || typeof input.description !== 'string' || typeof input.instructions !== 'string'
    || typeof input.published !== 'boolean' || !Array.isArray(input.skills) || input.skills.some(name => typeof name !== 'string')) throw invalid()
  sendCommunityJson(response, 200, await packs.save(actor, input as unknown as CommunitySkillPackInput, body.revision, body.previousName as string | undefined)); return true
}
