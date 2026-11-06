import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CommunityAccountActor } from '../domain/community-account.js'
import type { PluginIntake } from '../use-cases/plugin-intake.js'
import { sendCommunityJson } from './community-errors.js'
import { assertCommunityOrigin, CommunityRequestError, readCommunityJson } from './community-request.js'

/** Initial prechecks have their own transport and never masquerade as library rows. */
export async function pluginIntakeRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  actor: CommunityAccountActor,
  intake: PluginIntake,
  origin: URL,
): Promise<boolean> {
  const base = '/admin/api/plugins/previews'
  if (![base, base + '/confirm', base + '/retry', base + '/cancel'].includes(url.pathname)) return false
  if (url.pathname === base && request.method === 'GET') {
    sendCommunityJson(response, 200, await intake.read(actor, url.searchParams.get('token') ?? ''))
    return true
  }
  if (request.method !== 'POST') {
    sendCommunityJson(response, 405, { error: 'Method Not Allowed', code: 'method-not-allowed' })
    return true
  }
  assertCommunityOrigin(request, origin)
  const value = await readCommunityJson(request)
  const key = url.pathname === base ? 'input' : 'token'
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some(name => name !== key) ||
    typeof (value as Record<string, unknown>)[key] !== 'string'
  )
    throw new CommunityRequestError(400, 'Invalid plugin action', 'plugin-action-invalid')
  const input = (value as Record<string, string>)[key]!
  if (url.pathname === base + '/cancel') {
    await intake.cancel(actor, input)
    sendCommunityJson(response, 200, { cancelled: true })
  } else if (url.pathname === base + '/retry') sendCommunityJson(response, 202, await intake.retry(actor, input))
  else
    sendCommunityJson(
      response,
      url.pathname === base ? 202 : 200,
      url.pathname === base ? await intake.create(actor, input) : await intake.confirm(actor, input),
    )
  return true
}
