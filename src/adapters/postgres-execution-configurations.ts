import { executionCommandLock } from './advisory-locks.js'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { BusinessRuleError } from '../domain/business-error.js'
import { executionConfiguration } from '../domain/execution-configuration.js'
import type { ExecutionConfiguration } from '../domain/platform-execution.js'
import type { PlatformSecretEnvelope } from '../domain/platform-secret.js'
import type { ExecutionConfigurationStorePort } from '../ports/platform-execution.js'
import type { PlatformSql } from './platform-database.js'
import { PlatformStoreLifecycle } from './platform-store-lifecycle.js'
import { protectedTable } from './platform-secret-codec.js'
import { repositorySql, repositoryTransaction, type RowRepositoryConnection } from './postgres-row-repository.js'
import { PostgresRuntimeReferences } from './postgres-runtime-references.js'

type Metadata = Omit<ExecutionConfiguration, 'variables' | 'rowRevision'> & {
  variables: readonly { readonly name: string; readonly secret: boolean; readonly value?: string }[]
}
interface ConfigurationRow extends Record<string, unknown> {
  owner: string
  configuration: Metadata
  revision: string
  protected_values: readonly VariableRow[]
  dependencies: readonly string[]
}
interface VariableRow extends Record<string, unknown> {
  name: string
  value: PlatformSecretEnvelope
}
const variableSecrets = protectedTable('execution_variables')

