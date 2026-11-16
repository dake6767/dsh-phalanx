import { BusinessRuleError } from '../domain/business-error.js'
import type { PlatformSecretEnvelope } from '../domain/platform-secret.js'
import type { PlatformSearchSettingsChange, PlatformSearchSettingsView } from '../domain/admin-contract.js'
import type { PlatformSearchSettingsStore } from '../ports/platform-search-settings.js'
import type { PlatformDatabase } from './platform-database.js'
import { protectedTable } from './platform-secret-codec.js'

interface Row extends Record<string, unknown> {
  revision: string
  enabled: boolean
  api_key: PlatformSecretEnvelope | null
}

const secrets = protectedTable('platform_search_settings')
const view = (row: Row): PlatformSearchSettingsView => ({ revision: Number(row.revision), enabled: row.enabled, hasKey: row.api_key !== null })

export class PostgresPlatformSearchSettings implements PlatformSearchSettingsStore {
  constructor(private readonly database: PlatformDatabase) {}

  async view(): Promise<PlatformSearchSettingsView> {
    const [row] = await this.database.query<Row>('SELECT revision,enabled,api_key FROM dsh_phalanx.platform_search_settings WHERE id=1')
    return view(row!)
  }

  async credential(): Promise<string | undefined> {
    const [row] = await this.database.query<Pick<Row, 'api_key'>>('SELECT api_key FROM dsh_phalanx.platform_search_settings WHERE id=1 AND enabled')
    return row?.api_key ? secrets.decrypt(this.database.cipher(), '1', 'api_key', row.api_key) : undefined
  }

  async save(change: PlatformSearchSettingsChange): Promise<PlatformSearchSettingsView> {
    return await this.database.transaction(async sql => {
      const [row] = await sql.query<Row>('SELECT revision,enabled,api_key FROM dsh_phalanx.platform_search_settings WHERE id=1 FOR UPDATE')
      if (!row || Number(row.revision) !== change.revision)
        throw new BusinessRuleError('conflict', 'Platform search settings changed. Reload before saving.', 'platform-configuration-conflict')
      const enabled = change.action === 'save' && change.enabled
      const apiKey =
        change.action === 'clear' ? null : change.apiKey === undefined ? row.api_key : secrets.encrypt(this.database.cipher(), '1', 'api_key', change.apiKey)
      if (enabled && apiKey === null) throw new BusinessRuleError('invalid', 'A DeepSeek Search API key is required.', 'platform-search-key-required')
      const [saved] = await sql.query<Row>(
        'UPDATE dsh_phalanx.platform_search_settings SET enabled=$1,api_key=$2,revision=revision+1 WHERE id=1 RETURNING revision,enabled,api_key',
        [enabled, apiKey === null ? null : JSON.stringify(apiKey)],
      )
      return view(saved!)
    })
  }
}
