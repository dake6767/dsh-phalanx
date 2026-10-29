import { mcpNameLock } from './advisory-locks.js'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { BusinessRuleError } from '../domain/business-error.js'
import type { McpService } from '../domain/mcp-service.js'
import { normalizeMcpProtectedValues, type McpSecretContext } from '../domain/mcp-protected-values.js'
import { mcpBindingMetadata, mcpRuntimeBindings, withMcpRuntimeBindings } from '../domain/mcp-runtime-bindings.js'
import type { PlatformSecretEnvelope } from '../domain/platform-secret.js'
import type { McpServiceRowsPort } from '../ports/mcp-services.js'
import { encodeMcpRecord, mapMcpProtectedValues, type McpProtectedField } from './mcp-record-codec.js'
import type { PlatformSql } from './platform-database.js'
import { PlatformStoreLifecycle } from './platform-store-lifecycle.js'
import { protectedTable } from './platform-secret-codec.js'
import { repositorySql, repositoryTransaction, type RowRepositoryConnection } from './postgres-row-repository.js'
import { PostgresRuntimeReferences } from './postgres-runtime-references.js'

interface McpRow {
  name: string
  configuration: Omit<McpService, 'name' | 'generation' | 'rowRevision'>
  generation: string
  row_revision: string
  protected_fields: readonly McpProtectedField[]
  secrets: readonly { scope: string; field: string; value: PlatformSecretEnvelope }[]
  bindings: Readonly<Record<string, readonly string[]>>
}
const secrets = protectedTable('mcp_secrets')
const key = (scope: string, field: string) => JSON.stringify([scope, field])

