import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CommunityAccountActor } from '../domain/community-account.js'
import type { UsageQuery } from '../domain/usage-record.js'
import type { UsagePolicy } from '../use-cases/usage-policy.js'
import { assertCommunityOrigin, CommunityRequestError, readCommunityJson } from './community-request.js'
import { sendCommunityJson } from './community-errors.js'

export async function usageAdminRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  actor: CommunityAccountActor,
  usage: UsagePolicy,
  origin: URL,
): Promise<boolean> {
  if (!['/admin/api/usage-records', '/admin/api/usage-settings', '/admin/api/usage-models', '/admin/api/usage-reported'].includes(url.pathname)) return false
  if (url.pathname.endsWith('/usage-settings')) {
    if (request.method === 'GET') sendCommunityJson(response, 200, await usage.settings(actor))
    else if (request.method === 'POST') {
      assertCommunityOrigin(request, origin)
      sendCommunityJson(response, 200, await usage.saveRetention(actor, await readCommunityJson(request)))
    } else sendCommunityJson(response, 405, { code: 'method-not-allowed', error: 'Method Not Allowed' })
    return true
  }
  if (request.method !== 'GET') {
    sendCommunityJson(response, 405, { code: 'method-not-allowed', error: 'Method Not Allowed' })
    return true
  }
  const model = url.pathname.endsWith('/usage-models'),
    reported = url.pathname.endsWith('/usage-reported')
  const keys = reported
    ? ['from', 'until', 'username', 'groupId', 'skill']
    : model
      ? ['from', 'until', 'username', 'groupId', 'modelId']
      : ['from', 'until', 'username', 'groupId', 'capability', 'operation', 'outcome', 'page']
  if ([...url.searchParams.keys()].some(key => !keys.includes(key) || url.searchParams.getAll(key).length !== 1))
    throw new CommunityRequestError(400, 'Review the usage filters.', 'usage-query-invalid')
  const query = Object.fromEntries(
    [...url.searchParams.entries()]
      .filter(([, value]) => value !== '')
      .map(([key, value]) => [key, ['from', 'until', 'page'].includes(key) ? Number(value) : value]),
  ) as UsageQuery
  sendCommunityJson(response, 200, reported ? await usage.reported(actor, query) : model ? await usage.models(actor, query) : await usage.view(actor, query))
  return true
}
