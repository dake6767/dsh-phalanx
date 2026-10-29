import { requestLanguage } from './platform-language.js'
import { platformError } from '../domain/platform-copy.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { handleCommunityFailure } from './community-errors.js'
import { sendText } from './http-response.js'
import { assertCommunityOrigin } from './community-request.js'
import { communityBootstrapPage, communityLoginPage } from './community-account-pages.js'

export function protectCommunityEntry(dispatch: (request: IncomingMessage, response: ServerResponse) => Promise<void>, origin: () => URL) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    let path: string | undefined
    try {
      const url = new URL(request.url ?? '/', origin())
      path = url.pathname
      // Public registration is outside the first release.
      if (['/register', '/signup'].includes(url.pathname)) {
        sendText(response, 404, 'Not Found')
        return
      }
      const externalEntry =
        request.method === 'GET' &&
        request.headers['sec-fetch-mode'] === 'navigate' &&
        request.headers['sec-fetch-dest'] === 'document' &&
        (url.pathname === '/' || url.pathname === '/recovery' || url.pathname.startsWith('/service-preview/') || /^\/app\/[a-f0-9]{32}\/$/u.test(url.pathname))
      if (!externalEntry && (!['/login', '/healthz', '/readyz'].includes(url.pathname) || request.method !== 'GET')) assertCommunityOrigin(request, origin())
      await dispatch(request, response)
    } catch (error) {
      const { locale, preference } = requestLanguage(request)
      const page = path === '/login' ? communityLoginPage : path === '/bootstrap' ? communityBootstrapPage : undefined
      handleCommunityFailure(
        response,
        error,
        path?.startsWith('/admin/api/') === true ||
          (path === '/bootstrap' && request.method === 'POST' && request.headers.accept?.includes('application/json') === true),
        page ? detail => page(platformError(locale, detail), locale, preference) : undefined,
      )
    }
  }
}
