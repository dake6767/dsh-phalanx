import { platformText } from '../domain/platform-copy.js'
import { requestLanguage } from './platform-language.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AdminAssetSource } from '../ports/admin-assets.js'

/** Serve the single account-management page and its content-hashed assets. */
const ASSET_ROOT_PATH = /^\/admin\/assets\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/u
const APP_PAGE_PATHS = new Set(['/admin', '/admin/', '/admin/accounts', '/admin/groups', '/admin/models', '/admin/settings'])
export class AdminAssetServer {
  constructor(private readonly source: AdminAssetSource) {}

  /** Whether a request path belongs to the admin app (pages or hashed assets). */
  handles(pathname: string): boolean {
    return APP_PAGE_PATHS.has(pathname) || ASSET_ROOT_PATH.test(pathname)
  }

  /** Serve one admin request; returns false when the path is not admin-owned. */
  async serve(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<boolean> {
    if (!this.handles(pathname)) return false
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      sendAssetText(response, 405, 'Method Not Allowed')
      return true
    }
    const isAsset = ASSET_ROOT_PATH.test(pathname)
    const file = await this.source.read(isAsset ? pathname.slice('/admin/assets/'.length) : undefined)
    if (file === undefined) {
      if (isAsset) sendAssetText(response, 404, 'Not Found')
      else sendAssetText(response, 503, 'dsh-phalanx admin UI assets are not installed; build admin-ui before serving /admin')
      return true
    }
    const locale = requestLanguage(request).locale
    const title = platformText(locale, pathname.endsWith('/groups') ? 'Group management' : pathname.endsWith('/models') ? 'Model management' : pathname.endsWith('/settings') ? 'System settings' : 'Account management')
    const body = isAsset ? file.body : Buffer.from(file.body.toString().replace(/<html lang="en">/u, `<html lang="${locale}">`).replace(/<title>[^<]*<\/title>/u, `<title>${title} · dsh-phalanx</title>`))
    response.writeHead(200, {
      'content-type': file.contentType,
      'content-length': body.byteLength,
      'cache-control': file.immutable ? 'public, max-age=31536000, immutable' : 'no-store',
    })
    response.end(request.method === 'HEAD' ? undefined : body)
    return true
  }


}

function sendAssetText(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
  response.end(body)
}
