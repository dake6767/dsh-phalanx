import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CommunityAccountActor } from '../domain/community-account.js'
import type { CommunitySystemStatus } from '../use-cases/community-system-status.js'
import type { DownloadSources } from '../use-cases/download-sources.js'
import type { PlatformVoice } from '../use-cases/platform-voice.js'
import type { PlatformSearchSettings } from '../use-cases/platform-search-settings.js'
import { sendCommunityJson } from './community-errors.js'
import { assertCommunityOrigin, CommunityRequestError, readCommunityJson } from './community-request.js'

export async function systemConfigurationRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  caller: CommunityAccountActor,
  services: {
    readonly downloads?: DownloadSources
    readonly platformSearch: PlatformSearchSettings
    readonly platformVoice: PlatformVoice
    readonly systemStatus?: CommunitySystemStatus
  },
  origin: URL,
): Promise<boolean> {
  if (url.pathname === '/admin/api/download-sources' && services.downloads) {
    if (request.method === 'GET') {
      sendCommunityJson(response, 200, await services.downloads.view(caller))
      return true
    }
    if (request.method === 'POST') {
      assertCommunityOrigin(request, origin)
      sendCommunityJson(response, 200, await services.downloads.save(caller, await readCommunityJson(request)))
      return true
    }
    sendCommunityJson(response, 405, { error: 'Method Not Allowed', code: 'method-not-allowed' })
    return true
  }
  const feature =
    url.pathname === '/admin/api/platform-search' ? services.platformSearch : url.pathname === '/admin/api/platform-voice' ? services.platformVoice : undefined
  if (feature) {
    if (request.method === 'GET') {
      sendCommunityJson(response, 200, await feature.view(caller))
      return true
    }
    if (request.method === 'POST') {
      assertCommunityOrigin(request, origin)
      sendCommunityJson(response, 200, await feature.save(caller, await readCommunityJson(request)))
      return true
    }
    sendCommunityJson(response, 405, { error: 'Method Not Allowed', code: 'method-not-allowed' })
    return true
  }
  if (url.pathname === '/admin/api/system-status' && services.systemStatus) {
    if (request.method === 'GET') {
      sendCommunityJson(response, 200, await services.systemStatus.view(caller))
      return true
    }
    if (request.method === 'POST') {
      assertCommunityOrigin(request, origin)
      const input = (await readCommunityJson(request)) as { action?: unknown; fingerprint?: unknown }
      if (
        !input ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        Object.keys(input).length !== 2 ||
        input.action !== 'confirm-backup' ||
        typeof input.fingerprint !== 'string'
      )
        throw new CommunityRequestError(400, 'Confirm the offline backup of the displayed master key.', 'master-key-fingerprint-required')
      sendCommunityJson(response, 200, await services.systemStatus.confirmBackup(caller, input.fingerprint))
      return true
    }
    sendCommunityJson(response, 405, { error: 'Method Not Allowed', code: 'method-not-allowed' })
    return true
  }
  return false
}
