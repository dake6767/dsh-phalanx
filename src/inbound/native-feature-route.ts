import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CommunityNativeFeatureInput } from '../domain/admin-contract.js'
import type { CommunityAccountActor } from '../domain/community-account.js'
import type { NativeFeatures } from '../use-cases/native-features.js'
import { assertCommunityOrigin, CommunityRequestError, readCommunityJson } from './community-request.js'
import { sendCommunityJson } from './community-errors.js'

export async function nativeFeatureRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  actor: CommunityAccountActor,
  features: Pick<NativeFeatures, 'group' | 'save'>,
  origin: URL,
): Promise<boolean> {
  const match = /^\/admin\/api\/groups\/([^/]+)\/native-features$/.exec(url.pathname)
  if (!match) return false
  const groupId = decodeURIComponent(match[1]!)
  if (url.search) throw invalid()
  if (request.method === 'GET') sendCommunityJson(response, 200, await features.group(actor, groupId))
  else if (request.method === 'POST') {
    assertCommunityOrigin(request, origin)
    sendCommunityJson(response, 200, await features.save(actor, groupId, nativeFeatureInput(await readCommunityJson(request))))
  } else sendCommunityJson(response, 405, { code: 'method-not-allowed', error: 'Method Not Allowed' })
  return true
}
export function nativeFeatureInput(value: unknown): CommunityNativeFeatureInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  const body = value as Record<string, unknown>
  if (
    Object.keys(body).length !== 2 ||
    Object.keys(body).some(key => !['revision', 'disabledIds'].includes(key)) ||
    typeof body.revision !== 'string' ||
    !body.revision.length ||
    body.revision.length > 65536 ||
    !Array.isArray(body.disabledIds) ||
    body.disabledIds.length > 1000 ||
    body.disabledIds.some(id => typeof id !== 'string' || !/^[a-z][a-z0-9-]{0,79}$/u.test(id)) ||
    new Set(body.disabledIds).size !== body.disabledIds.length
  )
    throw invalid()
  return { revision: body.revision, disabledIds: body.disabledIds }
}
function invalid() {
  return new CommunityRequestError(400, 'Review the available native features and try again.', 'native-features-invalid')
}