/** Stateless owner rows and variable diffs; only accepted-write lifetime is held in process. */
export class PostgresExecutionConfigurations implements ExecutionConfigurationStorePort {
  private readonly lifecycle = new PlatformStoreLifecycle('Execution configuration storage')
  constructor(private readonly connection: RowRepositoryConnection) {}
  initialize(): Promise<void> {
    return this.lifecycle.initialize(async () => {
      this.cipher()
    })
  }
  close(): Promise<void> {
    return this.lifecycle.close()
  }
  async revision(owner: string): Promise<string> {
    this.lifecycle.assertOpen()
    return (
      (await repositorySql(this.connection).query<{ revision: string }>('SELECT revision FROM dsh_phalanx.execution_configurations WHERE owner=$1', [owner]))[0]
        ?.revision ?? 'none'
    )
  }
  async get(owner: string): Promise<ExecutionConfiguration | undefined> {
    this.lifecycle.assertOpen()
    return await repositoryTransaction(this.connection, async sql => (await this.read(sql, owner))[0]?.configuration)
  }
  async list(): Promise<readonly { readonly owner: string; readonly configuration: ExecutionConfiguration }[]> {
    this.lifecycle.assertOpen()
    return await repositoryTransaction(this.connection, sql => this.read(sql))
  }
  async save(owner: string, configuration: ExecutionConfiguration, expectedRevision = configuration.rowRevision ?? 'none'): Promise<void> {
    this.lifecycle.assertAccepting()
    const { rowRevision, runtimeDependencies, ...next } = structuredClone(configuration)
    void rowRevision
    const metadata: Metadata = {
      ...next,
      variables: next.variables.map(variable => (variable.secret ? { name: variable.name, secret: true } : variable)),
      ...(runtimeDependencies ? { runtimeDependencies: [] } : {}),
    }
    await this.lifecycle.write(() =>
      repositoryTransaction(this.connection, async sql => {
        const sources = owner.startsWith('skill:') ? await sql.query('SELECT name FROM dsh_phalanx.skills WHERE name=$1 FOR KEY SHARE', [owner.slice(6)]) : []
        if (!sources.length) throw new BusinessRuleError('missing', 'Execution owner is unavailable', 'skill-unavailable')
        const locked = (
          await sql.query<{ revision: string }>('SELECT revision FROM dsh_phalanx.execution_configurations WHERE owner=$1 FOR UPDATE', [owner])
        )[0]
        if ((locked?.revision ?? 'none') !== expectedRevision) throw this.changed()
        // A lock wait can advance the parent tuple beyond its statement snapshot. Decode children only from a fresh statement after CAS.
        const current = (await this.read(sql, owner))[0]?.configuration
        // An absent row has no gap lock; a creator may have committed since the lock query.
        if ((current?.rowRevision ?? 'none') !== expectedRevision) throw this.changed()
        const { rowRevision: previousRevision, ...previous } = current ?? {}
        void previousRevision
        const value = { ...next, ...(runtimeDependencies ? { runtimeDependencies } : {}) }
        if (current && isDeepStrictEqual(previous, value)) return
        await this.assertCommandsAvailable(sql, owner, configuration)
        const revision = randomUUID()
        if (current)
          await sql.query('UPDATE dsh_phalanx.execution_configurations SET configuration=$2,revision=$3 WHERE owner=$1', [
            owner,
            JSON.stringify(metadata),
            revision,
          ])
        else {
          const saved = await sql.query(
            'INSERT INTO dsh_phalanx.execution_configurations(owner,configuration,revision,source_skill) VALUES($1,$2,$3,$4) ON CONFLICT(owner) DO NOTHING RETURNING owner',
            [owner, JSON.stringify(metadata), revision, owner.slice(6)],
          )
          if (!saved.length) throw this.changed()
        }
        const names = next.variables.filter(variable => variable.secret).map(variable => variable.name)
        await sql.query('DELETE FROM dsh_phalanx.execution_variables WHERE owner=$1 AND NOT(name=ANY($2::text[]))', [owner, names])
        for (const variable of next.variables.filter(variable => variable.secret)) {
          const old = current?.variables.find(row => row.name === variable.name && row.secret)
          if (old && old.value === variable.value) continue
          await sql.query(
            `INSERT INTO dsh_phalanx.execution_variables(owner,name,value) VALUES($1,$2,$3)
          ON CONFLICT(owner,name) DO UPDATE SET value=EXCLUDED.value`,
            [owner, variable.name, JSON.stringify(variableSecrets.encrypt(this.cipher(), JSON.stringify([owner, variable.name]), 'value', variable.value))],
          )
        }
        await new PostgresRuntimeReferences({ sql, cipher: this.cipher() }).replace({ kind: 'execution', name: owner }, runtimeDependencies ?? [])
      }),
    )
  }
  async remove(owner: string, expectedRevision?: string): Promise<void> {
    this.lifecycle.assertAccepting()
    await this.lifecycle.write(() =>
      repositoryTransaction(this.connection, async sql => {
        const current = (
          await sql.query<{ revision: string }>('SELECT revision FROM dsh_phalanx.execution_configurations WHERE owner=$1 FOR UPDATE', [owner])
        )[0]
        if (expectedRevision !== undefined && (current?.revision ?? 'none') !== expectedRevision) throw this.changed()
        if (!current) return
        await new PostgresRuntimeReferences({ sql, cipher: this.cipher() }).removeOwner({ kind: 'execution', name: owner })
        await sql.query('DELETE FROM dsh_phalanx.execution_configurations WHERE owner=$1', [owner])
      }),
    )
  }
  private async read(sql: PlatformSql, owner?: string): Promise<{ owner: string; configuration: ExecutionConfiguration }[]> {
    const rows = await sql.query<ConfigurationRow>(
      `SELECT configurations.owner,configuration,revision,
       COALESCE((SELECT jsonb_agg(jsonb_build_object('name',name,'value',value)) FROM dsh_phalanx.execution_variables WHERE owner=configurations.owner),'[]'::jsonb) AS protected_values,
       ARRAY(SELECT dependency FROM dsh_phalanx.execution_runtime_dependencies WHERE owner_id=configurations.owner AND owner_scope='current' ORDER BY position) AS dependencies
       FROM dsh_phalanx.execution_configurations configurations${owner === undefined ? '' : ' WHERE configurations.owner=$1'} ORDER BY configurations.owner`,
      owner === undefined ? [] : [owner],
    )
    const result: { owner: string; configuration: ExecutionConfiguration }[] = []
    for (const row of rows) {
      const names = row.dependencies,
        secrets = new Map(row.protected_values.map(variable => [variable.name, variable.value]))
      const { contributionReceipt, awaitingPreparation, approvedContribution, suiteOrigin } = row.configuration
      if (
        (contributionReceipt !== undefined &&
          (!contributionReceipt || typeof contributionReceipt.id !== 'string' || typeof contributionReceipt.revision !== 'string')) ||
        (awaitingPreparation !== undefined && typeof awaitingPreparation !== 'boolean') ||
        (approvedContribution !== undefined && (typeof approvedContribution !== 'string' || !approvedContribution)) ||
        (suiteOrigin !== undefined && (typeof suiteOrigin !== 'string' || !suiteOrigin.startsWith('suite:')))
      )
        throw Error('Execution configuration could not be loaded')
      const decoded = row.configuration.variables.map(variable => ({
        name: variable.name,
        secret: variable.secret,
        value: variable.secret
          ? variableSecrets.decrypt(this.cipher(), JSON.stringify([row.owner, variable.name]), 'value', secrets.get(variable.name)!)
          : (variable.value ?? ''),
      }))
      result.push({
        owner: row.owner,
        configuration: {
          ...executionConfiguration({
            ...row.configuration,
            variables: decoded,
            ...(Object.hasOwn(row.configuration, 'runtimeDependencies') || names.length ? { runtimeDependencies: names } : {}),
          }),
          rowRevision: row.revision,
          ...(contributionReceipt ? { contributionReceipt } : {}),
          ...(awaitingPreparation === undefined ? {} : { awaitingPreparation }),
          ...(approvedContribution ? { approvedContribution } : {}),
          ...(suiteOrigin ? { suiteOrigin } : {}),
        },
      })
    }
    return result
  }
  private async assertCommandsAvailable(sql: PlatformSql, owner: string, configuration: ExecutionConfiguration): Promise<void> {
    if (!configuration.enabled) return
    const commands = [...new Set(configuration.commands.map(row => row.command).filter(command => !command.includes('/')))].sort()
    for (const command of commands) await sql.query(executionCommandLock, [command])
    const conflicts = await sql.query(
      `SELECT owner FROM dsh_phalanx.execution_configurations
       WHERE owner<>$1 AND (configuration->>'enabled')::boolean
       AND EXISTS(SELECT 1 FROM jsonb_array_elements(configuration->'commands') command WHERE command->>'command'=ANY($2::text[])) LIMIT 1`,
      [owner, commands],
    )
    if (conflicts.length) throw new BusinessRuleError('invalid', 'A command name is already delegated by another owner.', 'execution-config-invalid')
  }
  private cipher() {
    return 'sql' in this.connection ? this.connection.cipher : this.connection.cipher()
  }
  private changed() {
    return new BusinessRuleError('conflict', 'Platform configuration changed. Reload before saving.', 'platform-configuration-conflict')
  }
}
