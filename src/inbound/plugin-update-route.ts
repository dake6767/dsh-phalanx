import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CommunityAccountActor } from '../domain/community-account.js'
import type { PluginUpdates } from '../use-cases/plugin-updates.js'
import { sendCommunityJson } from './community-errors.js'
import { CommunityRequestError } from './community-request.js'

/** On-demand npm update checks; preparing an update goes through the plugin change action. */
export async function pluginUpdateRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  actor: CommunityAccountActor,
  updates: PluginUpdates,
): Promise<boolean> {
  if (url.pathname !== '/admin/api/plugins/updates') return false
  if (request.method === 'GET') sendCommunityJson(response, 200, await updates.check(actor, url.searchParams.get('packageName') ?? ''))
  else sendCommunityJson(response, 405, { error: 'Method Not Allowed', code: 'method-not-allowed' })
  return true
}

export function preparePluginUpdate(actor: CommunityAccountActor, packageName: string, updates: PluginUpdates | undefined) {
  if (!updates) throw new CommunityRequestError(400, 'Invalid plugin action', 'plugin-action-invalid')
  return updates.prepare(actor, packageName)
}