/** One service owns its current/candidate values; ordinary reads never retain a library snapshot. */
export class PostgresMcpStore implements McpServiceRowsPort {
  private readonly lifecycle = new PlatformStoreLifecycle('MCP service storage')
  constructor(private readonly connection: RowRepositoryConnection) {}
  initialize(): Promise<void> {
    return this.lifecycle.initialize(async () => {
      this.cipher()
    })
  }
  close(): Promise<void> {
    return this.lifecycle.close()
  }
  async get(name: string): Promise<McpService | undefined> {
    this.lifecycle.assertOpen()
    const row = (await this.rows(repositorySql(this.connection), name))[0]
    return row ? this.decode(row) : undefined
  }
  async list(): Promise<readonly McpService[]> {
    this.lifecycle.assertOpen()
    return (await this.rows(repositorySql(this.connection))).map(row => this.decode(row))
  }
  async policyRows(): Promise<readonly McpService[]> {
    this.lifecycle.assertOpen()
    return (await this.rows(repositorySql(this.connection), undefined, false, false)).map(row => this.metadata(row))
  }
  async lock(name: string, expectedRevision: string): Promise<void> {
    const row = (
      await repositorySql(this.connection).query<{ row_revision: string }>('SELECT row_revision FROM dsh_phalanx.mcp_services WHERE name=$1 FOR UPDATE', [name])
    )[0]
    if ((row?.row_revision ?? 'none') !== expectedRevision) throw this.changed()
  }
  async save(service: McpService, protection: McpSecretContext, expectedRevision = service.rowRevision ?? 'none'): Promise<void> {
    this.lifecycle.assertAccepting()
    const next = normalizeMcpProtectedValues(structuredClone(service), protection)
    await this.lifecycle.write(() =>
      repositoryTransaction(this.connection, async sql => {
        const row = (await this.rows(sql, service.name, true))[0]
        if ((row?.row_revision ?? 'none') !== expectedRevision) throw this.changed()
        const previous = row ? this.decode(row) : undefined
        const { rowRevision, ...value } = next
        void rowRevision
        const { rowRevision: oldRevision, ...old } = previous ?? {}
        void oldRevision
        if (previous && isDeepStrictEqual(value, old)) return
        await this.assertNamesAvailable(sql, next)
        const encoded = encodeMcpRecord(mcpBindingMetadata(next), protection.known)
        const { name, generation, rowRevision: ignored, ...configuration } = encoded.metadata
        void ignored
        const parameters = [name, JSON.stringify(configuration), JSON.stringify(encoded.fields), generation, randomUUID()]
        const saved = await sql.query(
          row
            ? 'UPDATE dsh_phalanx.mcp_services SET configuration=$2,protected_fields=$3,generation=$4,row_revision=$5 WHERE name=$1 RETURNING name'
            : 'INSERT INTO dsh_phalanx.mcp_services(name,configuration,protected_fields,generation,row_revision) VALUES($1,$2,$3,$4,$5) ON CONFLICT(name) DO NOTHING RETURNING name',
          parameters,
        )
        if (!saved.length) throw this.changed()
        const oldValues = new Map<string, string>()
        if (previous)
          mapMcpProtectedValues(previous, (scope, field, value) => {
            oldValues.set(key(scope, field), value)
            return value
          })
        const oldFields = new Set(row?.protected_fields.map(field => key(field.scope, field.field)))
        await sql.query(
          `DELETE FROM dsh_phalanx.mcp_secrets WHERE service=$1 AND NOT EXISTS(
        SELECT 1 FROM jsonb_to_recordset($2::jsonb) retained(scope text,field text)
        WHERE retained.scope=mcp_secrets.scope AND retained.field=mcp_secrets.field)`,
          [name, JSON.stringify(encoded.fields)],
        )
        for (const { position, value } of encoded.secrets) {
          if (oldFields.has(key(position.scope, position.field)) && oldValues.get(key(position.scope, position.field)) === value) continue
          await sql.query(
            `INSERT INTO dsh_phalanx.mcp_secrets(service,scope,field,value) VALUES($1,$2,$3,$4)
          ON CONFLICT(service,scope,field) DO UPDATE SET value=EXCLUDED.value`,
            [
              name,
              position.scope,
              position.field,
              JSON.stringify(secrets.encrypt(this.cipher(), JSON.stringify([name, position.scope]), position.field, value)),
            ],
          )
        }
        const references = new PostgresRuntimeReferences({ sql, cipher: this.cipher() })
        const bindings = mcpRuntimeBindings(next)
        for (const scope of [...new Set([...Object.keys(row?.bindings ?? {}), ...bindings.keys()])].sort())
          await references.replace({ kind: 'mcp', name }, bindings.get(scope) ?? [], scope)
        // A new member choice committed since the caller's snapshot must retire too.
        if (!next.published) {
          const members = await sql.query<{ space_id: string }>(
            `SELECT space_id FROM dsh_phalanx.mcp_member_settings
          WHERE space_id IN (SELECT space_id FROM dsh_phalanx.mcp_selections WHERE service=$1) ORDER BY space_id FOR UPDATE`,
            [name],
          )
          await sql.query('DELETE FROM dsh_phalanx.mcp_selections WHERE service=$1', [name])
          for (const member of members)
            await sql.query('UPDATE dsh_phalanx.mcp_member_settings SET row_revision=$2 WHERE space_id=$1', [member.space_id, randomUUID()])
        }
      }),
    )
  }
  async remove(name: string, expectedRevision: string): Promise<void> {
    this.lifecycle.assertAccepting()
    await this.lifecycle.write(() =>
      repositoryTransaction(this.connection, async sql => {
        const row = (await sql.query<{ row_revision: string }>('SELECT row_revision FROM dsh_phalanx.mcp_services WHERE name=$1 FOR UPDATE', [name]))[0]
        if ((row?.row_revision ?? 'none') !== expectedRevision) throw this.changed()
        await sql.query('DELETE FROM dsh_phalanx.mcp_services WHERE name=$1', [name])
      }),
    )
  }
  private async assertNamesAvailable(sql: PlatformSql, service: McpService): Promise<void> {
    const names = new Set<string>()
    let current: McpService | undefined = service
    while (current) {
      names.add(current.name)
      current = current.catalogUpdate?.candidate
    }
    const keys = [...names].sort()
    const roots = await sql.query('SELECT name FROM dsh_phalanx.mcp_services WHERE name<>$1 AND name=ANY($2::text[])', [service.name, keys])
    if (roots.length) throw new BusinessRuleError('conflict', 'This MCP service name is already in use.', 'mcp-name-conflict')
    for (const name of keys) await sql.query(mcpNameLock, [name])
    const conflicts = await sql.query(
      `WITH RECURSIVE candidates AS (
      SELECT name AS owner,name,configuration->'catalogUpdate'->'candidate' AS child FROM dsh_phalanx.mcp_services
      UNION ALL SELECT owner,child->>'name',child->'catalogUpdate'->'candidate' FROM candidates WHERE child IS NOT NULL AND child<>'null'::jsonb
    ) SELECT owner FROM candidates WHERE owner<>$1 AND name=ANY($2::text[]) LIMIT 1`,
      [service.name, keys],
    )
    if (conflicts.length) throw new BusinessRuleError('conflict', 'This MCP service name is already in use.', 'mcp-name-conflict')
  }
  private rows(sql: PlatformSql, name?: string, writing = false, includeSecrets = true): Promise<readonly McpRow[]> {
    return sql.query<McpRow>(
      `SELECT service.*,
      ${
        includeSecrets
          ? `(SELECT COALESCE(jsonb_agg(jsonb_build_object('scope',scope,'field',field,'value',value)),'[]')
        FROM dsh_phalanx.mcp_secrets WHERE service=service.name)`
          : "'[]'::jsonb"
      } AS secrets,
      (SELECT COALESCE(jsonb_object_agg(owner_scope,names),'{}') FROM (
        SELECT owner_scope,array_agg(dependency ORDER BY position) AS names FROM dsh_phalanx.mcp_runtime_dependencies
        WHERE owner_id=service.name GROUP BY owner_scope) bindings) AS bindings
      FROM dsh_phalanx.mcp_services service${name === undefined ? '' : ' WHERE service.name=$1'} ORDER BY service.name${writing ? ' FOR UPDATE OF service' : ''}`,
      name === undefined ? [] : [name],
    )
  }
  private metadata(row: McpRow): McpService {
    const generation = Number(row.generation)
    if (!Number.isSafeInteger(generation) || generation < 0) throw Error('Invalid MCP generation')
    return withMcpRuntimeBindings({ ...row.configuration, name: row.name, generation, rowRevision: row.row_revision }, row.bindings)
  }
  private decode(row: McpRow): McpService {
    const expected = new Set(row.protected_fields.map(field => key(field.scope, field.field)))
    const values = new Map(row.secrets.map(field => [key(field.scope, field.field), field.value]))
    return mapMcpProtectedValues(this.metadata(row), (scope, field, value) =>
      expected.has(key(scope, field)) ? secrets.decrypt(this.cipher(), JSON.stringify([row.name, scope]), field, values.get(key(scope, field))!) : value,
    )
  }
  private cipher() {
    return 'sql' in this.connection ? this.connection.cipher : this.connection.cipher()
  }
  private changed() {
    return new BusinessRuleError('conflict', 'Platform configuration changed. Reload before saving.', 'platform-configuration-conflict')
  }
}
