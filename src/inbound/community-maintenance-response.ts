import type { IncomingMessage, ServerResponse } from 'node:http'
import { resolvePlatformLocale } from '../domain/platform-language.js'
import { communityMaintenancePage } from './community-maintenance-page.js'

const pages = { en: communityMaintenancePage('en'), 'zh-CN': communityMaintenancePage('zh-CN') }

export function sendCommunityMaintenance(request: IncomingMessage, response: ServerResponse): void {
  response.writeHead(503, {
    'content-type': 'text/html; charset=utf-8',
    'retry-after': '3',
    'cache-control': 'no-store',
    'content-security-policy': "frame-ancestors 'none'",
    'x-content-type-options': 'nosniff',
  })
  response.end(pages[resolvePlatformLocale(undefined, request.headers['accept-language'])])
}
