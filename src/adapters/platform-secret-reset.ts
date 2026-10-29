import { randomUUID } from 'node:crypto'
import type { PluginUpstream } from '../domain/plugin-upstream.js'
import { resetMcpStateSecrets } from './mcp-record-codec.js'
import { mcpBindingMetadata, mcpRuntimeBindings } from '../domain/mcp-runtime-bindings.js'
import { PostgresMcpStore } from './postgres-mcp-store.js'
import { PostgresMcpMetadata } from './postgres-mcp-metadata.js'
import { PostgresRuntimeReferences } from './postgres-runtime-references.js'
import { resetPluginAccessSecrets } from './postgres-plugin-access-store.js'
import { isDeepStrictEqual } from 'node:util'
import type { PlatformSecretRegistry } from '../domain/platform-secret.js'
import { FilePlatformSecrets } from './platform-secrets.js'
import type { PlatformSql } from './platform-database.js'

/** Each database commits secret clearing and its new registry in the same transaction. */
export async function resetPlatformDatabaseSecrets(
  database: PlatformSql,
  masterKeyPath: string,
  oldRegistry: PlatformSecretRegistry,
  registry: PlatformSecretRegistry,
): Promise<void> {
  const secrets = FilePlatformSecrets.open(masterKeyPath, registry)
  let begun = false
  try {
    await database.query('BEGIN')
    begun = true
    const current = (await database.query<{ registry: PlatformSecretRegistry }>('SELECT registry FROM dsh_phalanx.platform_security WHERE id=1 FOR UPDATE'))[0]!
      .registry
    if (isDeepStrictEqual(current, registry)) {
      await database.query('COMMIT')
      return
    }
    if (!isDeepStrictEqual(current, oldRegistry)) throw Error('The platform key registry changed before reset')
    const providers = await database.query<{ id: string }>('SELECT id FROM dsh_phalanx.shared_model_providers')
    for (const provider of providers)
      await database.query('UPDATE dsh_phalanx.shared_model_providers SET api_key=$2 WHERE id=$1', [
        provider.id,
        JSON.stringify(secrets.encrypt({ table: 'shared_model_providers', recordId: provider.id, field: 'api_key' }, '')),
      ])
    await database.query('UPDATE dsh_phalanx.shared_model_settings SET revision=revision+1 WHERE id=1')
    await database.query('DELETE FROM dsh_phalanx.session_signing_key')
    await database.query('DELETE FROM dsh_phalanx.model_access_tokens')
    const upstreams = await database.query<{ package_name: string; configuration: PluginUpstream[] }>(
      'SELECT package_name,configuration FROM dsh_phalanx.plugin_upstream_settings',
    )
    for (const row of upstreams) {
      for (const upstream of row.configuration) {
        const context = (field: string) => ({ table: 'plugin_upstreams', recordId: JSON.stringify([row.package_name, upstream.name]), field })
        const credential = secrets.encrypt(context('credential'), '')
        const headers = upstream.headers.map(header => secrets.encrypt(context('headers/' + header.name.toLowerCase()), ''))
        await database.query('UPDATE dsh_phalanx.plugin_upstreams SET credential=$3,headers=$4,test_request=NULL WHERE package_name=$1 AND name=$2', [
          row.package_name,
          upstream.name,
          JSON.stringify(credential),
          JSON.stringify(headers),
        ])
      }
      await database.query('UPDATE dsh_phalanx.plugin_upstream_settings SET configuration=$2,revision=$3 WHERE package_name=$1', [
        row.package_name,
        JSON.stringify(row.configuration.map(upstream => ({ ...upstream, testRequest: null }))),
        randomUUID(),
      ])
    }
    const variables = await database.query<{ owner: string; name: string }>('SELECT owner,name FROM dsh_phalanx.execution_variables')
    for (const row of variables)
      await database.query('UPDATE dsh_phalanx.execution_variables SET value=$3 WHERE owner=$1 AND name=$2', [
        row.owner,
        row.name,
        JSON.stringify(secrets.encrypt({ table: 'execution_variables', recordId: JSON.stringify([row.owner, row.name]), field: 'value' }, '')),
      ])
    const executions = await database.query<{ owner: string }>('SELECT owner FROM dsh_phalanx.execution_configurations')
    for (const row of executions) await database.query('UPDATE dsh_phalanx.execution_configurations SET revision=$2 WHERE owner=$1', [row.owner, randomUUID()])
    const connection = { sql: database, cipher: secrets }
    const mcpRows = new PostgresMcpStore(connection),
      mcpMetadata = new PostgresMcpMetadata(connection)
    const fields = await database.query<{ protected_fields: Parameters<typeof resetMcpStateSecrets>[1] }>(
      'SELECT protected_fields FROM dsh_phalanx.mcp_services',
    )
    const generation = await mcpMetadata.generation()
    const cleared = resetMcpStateSecrets(
      { services: await mcpRows.policyRows(), grants: {}, revision: generation },
      fields.flatMap(row => row.protected_fields),
    )
    for (const service of cleared.services) {
      const { name, generation, rowRevision, ...configuration } = mcpBindingMetadata(service)
      void rowRevision
      await database.query("UPDATE dsh_phalanx.mcp_services SET configuration=$2,protected_fields='[]',generation=$3,row_revision=$4 WHERE name=$1", [
        name,
        JSON.stringify(configuration),
        generation,
        randomUUID(),
      ])
      const prior = await database.query<{ owner_scope: string }>('SELECT DISTINCT owner_scope FROM dsh_phalanx.mcp_runtime_dependencies WHERE owner_id=$1', [
        name,
      ])
      const bindings = mcpRuntimeBindings(service),
        references = new PostgresRuntimeReferences(connection)
      for (const scope of [...new Set([...prior.map(row => row.owner_scope), ...bindings.keys()])].sort())
        await references.replace({ kind: 'mcp', name }, bindings.get(scope) ?? [], scope)
    }
    await mcpMetadata.advance(generation, cleared.revision ?? generation)
    await database.query('DELETE FROM dsh_phalanx.mcp_secrets')
    const access = await database.query<{ package_name: string; configuration: Parameters<typeof resetPluginAccessSecrets>[0]; commit_version: string }>(
      'SELECT package_name,configuration,commit_version FROM dsh_phalanx.plugin_access_settings',
    )
    for (const row of access) {
      if (Number(row.commit_version) >= Number.MAX_SAFE_INTEGER) throw Error('Plugin authorization version is exhausted')
      await database.query("UPDATE dsh_phalanx.plugin_access_settings SET configuration=$2,fields='[]',commit_version=commit_version+1 WHERE package_name=$1", [
        row.package_name,
        JSON.stringify(resetPluginAccessSecrets(row.configuration)),
      ])
    }
    await database.query('DELETE FROM dsh_phalanx.plugin_access_secrets')
    // Keep immutable setup metadata/fields so confirmed intents require review again.
    await database.query('DELETE FROM dsh_phalanx.contribution_setup_secrets')
    await database.query('UPDATE dsh_phalanx.platform_security SET registry=$1 WHERE id=1', [JSON.stringify(registry)])
    await database.query('COMMIT')
  } catch (error) {
    if (begun) await database.query('ROLLBACK')
    throw error
  } finally {
    secrets.close()
  }
}
