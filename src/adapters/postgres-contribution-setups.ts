import { randomUUID } from 'node:crypto'
import type { ContributionSetup } from '../domain/member-contribution.js'
import { mapContributionSetup } from '../domain/contribution-setup.js'
import { redactMcpValue } from '../domain/mcp-protocol.js'
import type { ContributionSetupStore } from '../ports/member-contributions.js'
import type { PlatformSecretEnvelope } from '../domain/platform-secret.js'
import { repositorySql, repositoryTransaction, type RowRepositoryConnection } from './postgres-row-repository.js'
import { PlatformStoreLifecycle } from './platform-store-lifecycle.js'
import { protectedTable } from './platform-secret-codec.js'

interface SetupIdentity {
  readonly id: string
  readonly revision: string
}
interface Row extends Record<string, unknown> {
  reference: string
  id: string
  revision: string
  configuration: ContributionSetup
  fields: string[]
  secrets: Readonly<Record<string, PlatformSecretEnvelope | null>>
}
const setupSecrets = protectedTable('contribution_setup_secrets')
const recordOf = (identity: SetupIdentity, reference: string) => JSON.stringify([identity.id, identity.revision, reference])

/** Immutable adoption setup rows are read only for their contribution identity. */
export class PostgresContributionSetups implements ContributionSetupStore {
  private readonly lifecycle = new PlatformStoreLifecycle('Contribution setup storage')
  constructor(private readonly connection: RowRepositoryConnection) {}
  initialize(): Promise<void> {
    return this.lifecycle.initialize(async () => {
      this.cipher()
    })
  }
  close(): Promise<void> {
    return this.lifecycle.close()
  }
  async read(reference: string, identity: SetupIdentity): Promise<ContributionSetup | undefined> {
    this.lifecycle.assertOpen()
    const row = (
      await repositorySql(this.connection).query<Row>(
        `SELECT s.reference,s.id,s.revision,s.configuration,s.fields,
        COALESCE((SELECT jsonb_object_agg(v.field,v.value) FROM dsh_phalanx.contribution_setup_secrets v
          WHERE v.reference=s.reference),'{}'::jsonb) AS secrets
       FROM dsh_phalanx.contribution_setups s WHERE s.reference=$1 AND s.id=$2 AND s.revision=$3`,
        [reference, identity.id, identity.revision],
      )
    )[0]
    if (!row) return undefined
    const fields = new Set(row.fields)
    let unavailable = false
    const setup = mapContributionSetup(row.configuration, (path, value) => {
      const field = JSON.stringify(path)
      if (!fields.has(field)) return value
      try {
        const envelope = row.secrets[field]
        if (!envelope) throw Error('Contribution setup secret is unavailable')
        return setupSecrets.decrypt(this.cipher(), recordOf(row, reference), field, envelope)
      } catch {
        unavailable = true
        return ''
      }
    })
    return unavailable ? undefined : setup
  }
  async save(identity: SetupIdentity, input: ContributionSetup): Promise<string> {
    this.lifecycle.assertAccepting()
    const owner = { id: identity.id, revision: identity.revision }
    const setup = structuredClone(input),
      reference = randomUUID(),
      known: string[] = [],
      secrets: { field: string; value: string }[] = []
    mapContributionSetup(setup, (_path, value, sensitive) => {
      if (sensitive && value) known.push(value)
      return value
    })
    const metadata = mapContributionSetup(setup, (path, value, sensitive) => {
      if (!value || (!sensitive && redactMcpValue(value, known) === value)) return value
      secrets.push({ field: JSON.stringify(path), value })
      return ''
    })
    const operation = this.lifecycle.write(async () => {
      await repositoryTransaction(this.connection, async sql => {
        await sql.query('INSERT INTO dsh_phalanx.contribution_setups(reference,id,revision,configuration,fields) VALUES($1,$2,$3,$4,$5)', [
          reference,
          owner.id,
          owner.revision,
          JSON.stringify(metadata),
          JSON.stringify(secrets.map(row => row.field)),
        ])
        for (const { field, value } of secrets)
          await sql.query('INSERT INTO dsh_phalanx.contribution_setup_secrets(reference,field,value) VALUES($1,$2,$3)', [
            reference,
            field,
            JSON.stringify(setupSecrets.encrypt(this.cipher(), recordOf(owner, reference), field, value)),
          ])
      })
      return reference
    })
    return operation
  }
  async remove(reference: string): Promise<void> {
    this.lifecycle.assertAccepting()
    const operation = this.lifecycle.write(async () => {
      await repositoryTransaction(this.connection, async sql => {
        await sql.query('DELETE FROM dsh_phalanx.contribution_setups WHERE reference=$1', [reference])
      })
    })
    return operation
  }
  private cipher() {
    return 'sql' in this.connection ? this.connection.cipher : this.connection.cipher()
  }
}
