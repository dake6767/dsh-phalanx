import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CommunityAccountActor } from '../domain/community-account.js'
import type { InitialModelSetup } from '../use-cases/initial-model-setup.js'
import { isProviderProtocol } from '../domain/shared-models.js'
import { requestLanguage } from './platform-language.js'
import { initialModelPage } from './initial-model-page.js'
import { sendHtml } from './http-response.js'
import { sendCommunityJson } from './community-errors.js'
import { assertCommunityOrigin, CommunityRequestError, readCommunityJson } from './community-request.js'

export async function initialModelRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  actor: CommunityAccountActor,
  setup: InitialModelSetup,
  origin: URL,
): Promise<boolean> {
  const page = url.pathname === '/admin/initial-model',
    api = url.pathname === '/admin/api/initial-model'
  if (!page && !api) return false
  if (request.method === 'GET') {
    const view = await setup.view(actor)
    if (api) sendCommunityJson(response, 200, view)
    else {
      const { locale, preference } = requestLanguage(request)
      sendHtml(response, 200, initialModelPage(view, locale, preference))
    }
  } else if (api && request.method === 'POST') {
    assertCommunityOrigin(request, origin)
    const body = await readCommunityJson(request)
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new CommunityRequestError(400, 'Invalid model settings action', 'model-action-invalid')
    const value = body as Record<string, unknown>
    if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0)
      throw new CommunityRequestError(400, 'Invalid model settings revision', 'model-action-invalid')
    // A saved page submits only its revision to recover publication. First saves require all form fields.
    const saved = (await setup.view(actor)).settings.providers.length > 0
    if (!saved && (['name', 'baseUrl', 'model', 'apiKey'].some(key => typeof value[key] !== 'string') || !isProviderProtocol(value.apiFormat)))
      throw new CommunityRequestError(400, 'Invalid model settings fields', 'model-action-invalid')
    sendCommunityJson(
      response,
      200,
      await setup.save(actor, {
        revision: value.revision as number,
        name: typeof value.name === 'string' ? value.name : '',
        baseUrl: typeof value.baseUrl === 'string' ? value.baseUrl : '',
        apiFormat: isProviderProtocol(value.apiFormat) ? value.apiFormat : 'openai-completions',
        model: typeof value.model === 'string' ? value.model : '',
        apiKey: typeof value.apiKey === 'string' ? value.apiKey : '',
      }),
    )
  } else sendCommunityJson(response, 405, { error: 'Method Not Allowed', code: 'method-not-allowed' })
  return true
}
