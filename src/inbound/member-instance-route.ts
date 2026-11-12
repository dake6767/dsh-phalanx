import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CommunityMemberInstanceRequest, CommunityMemberInstanceResult } from '../domain/admin-contract.js'
import type { CommunityAccountActor } from '../domain/community-account.js'
import type { CommunityMemberInstances } from '../use-cases/community-member-instances.js'
import { assertCommunityOrigin, CommunityRequestError, readCommunityJson } from './community-request.js'
import { sendCommunityJson } from './community-errors.js'

export async function memberInstanceRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  actor: CommunityAccountActor,
  instances: CommunityMemberInstances,
  origin: URL,
): Promise<boolean> {
  const match = /^\/admin\/api\/accounts\/([^/]+)\/instance$/u.exec(url.pathname)
  if (!match) return false
  if (request.method !== 'POST') {
    sendCommunityJson(response, 405, { error: 'Method Not Allowed', code: 'method-not-allowed' })
    return true
  }
  assertCommunityOrigin(request, origin)
  let username: string
  try {
    username = decodeURIComponent(match[1]!)
  } catch {
    throw new CommunityRequestError(400, 'Invalid account path', 'account-path-invalid')
  }
  const input = (await readCommunityJson(request)) as Partial<CommunityMemberInstanceRequest> | null
  if (
    !input ||
    Array.isArray(input) ||
    Object.keys(input).some(key => !['spaceId', 'action', 'confirmed'].includes(key)) ||
    typeof input.spaceId !== 'string' ||
    !/^[a-f0-9]{32}$/u.test(input.spaceId) ||
    (input.action !== 'start' && input.action !== 'restart') ||
    input.confirmed !== true
  )
    throw new CommunityRequestError(400, 'Confirm that running tasks will be interrupted', 'restart-confirmation-required')
  await instances.execute(actor, username, input.action, origin, input.spaceId)
  sendCommunityJson(response, 200, { completed: true } satisfies CommunityMemberInstanceResult)
  return true
}
