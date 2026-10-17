import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CommunityAccountActor } from '../domain/community-account.js'
import type { SuiteCatalog } from '../use-cases/suite-catalog.js'
import { assertCommunityOrigin, CommunityRequestError, readCommunityJson } from './community-request.js'
import { sendCommunityJson } from './community-errors.js'

export async function suiteCatalogRoute(request: IncomingMessage, response: ServerResponse, url: URL, actor: CommunityAccountActor, suites: SuiteCatalog, origin: URL): Promise<boolean> {
  if (url.pathname !== '/admin/api/suites' && url.pathname !== '/admin/api/suites/preview' && url.pathname !== '/admin/api/suites/uninstall-preview') return false
  if (request.method === 'GET') {
    if (url.pathname === '/admin/api/suites') { sendCommunityJson(response, 200, suites.catalog(actor)); return true }
    const id = url.searchParams.get('id') ?? ''
    sendCommunityJson(response, 200, url.pathname === '/admin/api/suites/preview' ? suites.installPreview(actor, id) : suites.uninstallPreview(actor, id)); return true
  }
  if (request.method !== 'POST') { sendCommunityJson(response, 405, { code: 'method-not-allowed' }); return true }
  assertCommunityOrigin(request, origin)
  const value = await readCommunityJson(request, 256 * 1024) as { action?: string, input?: unknown, id?: unknown, credentials?: unknown }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CommunityRequestError(400, 'Invalid suite catalog request', 'suite-catalog-invalid')
  if (value.action === 'install') suites.install(actor, value.input)
  else if (value.action === 'uninstall' && typeof value.id === 'string') suites.uninstall(actor, value.id, value.input)
  else if (value.action === 'credentials' && typeof value.id === 'string') { await suites.saveCredentials(actor, value.id, value.credentials); sendCommunityJson(response, 200, suites.catalog(actor)); return true }
  else throw new CommunityRequestError(400, 'Invalid suite catalog request', 'suite-catalog-invalid')
  sendCommunityJson(response, 202, suites.catalog(actor)); return true
}
