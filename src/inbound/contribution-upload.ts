import type { IncomingMessage } from 'node:http'
import { readSkillUpload } from '../domain/skill-upload-stream.js'
import { PLUGIN_UPLOAD_MAX_BYTES } from '../domain/plugin-library.js'
import { SKILL_MAX_BYTES } from '../domain/skill-library.js'
import { CommunityRequestError } from './community-request.js'

/** A bounded JSON prefix avoids putting a complete declaration in HTTP headers. */
export async function contributionUpload(request: IncomingMessage, signal: AbortSignal): Promise<{ declaration: unknown; content: AsyncIterable<Uint8Array> }> {
  if (['application/vnd.dsh-phalanx.contribution+zip', 'application/vnd.dsh-phalanx.contribution+tgz'].includes(String(request.headers['content-type']))) {
    const bytes = await readSkillUpload(
      request,
      signal,
      (request.headers['content-type'] === 'application/vnd.dsh-phalanx.contribution+tgz' ? PLUGIN_UPLOAD_MAX_BYTES : SKILL_MAX_BYTES) + 1024 * 1024 + 4,
    )
    if (bytes.length < 4) throw new CommunityRequestError(400, 'Provide a contribution declaration and ZIP.', 'contribution-invalid')
    const length = bytes.readUInt32BE(0)
    if (length > 1024 * 1024 || length + 4 >= bytes.length)
      throw new CommunityRequestError(400, 'Invalid contribution declaration size.', 'contribution-invalid')
    let declaration: unknown
    try {
      declaration = JSON.parse(bytes.subarray(4, length + 4).toString('utf8'))
    } catch {
      throw new CommunityRequestError(400, 'Provide a contribution declaration.', 'contribution-invalid')
    }
    async function* content() {
      yield bytes.subarray(length + 4)
    }
    return { declaration, content: content() }
  }
  const header = request.headers['x-contribution-declaration']
  try {
    return { declaration: typeof header === 'string' ? JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) : undefined, content: request }
  } catch {
    throw new CommunityRequestError(400, 'Provide a contribution declaration.', 'contribution-invalid')
  }
}
