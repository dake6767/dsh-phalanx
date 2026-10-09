import { createHmac, timingSafeEqual } from 'node:crypto'
import type { PluginDownloadGrant, PluginDownloadTokensPort } from '../ports/plugin-market.js'
export class SignedPluginDownloadTokens implements PluginDownloadTokensPort {
  constructor(private readonly secret: string) {}
  issue(grant: PluginDownloadGrant): string { const payload = Buffer.from(JSON.stringify(grant)).toString('base64url'); return `${payload}.${this.sign(payload)}` }
  read(token: string): PluginDownloadGrant | undefined {
    if (token.length > 2048) return undefined
    const [payload, signature, extra] = token.split('.')
    if (!payload || !signature || extra !== undefined) return undefined
    const expected = Buffer.from(this.sign(payload)), actual = Buffer.from(signature)
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return undefined
    try {
      const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as PluginDownloadGrant
      if (typeof value.username !== 'string' || typeof value.spaceId !== 'string' || typeof value.integrity !== 'string' || !Number.isSafeInteger(value.expiresAt)) return undefined
      return value
    } catch { return undefined }
  }
  private sign(payload: string): string { return createHmac('sha256', this.secret).update('plugin-download\0' + payload).digest('base64url') }
}
