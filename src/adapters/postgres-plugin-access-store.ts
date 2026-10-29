import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { BusinessRuleError } from '../domain/business-error.js'
import type { ContributionReceipt } from '../domain/contribution-receipt.js'
import type { PlatformSecretEnvelope } from '../domain/platform-secret.js'
import type { PluginAccessCheckpoint, PluginAccessSettings } from '../domain/plugin-access.js'
import type { PluginAccessStorePort } from '../ports/plugin-access.js'
import type { PlatformSql } from './platform-database.js'
import { protectedTable } from './platform-secret-codec.js'
import { PlatformStoreLifecycle } from './platform-store-lifecycle.js'
import { pluginTransaction, type PluginRepositoryConnection } from './postgres-plugin-repository.js'

interface AccessRecord {
  settings?: PluginAccessSettings
  receipt?: ContributionReceipt
  checkpoint?: PluginAccessCheckpoint
}
interface Field {
  scope: string
  field: string
}
interface Row extends Record<string, unknown> {
  package_name: string
  configuration: AccessRecord
  fields: Field[]
  commit_version: string
  secrets: SecretRow[]
}
interface SecretRow extends Record<string, unknown> {
  package_name: string
  scope: string
  field: string
  value: PlatformSecretEnvelope
}
const fieldId = ({ scope, field }: Field) => JSON.stringify([scope, field])
const accessSecrets = protectedTable('plugin_access_secrets')
const recordOf = (packageName: string, { scope }: Field) => JSON.stringify([packageName, scope])
function mapSettings(settings: PluginAccessSettings, scope: string, visit: (position: Field, value: string) => string): PluginAccessSettings {
  const entries = (value: unknown, path: readonly (string | number)[]): unknown => {
    if (typeof value === 'string') return visit({ scope, field: 'entries/' + JSON.stringify(path) }, value)
    if (Array.isArray(value)) return value.map((row, index) => entries(row, [...path, index]))
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, row]) => [key, entries(row, [...path, key])]))
    return value
  }
  return {
    ...settings,
    entriesYaml: visit({ scope, field: 'entriesYaml' }, settings.entriesYaml),
    environment: settings.environment.map(row => ({ ...row, value: visit({ scope, field: 'environment/' + row.name }, row.value) })),
    entries: entries(settings.entries, []) as PluginAccessSettings['entries'],
  }
}
function mapRecord(record: AccessRecord, visit: (position: Field, value: string) => string): AccessRecord {
  return {
    ...record,
    ...(record.settings ? { settings: mapSettings(record.settings, 'current', visit) } : {}),
    ...(record.checkpoint?.before ? { checkpoint: { ...record.checkpoint, before: mapSettings(record.checkpoint.before, 'before', visit) } } : {}),
  }
}

/** Reset current and rollback values together, preserving receipt and checkpoint ownership. */
export function resetPluginAccessSecrets(record: AccessRecord): AccessRecord {
  const next = mapRecord(record, () => '')
  const settings = next.settings ? { ...next.settings, revision: randomUUID() } : undefined
  const checkpoint = next.checkpoint
    ? {
        ...next.checkpoint,
        ...(next.checkpoint.before ? { before: { ...next.checkpoint.before, revision: randomUUID() } } : {}),
        appliedRevision: settings && record.settings?.revision === next.checkpoint.appliedRevision ? settings.revision : next.checkpoint.appliedRevision,
      }
    : undefined
  return { ...next, ...(settings ? { settings } : {}), ...(checkpoint ? { checkpoint } : {}) }
}

