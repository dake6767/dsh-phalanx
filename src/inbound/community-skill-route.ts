import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CommunityAccountActor } from '../domain/community-account.js'
import { SKILL_MAX_BYTES } from '../domain/skill-library.js'
import type { SkillLibrary } from '../use-cases/skill-library.js'
import { assertCommunityOrigin, CommunityRequestError, readCommunityJson } from './community-request.js'
import { sendCommunityJson } from './community-errors.js'

/** Skill HTTP grammar; identity is established by the management entry. */
export async function communitySkillRoute(request: IncomingMessage, response: ServerResponse, url: URL, actor: CommunityAccountActor, library: SkillLibrary, origin: URL): Promise<boolean> {
  if (!['/admin/api/skills', '/admin/api/skills/detail', '/admin/api/skills/upload', '/admin/api/skills/change'].includes(url.pathname)) return false
  if (request.method === 'GET' && url.pathname === '/admin/api/skills') { sendCommunityJson(response, 200, library.list(actor)); return true }
  if (request.method === 'GET' && url.pathname.endsWith('/detail')) { sendCommunityJson(response, 200, await library.detail(actor, url.searchParams.get('name') ?? '')); return true }
  if (request.method !== 'POST' || !['/admin/api/skills/upload', '/admin/api/skills/change'].includes(url.pathname)) {
    sendCommunityJson(response, 405, { code: 'method-not-allowed', error: 'Method Not Allowed' }); return true
  }
  assertCommunityOrigin(request, origin)
  if (url.pathname.endsWith('/upload')) {
    if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/zip') throw new CommunityRequestError(415, 'Upload a ZIP archive.', 'media-type-unsupported')
    if (Number(request.headers['content-length']) > SKILL_MAX_BYTES) throw new CommunityRequestError(413, 'Skill uploads must not exceed 20 MB.', 'skill-upload-too-large')
    const controller = new AbortController(), abort = () => controller.abort(), closed = () => { if (!response.writableEnded) abort() }
    request.once('aborted', abort); response.once('close', closed)
    try { sendCommunityJson(response, 200, await library.upload(actor, request.iterator({ destroyOnReturn: false }) as AsyncIterable<Uint8Array>, controller.signal)) }
    finally { request.off('aborted', abort); response.off('close', closed); request.resume() }
    return true
  }
  const value: unknown = await readCommunityJson(request)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CommunityRequestError(400, 'Invalid skill action.', 'skill-preview-changed')
  const body = value as Record<string, unknown>
  if (body.action === 'confirm' && typeof body.token === 'string' && typeof body.revision === 'string' && Object.keys(body).length === 3)
    sendCommunityJson(response, 200, await library.confirm(actor, body.token, body.revision))
  else if (body.action === 'remove' && typeof body.name === 'string' && typeof body.revision === 'string' && Object.keys(body).length === 3) {
    await library.remove(actor, body.name, body.revision); sendCommunityJson(response, 200, { removed: true })
  } else if (body.action === 'cancel' && typeof body.token === 'string' && Object.keys(body).length === 2) {
    await library.cancel(actor, body.token); sendCommunityJson(response, 200, { cancelled: true })
  } else throw new CommunityRequestError(400, 'Invalid skill action.', 'skill-preview-changed')
  return true
}
