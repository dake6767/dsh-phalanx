import { timingSafeEqual } from 'node:crypto'
import { BusinessRuleError } from '../domain/business-error.js'
import type { PlatformSecretEnvelope } from '../domain/platform-secret.js'
import type { CommunityModelAccessPort, CommunityModelIdentity } from '../ports/community-model-access.js'
import { PlatformDatabase } from './platform-database.js'
import { FilePlatformSecrets } from './platform-secrets.js'
import { PlatformStoreLifecycle } from './platform-store-lifecycle.js'
import { protectedTable } from './platform-secret-codec.js'

interface TokenRow extends Record<string, unknown> {
  username: string
  space_id: string
  token: PlatformSecretEnvelope
}
const tokenSecrets = protectedTable('model_access_tokens')

/** PostgreSQL commits space-bound credentials before the gateway can resolve them. */
export class PostgresCommunityModelAccess implements CommunityModelAccessPort {
  private tokens: Map<string, { username: string; token: string }> | undefined
  private revision = 0
  private readonly lifecycle = new PlatformStoreLifecycle('Community model access')
  constructor(private readonly database: PlatformDatabase) {}
  initialize(): Promise<void> {
    return this.lifecycle.initialize(() => this.load())
  }
  close(): Promise<void> {
    return this.lifecycle.close(() => {
      this.tokens?.clear()
      this.tokens = undefined
    })
  }
  version(): number {
    return this.revision
  }
  forUser(username: string, spaceId: string): Promise<string> {
    const operation = this.lifecycle.write(async () => {
      this.assertReady()
      const token = await this.database.transaction(async sql => {
        const [account] = await sql.query<{ disabled: boolean }>('SELECT disabled FROM dsh_phalanx.accounts WHERE username=$1 AND space_id=$2 FOR UPDATE', [
          username,
          spaceId,
        ])
        if (!account || account.disabled) throw new BusinessRuleError('forbidden', 'Account cannot use this environment', 'environment-account-disabled')
        const [saved] = await sql.query<TokenRow>('SELECT token FROM dsh_phalanx.model_access_tokens WHERE space_id=$1', [spaceId])
        if (saved) return this.tokenValue(spaceId, saved.token)
        const created = FilePlatformSecrets.randomCredential()
        await sql.query('INSERT INTO dsh_phalanx.model_access_tokens(space_id,token) VALUES($1,$2)', [
          spaceId,
          JSON.stringify(tokenSecrets.encrypt(this.database.cipher(), spaceId, 'token', created)),
        ])
        return created
      })
      const previous = this.tokens!.get(spaceId)
      this.tokens!.set(spaceId, { username, token })
      if (previous?.token !== token) this.revision++
      return token
    })
    return operation
  }
  resolve(token: string): CommunityModelIdentity | undefined {
    this.assertReady()
    const actual = Buffer.from(token)
    if (actual.length !== 43) return undefined
    for (const [spaceId, expected] of this.tokens!) {
      if (timingSafeEqual(actual, Buffer.from(expected.token))) return { username: expected.username, spaceId }
    }
    return undefined
  }
  private tokenValue(spaceId: string, envelope: PlatformSecretEnvelope): string {
    const value = tokenSecrets.decrypt(this.database.cipher(), spaceId, 'token', envelope)
    if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) throw Error('Invalid community model access token')
    return value
  }
  private assertReady(): void {
    this.lifecycle.assertOpen()
    if (!this.tokens) throw Error('Community model access is not ready')
  }
  private async load(): Promise<void> {
    const rows = await this.database.query<TokenRow>(
      'SELECT a.username,t.space_id,t.token FROM dsh_phalanx.model_access_tokens t JOIN dsh_phalanx.accounts a ON a.space_id=t.space_id',
    )
    const tokens = new Map<string, { username: string; token: string }>()
    for (const row of rows) tokens.set(row.space_id, { username: row.username, token: this.tokenValue(row.space_id, row.token) })
    this.tokens = tokens
  }
}
