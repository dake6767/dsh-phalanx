import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CommunityAccountActor } from '../domain/community-account.js'
import type { CommunitySkillImportInput } from '../domain/admin-contract.js'
import { SKILL_IMPORT_MAX_BYTES } from '../domain/skill-import.js'
import type { SkillLibrary } from '../use-cases/skill-library.js'
import { assertCommunityOrigin, CommunityRequestError, readCommunityJson } from './community-request.js'
import { sendCommunityJson } from './community-errors.js'

export async function skillImportRoute(request: IncomingMessage, response: ServerResponse, url: URL, actor: CommunityAccountActor, library: SkillLibrary, origin: URL): Promise<boolean> {
  if (!['/admin/api/skills/import', '/admin/api/skills/import/confirm'].includes(url.pathname)) return false
  if (request.method !== 'POST') { sendCommunityJson(response, 405, { code: 'method-not-allowed', error: 'Method Not Allowed' }); return true }
  assertCommunityOrigin(request, origin)
  if (!url.pathname.endsWith('/confirm')) {
    if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/zip') throw new CommunityRequestError(415, 'Upload a ZIP archive.', 'media-type-unsupported')
    if (Number(request.headers['content-length']) > SKILL_IMPORT_MAX_BYTES) throw new CommunityRequestError(413, 'The import must be at most 100 MB.', 'skill-upload-too-large')
    const controller = new AbortController(), abort = () => controller.abort(), closed = () => { if (!response.writableEnded) abort() }
    request.once('aborted', abort); response.once('close', closed)
    try { sendCommunityJson(response, 200, await library.previewImport(actor, request.iterator({ destroyOnReturn: false }) as AsyncIterable<Uint8Array>, controller.signal, (url.searchParams.get('filename') ?? 'imported-skills.zip').slice(0, 256))) }
    finally { request.off('aborted', abort); response.off('close', closed); request.resume() }
    return true
  }
  const value = await readCommunityJson(request, 1024 * 1024) as Record<string, unknown>
  const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string')
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 4 || typeof value.token !== 'string' || !strings(value.names) || !strings(value.replacements) || !Array.isArray(value.packs)
    || value.packs.some(pack => !pack || typeof pack !== 'object' || Array.isArray(pack) || Object.keys(pack).length !== (pack.note === undefined ? 3 : 4) || typeof pack.name !== 'string' || typeof pack.description !== 'string' || !strings(pack.skills) || pack.note !== undefined && typeof pack.note !== 'string'))
    throw new CommunityRequestError(400, 'Invalid import selection.', 'skill-preview-changed')
  await library.confirmImport(actor, value as unknown as CommunitySkillImportInput)
  sendCommunityJson(response, 200, { imported: true }); return true
}
