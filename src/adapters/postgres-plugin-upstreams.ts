import { randomUUID } from 'node:crypto'
import { BusinessRuleError } from '../domain/business-error.js'
import type { ContributionReceipt } from '../domain/contribution-receipt.js'
import type { PlatformSecretEnvelope } from '../domain/platform-secret.js'
import type { PluginUpstream } from '../domain/plugin-upstream.js'
import type { PluginUpstreamsPort } from '../ports/plugin-upstreams.js'
import type { PlatformSql } from './platform-database.js'
import { protectedTable } from './platform-secret-codec.js'
import { PlatformStoreLifecycle } from './platform-store-lifecycle.js'
import { pluginAuthorizationRevision, pluginTransaction, type PluginRepositoryConnection } from './postgres-plugin-repository.js'

type Metadata = Omit<PluginUpstream, 'credential' | 'headers' | 'secretUnavailable' | 'unreadableHeaders' | 'testRequest'> & {
  headers: readonly { name: string }[]
  testRequest?: { method: string } | null
}
interface SettingsRow extends Record<string, unknown> {
  package_name: string
  configuration: Metadata[]
  revision: string
  receipt: ContributionReceipt | null
  secrets: SecretRow[]
}
interface SecretRow extends Record<string, unknown> {
  package_name: string
  name: string
  credential: PlatformSecretEnvelope
  headers: PlatformSecretEnvelope[]
  test_request: PlatformSecretEnvelope | null
}
const recordId = (packageName: string, name: string) => JSON.stringify([packageName, name])
const upstreamSecrets = protectedTable('plugin_upstreams')
const protectedValues = ({ credential, headers, testRequest }: PluginUpstream) => [credential, headers, testRequest ?? null]
function configurationJson(upstreams: unknown): string {
  const ordered = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(ordered)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([key, item]) => [key, ordered(item)]),
          )
        : value
  return JSON.stringify(ordered(JSON.parse(JSON.stringify(upstreams))))
}

