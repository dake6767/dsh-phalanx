import type { PlatformSecretEnvelope } from '../domain/platform-secret.js'
import type { PlatformSigningKeyPort } from '../ports/platform-signing-key.js'
import { PlatformDatabase } from './platform-database.js'
import { FilePlatformSecrets } from './platform-secrets.js'
import { PlatformStoreLifecycle } from './platform-store-lifecycle.js'
import { protectedTable } from './platform-secret-codec.js'

const signingKey = protectedTable('session_signing_key')

/** Platform-generated signing material has one encrypted PostgreSQL fact and one process cache. */
export class PostgresSessionKey implements PlatformSigningKeyPort {
  private value: string | undefined
  private readonly lifecycle = new PlatformStoreLifecycle('Platform session key')
  constructor(private readonly database: PlatformDatabase) {}
  initialize(): Promise<void> {
    return this.lifecycle.initialize(() => this.load())
  }
  read(): string {
    this.lifecycle.assertOpen()
    if (!this.value) throw Error('Platform session key is not ready')
    return this.value
  }
  close(): Promise<void> {
    return this.lifecycle.close(() => (this.value = undefined))
  }
  private async load(): Promise<void> {
    this.value = await this.database.transaction(async sql => {
      const created = signingKey.encrypt(this.database.cipher(), '1', 'signing_key', FilePlatformSecrets.randomCredential())
      await sql.query('INSERT INTO dsh_phalanx.session_signing_key(id,signing_key) VALUES(1,$1) ON CONFLICT(id) DO NOTHING', [JSON.stringify(created)])
      const [row] = await sql.query<{ signing_key: PlatformSecretEnvelope }>('SELECT signing_key FROM dsh_phalanx.session_signing_key WHERE id=1')
      const value = signingKey.decrypt(this.database.cipher(), '1', 'signing_key', row!.signing_key)
      if (Buffer.byteLength(value) < 32) throw Error('Invalid platform session key')
      return value
    })
  }
}