/** Per-package settings, contribution receipts and suite rollback state share one PostgreSQL commit. */
export class PostgresPluginAccessStore implements PluginAccessStorePort {
  private initialized = false
  private readonly lifecycle = new PlatformStoreLifecycle('Plugin access storage')
  constructor(private readonly connection: PluginRepositoryConnection) {}
  initialize(): Promise<void> {
    return this.lifecycle.initialize(async () => {
      this.initialized = true
    })
  }
  close(): Promise<void> {
    return this.lifecycle.close(() => {
      this.initialized = false
    })
  }
  private ready(): void {
    this.lifecycle.assertOpen()
    if (!this.initialized && !('sql' in this.connection)) throw Error('Plugin access storage is not ready')
  }
  private cipher() {
    return 'sql' in this.connection ? this.connection.cipher : this.connection.cipher()
  }
  private async read(sql: PlatformSql, packageName: string): Promise<{ record: AccessRecord; version: number }> {
    const [row] = await sql.query<Row>(
      `SELECT package_name,configuration,fields,commit_version,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('scope',scope,'field',field,'value',value)) FROM dsh_phalanx.plugin_access_secrets WHERE package_name=plugin_access_settings.package_name),'[]'::jsonb) AS secrets
       FROM dsh_phalanx.plugin_access_settings WHERE package_name=$1`,
      [packageName],
    )
    if (!row) return { record: {}, version: 0 }
    const fields = new Set(row.fields.map(fieldId)),
      values = new Map(row.secrets.map(secret => [fieldId(secret), secret.value]))
    const record = mapRecord(row.configuration, (position, value) =>
      fields.has(fieldId(position))
        ? accessSecrets.decrypt(this.cipher(), recordOf(packageName, position), position.field, values.get(fieldId(position))!)
        : value,
    )
    return { record, version: Number(row.commit_version) }
  }
  private async record(packageName: string): Promise<AccessRecord> {
    this.ready()
    return pluginTransaction(this.connection, async sql => (await this.read(sql, packageName)).record)
  }
  async get(packageName: string) {
    return (await this.record(packageName)).settings
  }
  async list() {
    this.ready()
    return pluginTransaction(this.connection, async sql => {
      const rows = await sql.query<{ package_name: string }>('SELECT package_name FROM dsh_phalanx.plugin_access_settings')
      const entries: [string, PluginAccessSettings][] = []
      for (const row of rows) {
        const { record } = await this.read(sql, row.package_name)
        if (record.settings) entries.push([row.package_name, record.settings])
      }
      return Object.fromEntries(entries)
    })
  }
  async receipt(packageName: string) {
    return (await this.record(packageName)).receipt
  }
  async suiteCheckpoint(packageName: string) {
    return (await this.record(packageName)).checkpoint
  }
  save(packageName: string, settings: Omit<PluginAccessSettings, 'revision'>, receipt?: ContributionReceipt, expectedRevision?: string): Promise<void> {
    return this.modify(
      packageName,
      record => {
        const prior = record.settings
          ? { environment: record.settings.environment, entriesYaml: record.settings.entriesYaml, entries: record.settings.entries }
          : undefined
        return {
          record: {
            ...record,
            settings: { ...settings, revision: record.settings && isDeepStrictEqual(prior, settings) ? record.settings.revision : randomUUID() },
            ...(receipt ? { receipt } : {}),
          },
          result: undefined,
        }
      },
      expectedRevision,
    )
  }
  remove(packageName: string, expectedRevision?: string): Promise<void> {
    return this.modify(
      packageName,
      record => {
        delete record.settings
        return { record, result: undefined }
      },
      expectedRevision,
    )
  }
  commitContribution(packageName: string, settings: Omit<PluginAccessSettings, 'revision'> | undefined, receipt: ContributionReceipt): Promise<void> {
    if (settings) return this.save(packageName, settings, receipt)
    return this.modify(packageName, record => {
      delete record.settings
      return { record: { ...record, receipt }, result: undefined }
    })
  }
  saveSuiteCheckpoint(packageName: string, checkpoint: PluginAccessCheckpoint | undefined): Promise<void> {
    return this.modify(packageName, record => {
      if (checkpoint) record.checkpoint = checkpoint
      else delete record.checkpoint
      return { record, result: undefined }
    })
  }
  clearSuiteCheckpoint(packageName: string, task: string): Promise<void> {
    return this.modify(packageName, record => {
      if (record.checkpoint?.task === task) delete record.checkpoint
      return { record, result: undefined }
    })
  }
  applySuite(packageName: string, task: string, settings: Omit<PluginAccessSettings, 'revision'>): Promise<void> {
    return this.modify(packageName, record => {
      if (record.checkpoint) {
        if (record.checkpoint.task === task) return { record, result: undefined }
        throw new BusinessRuleError('conflict', 'Plugin access task is busy.', 'plugin-impact-changed')
      }
      const applied = { ...settings, revision: randomUUID() }
      return {
        record: {
          ...record,
          settings: applied,
          checkpoint: {
            task,
            ...(record.settings ? { before: record.settings } : {}),
            ...(record.receipt ? { receipt: record.receipt } : {}),
            appliedRevision: applied.revision,
          },
        },
        result: undefined,
      }
    })
  }
  restoreSuite(packageName: string, task: string): Promise<boolean> {
    return this.modify(packageName, record => {
      const checkpoint = record.checkpoint
      if (!checkpoint || checkpoint.task !== task) return { record, result: true }
      if (record.settings?.revision !== checkpoint.appliedRevision) return { record, result: false }
      if (checkpoint.before) record.settings = checkpoint.before
      else delete record.settings
      if (checkpoint.receipt) record.receipt = checkpoint.receipt
      else delete record.receipt
      delete record.checkpoint
      return { record, result: true }
    })
  }
  private async modify<T>(packageName: string, change: (record: AccessRecord) => { record: AccessRecord; result: T }, expectedRevision?: string): Promise<T> {
    this.lifecycle.assertAccepting()
    this.ready()
    return this.lifecycle.write(() =>
      pluginTransaction(this.connection, async sql => {
        await sql.query('SELECT package_name FROM dsh_phalanx.plugin_library WHERE package_name=$1 FOR UPDATE', [packageName])
        // Lock first, then take a fresh snapshot of both metadata and protected values.
        await sql.query('SELECT package_name FROM dsh_phalanx.plugin_access_settings WHERE package_name=$1 FOR UPDATE', [packageName])
        const previous = await this.read(sql, packageName)
        if (expectedRevision !== undefined && expectedRevision !== (previous.record.settings?.revision ?? 'none'))
          throw new BusinessRuleError('conflict', 'Platform configuration changed. Reload before saving.', 'platform-configuration-conflict')
        const { record: next, result } = change(structuredClone(previous.record))
        if (isDeepStrictEqual(previous.record, next)) return result
        await sql.query(
          `INSERT INTO dsh_phalanx.plugin_access_settings(package_name,configuration,fields,commit_version) VALUES($1,'{}','[]',0) ON CONFLICT(package_name) DO NOTHING`,
          [packageName],
        )
        const fields: Field[] = [],
          secrets: { position: Field; value: string }[] = []
        const metadata = mapRecord(next, (position, value) => {
          if (value) {
            fields.push(position)
            secrets.push({ position, value })
          }
          return ''
        })
        const updated = await sql.query(
          `UPDATE dsh_phalanx.plugin_access_settings SET configuration=$2,fields=$3,commit_version=commit_version+1 WHERE package_name=$1 AND commit_version=$4 RETURNING commit_version`,
          [packageName, JSON.stringify(metadata), JSON.stringify(fields), previous.version],
        )
        if (!updated.length) throw new BusinessRuleError('conflict', 'Platform configuration changed. Reload before saving.', 'platform-configuration-conflict')
        for (const field of await sql.query<SecretRow>('SELECT scope,field FROM dsh_phalanx.plugin_access_secrets WHERE package_name=$1', [packageName])) {
          if (!fields.some(next => fieldId(next) === fieldId(field)))
            await sql.query('DELETE FROM dsh_phalanx.plugin_access_secrets WHERE package_name=$1 AND scope=$2 AND field=$3', [
              packageName,
              field.scope,
              field.field,
            ])
        }
        const oldValues = new Map<string, string>()
        mapRecord(previous.record, (position, value) => {
          oldValues.set(fieldId(position), value)
          return value
        })
        for (const { position, value } of secrets) {
          if (oldValues.get(fieldId(position)) === value) continue
          await sql.query(
            `INSERT INTO dsh_phalanx.plugin_access_secrets(package_name,scope,field,value) VALUES($1,$2,$3,$4) ON CONFLICT(package_name,scope,field) DO UPDATE SET value=EXCLUDED.value`,
            [
              packageName,
              position.scope,
              position.field,
              JSON.stringify(accessSecrets.encrypt(this.cipher(), recordOf(packageName, position), position.field, value)),
            ],
          )
        }
        return result
      }),
    )
  }
}