/** PostgreSQL facts retain public configuration separately from protected upstream values. */
export class PostgresPluginUpstreams implements PluginUpstreamsPort {
  private initialized = false
  private readonly lifecycle = new PlatformStoreLifecycle('Plugin upstream storage')
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
    if (!this.initialized && !('sql' in this.connection)) throw Error('Plugin upstream storage is not ready')
  }
  private cipher() {
    return 'sql' in this.connection ? this.connection.cipher : this.connection.cipher()
  }
  private async load(sql: PlatformSql, packageName: string) {
    const settings = await sql.query<SettingsRow>(
      `SELECT package_name,configuration,revision,receipt,
        COALESCE((SELECT jsonb_agg(to_jsonb(secret)) FROM dsh_phalanx.plugin_upstreams secret WHERE secret.package_name=plugin_upstream_settings.package_name),'[]'::jsonb) AS secrets
       FROM dsh_phalanx.plugin_upstream_settings WHERE package_name=$1`,
      [packageName],
    )
    const secrets = settings.flatMap(row => row.secrets)
    const byRecord = new Map(secrets.map(row => [recordId(row.package_name, row.name), row]))
    const plugins = new Map(
      settings.map(setting => [
        setting.package_name,
        setting.configuration.map((metadata): PluginUpstream => {
          const id = recordId(setting.package_name, metadata.name)
          const row = byRecord.get(id)
          let secretUnavailable = false
          const decode = <T>(field: string, envelope: PlatformSecretEnvelope | null | undefined, parse: (text: string) => T): T | undefined => {
            try {
              if (!envelope) throw Error('Plugin upstream secret is missing')
              return parse(upstreamSecrets.decrypt(this.cipher(), id, field, envelope))
            } catch {
              secretUnavailable = true
              return undefined
            }
          }
          const { testRequest: diagnostic, ...plain } = metadata
          const credential = decode('credential', row?.credential, text => text) ?? ''
          const testRequest = diagnostic
            ? (decode('testRequest', row?.test_request, text => JSON.parse(text) as NonNullable<PluginUpstream['testRequest']>) ?? null)
            : diagnostic
          const unreadableHeaders: string[] = []
          const headers = metadata.headers.map(({ name }, index) => {
            const value = decode('headers/' + name.toLowerCase(), row?.headers[index], text => text)
            if (value === undefined) unreadableHeaders.push(name)
            return { name, value: value ?? '' }
          })
          return {
            ...plain,
            credential,
            headers,
            ...(testRequest === undefined ? {} : { testRequest }),
            ...(secretUnavailable ? { secretUnavailable: true, unreadableHeaders } : {}),
          }
        }),
      ]),
    )
    return {
      plugins,
      revisions: new Map(settings.map(row => [row.package_name, row.revision])),
      receipts: new Map(settings.flatMap(row => (row.receipt ? [[row.package_name, row.receipt] as const] : []))),
    }
  }
  async list(packageName: string): Promise<readonly PluginUpstream[]> {
    this.ready()
    return pluginTransaction(this.connection, async sql => (await this.load(sql, packageName)).plugins.get(packageName) ?? [])
  }
  authorizationRevision(): string {
    this.ready()
    return pluginAuthorizationRevision(this.connection)
  }
  async revision(packageName: string): Promise<string> {
    return (await this.snapshot(packageName)).revision
  }
  async snapshot(packageName: string) {
    this.ready()
    return pluginTransaction(this.connection, async sql => {
      const row = await this.load(sql, packageName)
      const upstreams = row.plugins.get(packageName) ?? []
      return { upstreams, revision: upstreams.length ? row.revisions.get(packageName)! : 'none' }
    })
  }
  async receipt(packageName: string): Promise<ContributionReceipt | undefined> {
    this.ready()
    return pluginTransaction(this.connection, async sql => (await this.load(sql, packageName)).receipts.get(packageName))
  }
  private async lockRows(sql: PlatformSql, packageName: string): Promise<number | undefined> {
    const [plugin] = await sql.query<{ revision: string }>('SELECT revision FROM dsh_phalanx.plugin_library WHERE package_name=$1 FOR UPDATE', [packageName])
    await sql.query(
      `INSERT INTO dsh_phalanx.plugin_upstream_settings(package_name,configuration,revision) VALUES($1,'[]','none') ON CONFLICT(package_name) DO NOTHING`,
      [packageName],
    )
    await sql.query('SELECT package_name FROM dsh_phalanx.plugin_upstream_settings WHERE package_name=$1 FOR UPDATE', [packageName])
    return plugin && Number(plugin.revision)
  }
  async lock(packageName: string): Promise<void> {
    this.ready()
    if (!('sql' in this.connection)) throw Error('Plugin adoption locks require a transaction')
    await this.lockRows(this.connection.sql, packageName)
  }
  async save(
    packageName: string,
    upstreams: readonly PluginUpstream[],
    contribution?: ContributionReceipt,
    expectedRevision?: string,
    expectedPluginRevision?: number,
  ): Promise<void> {
    this.lifecycle.assertAccepting()
    this.ready()
    const next = structuredClone(upstreams),
      receipt = structuredClone(contribution)
    return this.lifecycle.write(() =>
      pluginTransaction(this.connection, async sql => {
        const pluginRevision = await this.lockRows(sql, packageName)
        const [current] = await sql.query<SettingsRow>(
          'SELECT package_name,configuration,revision,receipt FROM dsh_phalanx.plugin_upstream_settings WHERE package_name=$1 FOR UPDATE',
          [packageName],
        )
        if (
          (expectedPluginRevision !== undefined && expectedPluginRevision !== pluginRevision) ||
          (expectedRevision !== undefined && expectedRevision !== (current!.configuration.length ? current!.revision : 'none'))
        )
          throw new BusinessRuleError('conflict', 'Platform configuration changed. Reload before saving.', 'platform-configuration-conflict')
        const prior = (await this.load(sql, packageName)).plugins.get(packageName) ?? []
        const unchanged = configurationJson(prior) === configurationJson(next)
        const metadata = next.map(({ name, baseUrl, model, headers, testRequest, nativeServiceOnly, imageDisabled }) => ({
          name,
          baseUrl,
          ...(model === undefined ? {} : { model }),
          ...(nativeServiceOnly ? { nativeServiceOnly } : {}),
          ...(imageDisabled ? { imageDisabled } : {}),
          headers: headers.map(header => ({ name: header.name })),
          ...(testRequest !== undefined ? { testRequest: testRequest ? { method: testRequest.method } : null } : {}),
        }))
        const revision = unchanged ? current!.revision : randomUUID()
        await sql.query<{ receipt: ContributionReceipt | null }>(
          `UPDATE dsh_phalanx.plugin_upstream_settings SET configuration=$2,revision=$3,receipt=COALESCE($4,receipt) WHERE package_name=$1 RETURNING receipt`,
          [
            packageName,
            JSON.stringify(
              metadata.map((row, index) => {
                if (!next[index]?.secretUnavailable) return row
                const previous = current!.configuration.find(old => old.name === row.name)
                return previous ? { ...row, headers: previous.headers, testRequest: previous.testRequest } : row
              }),
            ),
            revision,
            receipt ? JSON.stringify(receipt) : null,
          ],
        )
        await sql.query('DELETE FROM dsh_phalanx.plugin_upstreams WHERE package_name=$1 AND NOT(name=ANY($2::text[]))', [
          packageName,
          next.map(row => row.name),
        ])
        for (const upstream of next) {
          const previous = prior.find(row => row.name === upstream.name)
          if (
            upstream.secretUnavailable ||
            (previous && !previous.secretUnavailable && configurationJson(protectedValues(previous)) === configurationJson(protectedValues(upstream)))
          )
            continue
          await sql.query(
            `INSERT INTO dsh_phalanx.plugin_upstreams(package_name,name,credential,headers,test_request) VALUES($1,$2,$3,$4,$5)
            ON CONFLICT(package_name,name) DO UPDATE SET credential=EXCLUDED.credential,headers=EXCLUDED.headers,test_request=EXCLUDED.test_request`,
            [
              packageName,
              upstream.name,
              JSON.stringify(upstreamSecrets.encrypt(this.cipher(), recordId(packageName, upstream.name), 'credential', upstream.credential)),
              JSON.stringify(
                upstream.headers.map(header =>
                  upstreamSecrets.encrypt(this.cipher(), recordId(packageName, upstream.name), 'headers/' + header.name.toLowerCase(), header.value),
                ),
              ),
              upstream.testRequest
                ? JSON.stringify(
                    upstreamSecrets.encrypt(this.cipher(), recordId(packageName, upstream.name), 'testRequest', JSON.stringify(upstream.testRequest)),
                  )
                : null,
            ],
          )
        }
      }),
    )
  }
}
