import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CommunityAccountActor } from '../domain/community-account.js'
import type { SuiteCatalog } from '../use-cases/suite-catalog.js'
import { assertCommunityOrigin, CommunityRequestError, readCommunityJson } from './community-request.js'
import { sendCommunityJson } from './community-errors.js'

export async function suiteCatalogRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  actor: CommunityAccountActor,
  suites: SuiteCatalog,
  origin: URL,
): Promise<boolean> {
  if (!['/admin/api/suites', '/admin/api/suites/preview', '/admin/api/suites/uninstall-preview', '/admin/api/suites/update-preview'].includes(url.pathname))
    return false
  // Opening the gallery and checking for updates fetch the signed catalog. Installation records stay local:
  // install, uninstall, detach and credential actions never wait for the catalog service.
  if (request.method === 'GET') {
    if (url.pathname === '/admin/api/suites' || url.pathname === '/admin/api/suites/update-preview') await suites.refreshCatalog(actor)
    if (url.pathname === '/admin/api/suites') {
      sendCommunityJson(response, 200, await suites.catalog(actor))
      return true
    }
    const id = url.searchParams.get('id') ?? ''
    sendCommunityJson(
      response,
      200,
      url.pathname === '/admin/api/suites/preview'
        ? await suites.installPreview(actor, id)
        : url.pathname === '/admin/api/suites/update-preview'
          ? await suites.updatePreview(actor, id)
          : await suites.uninstallPreview(actor, id),
    )
    return true
  }
  if (request.method !== 'POST') {
    sendCommunityJson(response, 405, { code: 'method-not-allowed' })
    return true
  }
  assertCommunityOrigin(request, origin)
  const value = (await readCommunityJson(request, 256 * 1024)) as { action?: string; input?: unknown; id?: unknown; credentials?: unknown }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new CommunityRequestError(400, 'Invalid suite catalog request', 'suite-catalog-invalid')
  if (value.action === 'install') await suites.install(actor, value.input)
  else if (value.action === 'uninstall' && typeof value.id === 'string') await suites.uninstall(actor, value.id, value.input)
  else if (value.action === 'update' && typeof value.id === 'string' && value.input === undefined) await suites.update(actor, value.id)
  else if (value.action === 'detach' && typeof value.id === 'string') {
    await suites.detach(actor, value.id, value.input)
    sendCommunityJson(response, 200, await suites.catalog(actor))
    return true
  } else if (value.action === 'credentials' && typeof value.id === 'string') {
    await suites.saveCredentials(actor, value.id, value.credentials)
    sendCommunityJson(response, 200, await suites.catalog(actor))
    return true
  } else throw new CommunityRequestError(400, 'Invalid suite catalog request', 'suite-catalog-invalid')
  sendCommunityJson(response, 202, await suites.catalog(actor))
  return true
}
