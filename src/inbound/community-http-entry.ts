import type { IncomingMessage, ServerResponse } from 'node:http'
import { handleCommunityFailure } from './community-errors.js'
import { sendText } from './http-response.js'
import { assertCommunityOrigin } from './community-request.js'

export function protectCommunityEntry(dispatch: (request: IncomingMessage, response: ServerResponse) => Promise<void>, origin: () => URL) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      const url = new URL(request.url ?? '/', origin())
      // Public registration is outside the first release.
      if (['/register', '/signup'].includes(url.pathname)) {
        sendText(response, 404, 'Not Found'); return
      }
      if (request.method === 'POST' && url.pathname === '/logout') assertCommunityOrigin(request, origin())
      await dispatch(request, response)
    } catch (error) { handleCommunityFailure(response, error, request.url?.startsWith('/admin/api/') === true) }
  }
}
