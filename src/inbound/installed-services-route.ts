import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CommunityAccountActor } from '../domain/community-account.js'
import type { CommunityInstalledServices } from '../domain/admin-contract.js'
import { sendCommunityJson } from './community-errors.js'
import { assertCommunityOrigin, CommunityRequestError, readCommunityJson } from './community-request.js'

interface InstalledServiceAdministration {
  services(actor: CommunityAccountActor, owner: string): Promise<CommunityInstalledServices>
  saveServices(actor: CommunityAccountActor, owner: string, revision: string, change: unknown): Promise<CommunityInstalledServices>
}

export async function installedServicesRoute(
  request: IncomingMessage,
  response: ServerResponse,
  actor: CommunityAccountActor,
  owner: string,
  administration: InstalledServiceAdministration,
  origin: URL,
): Promise<void> {
  if (request.method === 'GET') sendCommunityJson(response, 200, await administration.services(actor, owner))
  else if (request.method === 'POST') {
    assertCommunityOrigin(request, origin)
    const body = (await readCommunityJson(request)) as { revision?: unknown; change?: unknown } | null
    if (!body || typeof body.revision !== 'string' || Object.keys(body).length !== 2 || !Object.hasOwn(body, 'change'))
      throw new CommunityRequestError(400, 'Check the service configuration request.', 'execution-config-invalid')
    sendCommunityJson(response, 200, await administration.saveServices(actor, owner, body.revision, body.change))
  } else sendCommunityJson(response, 405, { code: 'method-not-allowed', error: 'Method Not Allowed' })
}
