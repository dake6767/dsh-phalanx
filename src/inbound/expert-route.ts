import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CommunityAccountActor } from '../domain/community-account.js'
import type { ExpertInput } from '../domain/expert.js'
import type { Experts } from '../use-cases/experts.js'
import { assertCommunityOrigin, CommunityRequestError, readCommunityJson } from './community-request.js'
import { sendCommunityJson } from './community-errors.js'

/** Closed management grammar; definitions do not implicitly grant or publish an expert. */
export async function expertRoute(request: IncomingMessage, response: ServerResponse, url: URL, actor: CommunityAccountActor, experts: Experts, origin: URL): Promise<boolean> {
  const group = /^\/admin\/api\/groups\/([^/]+)\/experts$/u.exec(url.pathname)
  if (!group && url.pathname !== '/admin/api/experts') return false
  if (request.method === 'GET') { sendCommunityJson(response, 200, group ? experts.group(actor, group[1]!) : url.searchParams.has('impact') ? experts.impact(actor, url.searchParams.get('impact')!) : experts.list(actor)); return true }
  if (request.method !== 'POST') { sendCommunityJson(response, 405, { code: 'method-not-allowed' }); return true }
  assertCommunityOrigin(request, origin)
  const value = await readCommunityJson(request) as Record<string, unknown>
  const invalid = () => { throw new CommunityRequestError(400, 'Invalid expert action.', 'expert-invalid') }
  if (!value || Array.isArray(value) || typeof value.revision !== 'string') invalid()
  if (group) {
    if (Object.keys(value).some(key => !['names', 'revision', 'confirmed'].includes(key)) || value.confirmed !== true || !Array.isArray(value.names) || value.names.some(name => typeof name !== 'string')) invalid()
    await experts.grant(actor, group[1]!, value.names as string[], value.revision as string)
    sendCommunityJson(response, 200, experts.group(actor, group[1]!))
  } else if (value.action === 'remove') {
    if (Object.keys(value).some(key => !['action', 'id', 'revision', 'confirmed'].includes(key)) || typeof value.id !== 'string' || value.confirmed !== true) invalid()
    await experts.remove(actor, value.id as string, value.revision as string)
    sendCommunityJson(response, 200, experts.list(actor))
  } else if (value.action === 'publish') {
    if (Object.keys(value).some(key => !['action', 'id', 'published', 'revision', 'confirmed'].includes(key)) || typeof value.id !== 'string' || typeof value.published !== 'boolean' || value.confirmed !== true) invalid()
    await experts.publish(actor, value.id as string, value.published as boolean, value.revision as string)
    sendCommunityJson(response, 200, experts.list(actor))
  } else {
    if (Object.keys(value).some(key => !['expert', 'revision', 'id'].includes(key)) || value.id !== undefined && typeof value.id !== 'string'
      || !value.expert || typeof value.expert !== 'object' || Array.isArray(value.expert)
      || Object.keys(value.expert).some(key => !['name', 'description', 'icon', 'persona', 'skills', 'skillPacks', 'plugins', 'mcp', 'examples', 'model'].includes(key))) invalid()
    await experts.save(actor, value.expert as ExpertInput, value.revision as string, value.id as string | undefined)
    sendCommunityJson(response, 200, experts.list(actor))
  }
  return true
}
