import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CommunityAccountActor } from '../domain/community-account.js'
import { PLUGIN_UPLOAD_MAX_BYTES } from '../domain/plugin-library.js'
import type { CommunityPluginView } from '../domain/admin-contract.js'
import type { PluginLibrary } from '../use-cases/plugin-library.js'
import { CommunityRequestError } from './community-request.js'

export async function receiveCommunityPluginUpload(request: IncomingMessage, response: ServerResponse, library: PluginLibrary, actor: CommunityAccountActor): Promise<CommunityPluginView> {
  if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/gzip') throw new CommunityRequestError(415, 'Upload a gzip archive.', 'media-type-unsupported')
  const header = request.headers['x-plugin-filename']
  let filename: string
  try { if (typeof header !== 'string') throw new Error('Missing filename'); filename = decodeURIComponent(header) }
  catch { throw new CommunityRequestError(400, 'Choose an npm pack .tgz archive.', 'plugin-upload-extension') }
  if (Number(request.headers['content-length']) > PLUGIN_UPLOAD_MAX_BYTES) throw new CommunityRequestError(413, 'Plugin uploads must not exceed 50 MB.', 'plugin-upload-too-large')
  const replacement = request.headers['x-plugin-replace-package']
  if (replacement !== undefined && typeof replacement !== 'string') throw new CommunityRequestError(400, 'Invalid replacement package', 'plugin-package-invalid')
  const controller = new AbortController()
  const abort = () => controller.abort()
  const closed = () => { if (!response.writableEnded) abort() }
  request.once('aborted', abort); response.once('close', closed)
  try { return await library.upload(actor, filename, request.iterator({ destroyOnReturn: false }) as AsyncIterable<Uint8Array>, controller.signal, replacement) }
  finally { request.off('aborted', abort); response.off('close', closed); request.resume() }
}
