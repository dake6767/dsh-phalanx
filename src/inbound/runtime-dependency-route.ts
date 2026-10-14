import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CommunityAccountActor } from '../domain/community-account.js'
import type { CommunityRuntimeDependencyAction } from '../domain/admin-contract.js'
import type { RuntimeDependencies } from '../use-cases/runtime-dependencies.js'
import { assertCommunityOrigin, CommunityRequestError, readCommunityJson } from './community-request.js'
import { sendCommunityJson } from './community-errors.js'

export async function runtimeDependencyRoute(request: IncomingMessage, response: ServerResponse, url: URL, actor: CommunityAccountActor, dependencies: RuntimeDependencies, origin: URL): Promise<boolean> {
  if (url.pathname !== '/admin/api/runtime-dependencies') return false
  if (request.method === 'GET') {
    const name = url.searchParams.get('name')
    sendCommunityJson(response, 200, name === null ? dependencies.list(actor) : dependencies.view(actor, name)); return true
  }
  if (request.method !== 'POST') { sendCommunityJson(response, 405, { code: 'method-not-allowed' }); return true }
  assertCommunityOrigin(request, origin)
  const value = await readCommunityJson(request, 512 * 1024) as CommunityRuntimeDependencyAction
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CommunityRequestError(400, 'Invalid runtime dependency request', 'runtime-dependency-invalid')
  if (value.action === 'create') dependencies.create(actor, value.input)
  else if (value.action === 'update' && typeof value.name === 'string') dependencies.update(actor, value.name, value.input)
  else if (value.action === 'prepare' && typeof value.name === 'string') void dependencies.prepare(actor, value.name).catch(() => {})
  else if (value.action === 'remove' && typeof value.name === 'string') await dependencies.remove(actor, value.name)
  else throw new CommunityRequestError(400, 'Invalid runtime dependency request', 'runtime-dependency-invalid')
  sendCommunityJson(response, value.action === 'remove' ? 200 : 202, dependencies.list(actor)); return true
}
