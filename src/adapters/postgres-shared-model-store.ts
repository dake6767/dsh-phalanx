import { randomBytes } from 'node:crypto'
import { BusinessRuleError } from '../domain/business-error.js'
import type { PlatformSecretEnvelope } from '../domain/platform-secret.js'
import type { SharedModelState, SharedProvider } from '../domain/shared-models.js'
import type { SharedModelProjectionPort, SharedModelStorePort } from '../ports/shared-models.js'
import { PlatformDatabase } from './platform-database.js'
import { PlatformStoreLifecycle } from './platform-store-lifecycle.js'
import { protectedTable } from './platform-secret-codec.js'

interface ProviderRow extends Record<string, unknown> {
  id: string
  configuration: Omit<SharedProvider, 'id' | 'apiKey'>
  api_key: PlatformSecretEnvelope
}
const providerSecrets = protectedTable('shared_model_providers')

/** PostgreSQL owns protected model settings; the initialized plaintext view stays in this process. */
export class PostgresSharedModelStore implements SharedModelStorePort {
  private state: SharedModelState | undefined
  private publicationPending = false
  private readonly lifecycle = new PlatformStoreLifecycle('Shared model storage')
  constructor(
    private readonly database: PlatformDatabase,
    private readonly projection: SharedModelProjectionPort,
  ) {}
  initialize(): Promise<void> {
    return this.lifecycle.initialize(() => this.load())
  }
  close(): Promise<void> {
    return this.lifecycle.close(() => {
      this.state = undefined
    })
  }
  read(): SharedModelState {
    this.lifecycle.assertOpen()
    if (!this.state) throw Error('Shared model storage is not ready')
    return this.state
  }
  newId(): string {
    return randomBytes(16).toString('hex')
  }
  save(state: SharedModelState): Promise<void> {
    const next = structuredClone(state)
    return this.lifecycle.write(() => this.persist(next))
  }
  private async load(): Promise<void> {
    this.state = await this.loadCommitted()
    this.publishCommitted()
  }
  private async loadCommitted(): Promise<SharedModelState> {
    return this.database.transaction(async sql => {
      const [settings] = await sql.query<{ revision: string; default_model_id: string | null }>(
        'SELECT revision,default_model_id FROM dsh_phalanx.shared_model_settings WHERE id=1 FOR UPDATE',
      )
      const providers = await sql.query<ProviderRow>('SELECT id,configuration,api_key FROM dsh_phalanx.shared_model_providers ORDER BY position,id')
      return {
        revision: Number(settings!.revision),
        defaultModelId: settings!.default_model_id,
        providers: providers.map(row => ({
          ...row.configuration,
          id: row.id,
          apiKey: providerSecrets.decrypt(this.database.cipher(), row.id, 'api_key', row.api_key),
        })),
      }
    })
  }
  private publishCommitted(): void {
    const state = this.read()
    this.publicationPending = true
    try {
      const prepared = this.projection.prepare(state)
      try {
        prepared.publish()
      } finally {
        prepared.discard()
      }
      this.publicationPending = false
    } catch {
      throw this.pendingPublication(state.revision)
    }
  }
  private pendingPublication(revision: number): BusinessRuleError {
    return new BusinessRuleError(
      'conflict',
      'Model settings are committed, but runtime publication is pending. Correct the model directory and retry.',
      'model-projection-pending',
      { revision },
    )
  }
  private async persist(next: SharedModelState): Promise<void> {
    this.read()
    if (this.publicationPending) {
      this.state = await this.loadCommitted()
      this.publishCommitted()
    }
    const prepared = this.projection.prepare(next)
    try {
      await this.database.transaction(async sql => {
        const [settings] = await sql.query<{ revision: string }>('SELECT revision FROM dsh_phalanx.shared_model_settings WHERE id=1 FOR UPDATE')
        const revision = Number(settings!.revision)
        if (next.revision !== revision + 1)
          throw new BusinessRuleError('conflict', 'Model settings changed. Reload before saving.', 'model-revision-conflict', {
            expectedRevision: revision,
            receivedRevision: next.revision - 1,
          })
        await sql.query('DELETE FROM dsh_phalanx.shared_model_providers')
        for (const [position, provider] of next.providers.entries()) {
          const { id, apiKey, ...configuration } = provider
          await sql.query('INSERT INTO dsh_phalanx.shared_model_providers(id,position,configuration,api_key) VALUES($1,$2,$3,$4)', [
            id,
            position,
            JSON.stringify(configuration),
            JSON.stringify(providerSecrets.encrypt(this.database.cipher(), id, 'api_key', apiKey)),
          ])
        }
        await sql.query('UPDATE dsh_phalanx.shared_model_settings SET revision=$1,default_model_id=$2 WHERE id=1', [next.revision, next.defaultModelId])
      })
    } catch (error) {
      prepared.discard()
      throw error
    }
    this.state = next
    this.publicationPending = true
    try {
      prepared.publish()
      this.publicationPending = false
    } catch {
      throw this.pendingPublication(next.revision)
    } finally {
      prepared.discard()
    }
  }
}
