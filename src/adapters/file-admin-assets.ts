import { readFile, stat } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'
import type { AdminAsset, AdminAssetSource } from '../ports/admin-assets.js'

const MAX_ASSET_BYTES = 16 * 1024 * 1024
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
}

export class FileAdminAssetSource implements AdminAssetSource {
  private readonly root: string

  constructor(root: string, private readonly indexName: string = 'community.html') { this.root = resolve(root) }

  async read(name: string | undefined): Promise<AdminAsset | undefined> {
    const absolute = name === undefined ? join(this.root, this.indexName) : join(this.root, 'assets', name)
    const resolved = resolve(absolute)
    if (resolved !== this.root && !resolved.startsWith(this.root + sep)) return undefined
    const info = await stat(resolved).catch(() => undefined)
    if (info === undefined || !info.isFile()) return undefined
    if (info.size > MAX_ASSET_BYTES) throw new Error('admin UI asset exceeded its size limit')
    const body = await readFile(resolved)
    return { body, contentType: CONTENT_TYPES[extname(resolved)] ?? 'application/octet-stream', immutable: name !== undefined }
  }
}
