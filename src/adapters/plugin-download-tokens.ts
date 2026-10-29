import type { PlatformSigningKeyPort } from '../ports/platform-signing-key.js'
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { PluginDownloadGrant, PluginDownloadTokensPort } from '../ports/native-plugin-downloads.js'

export class SignedPluginDownloadTokens implements PluginDownloadTokensPort {
  constructor(private readonly secret: string | PlatformSigningKeyPort) {}
  issue(grant: PluginDownloadGrant): string {
    const payload = Buffer.from(JSON.stringify(grant)).toString('base64url')
    return `${payload}.${this.sign(payload)}`
  }
  read(token: string): PluginDownloadGrant | undefined {
    if (token.length > 2048) return undefined
    const [payload, signature, extra] = token.split('.')
    if (!payload || !signature || extra !== undefined) return undefined
    const expected = Buffer.from(this.sign(payload)),
      actual = Buffer.from(signature)
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return undefined
    try {
      const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as PluginDownloadGrant
      if (
        !value ||
        typeof value.username !== 'string' ||
        typeof value.spaceId !== 'string' ||
        typeof value.packageName !== 'string' ||
        typeof value.integrity !== 'string' ||
        typeof value.artifact !== 'string' ||
        !Number.isSafeInteger(value.sessionEpoch) ||
        !Number.isSafeInteger(value.expiresAt)
      )
        return undefined
      return value
    } catch {
      return undefined
    }
  }
  private sign(payload: string): string {
    return createHmac('sha256', typeof this.secret === 'string' ? this.secret : this.secret.read())
      .update('plugin-download\0' + payload)
      .digest('base64url')
  }
}
