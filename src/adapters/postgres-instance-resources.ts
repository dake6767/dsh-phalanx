import { BusinessRuleError } from '../domain/business-error.js'
import { instanceIdleSeconds, instanceResourceLimits, type InstanceResourceLimits, type InstanceResourceState } from '../domain/instance-resources.js'
import type { InstanceResourceRows } from '../ports/instance-resource-rows.js'
import { AdvisoryLock, transactionSharedLock } from './advisory-locks.js'
import type { PlatformSql } from './platform-database.js'
import { repositorySql, repositoryTransaction, type RowRepositoryConnection } from './postgres-row-repository.js'

/** SQL is the current view; writes change only the shared header and the requested space. */
export class PostgresInstanceResources implements InstanceResourceRows {
  constructor(private readonly connection: RowRepositoryConnection) {}
  async initialize(defaults: InstanceResourceLimits, idleSeconds: number): Promise<void> {
    const limits = instanceResourceLimits(defaults)
    await repositorySql(this.connection).query(
      'INSERT INTO dsh_phalanx.instance_resource_settings(id,revision,cpus,memory_mib,pids,idle_seconds) VALUES(1,0,$1,$2,$3,$4) ON CONFLICT(id) DO NOTHING',
      [limits.cpus, limits.memoryMiB, limits.pids, instanceIdleSeconds(idleSeconds)],
    )
  }
  async read(): Promise<InstanceResourceState> {
    const row = (
      await repositorySql(this.connection).query<{
        revision: string
        idle_seconds: string
        defaults: InstanceResourceLimits
        overrides: Record<string, InstanceResourceLimits>
        residents: Record<string, true>
      }>(`SELECT revision,idle_seconds,jsonb_build_object('cpus',cpus,'memoryMiB',memory_mib,'pids',pids) AS defaults,
        COALESCE((SELECT jsonb_object_agg(space_id,jsonb_build_object('cpus',cpus,'memoryMiB',memory_mib,'pids',pids))
          FROM dsh_phalanx.instance_resource_overrides),'{}'::jsonb) AS overrides,
        COALESCE((SELECT jsonb_object_agg(space_id,true) FROM dsh_phalanx.resident_instances),'{}'::jsonb) AS residents
        FROM dsh_phalanx.instance_resource_settings WHERE id=1`)
    )[0]
    if (!row) throw new Error('Instance resource settings are not initialized')
    return { revision: Number(row.revision), idleSeconds: Number(row.idle_seconds), defaults: row.defaults, overrides: row.overrides, residents: row.residents }
  }
  async saveDefaults(expectedRevision: number, limits: InstanceResourceLimits, idleSeconds: number): Promise<void> {
    limits = instanceResourceLimits(limits)
    idleSeconds = instanceIdleSeconds(idleSeconds)
    await repositoryTransaction(this.connection, async sql => {
      await this.advance(sql, expectedRevision)
      await sql.query('UPDATE dsh_phalanx.instance_resource_settings SET cpus=$1,memory_mib=$2,pids=$3,idle_seconds=$4 WHERE id=1', [
        limits.cpus,
        limits.memoryMiB,
        limits.pids,
        idleSeconds,
      ])
    })
  }
  async saveMember(expectedRevision: number, spaceId: string, override: InstanceResourceLimits | null, resident?: boolean): Promise<void> {
    const limits = override === null ? null : instanceResourceLimits(override)
    if (resident !== undefined && typeof resident !== 'boolean') throw new Error('Invalid resident instance setting')
    await repositoryTransaction(this.connection, async sql => {
      await sql.query(transactionSharedLock(AdvisoryLock.accounts))
      const account = await sql.query('SELECT space_id FROM dsh_phalanx.accounts WHERE space_id=$1 FOR KEY SHARE', [spaceId])
      if (!account.length) throw this.changed()
      await this.advance(sql, expectedRevision)
      if (limits)
        await sql.query(
          `INSERT INTO dsh_phalanx.instance_resource_overrides(space_id,cpus,memory_mib,pids) VALUES($1,$2,$3,$4)
          ON CONFLICT(space_id) DO UPDATE SET cpus=EXCLUDED.cpus,memory_mib=EXCLUDED.memory_mib,pids=EXCLUDED.pids`,
          [spaceId, limits.cpus, limits.memoryMiB, limits.pids],
        )
      else await sql.query('DELETE FROM dsh_phalanx.instance_resource_overrides WHERE space_id=$1', [spaceId])
      if (resident === true) await sql.query('INSERT INTO dsh_phalanx.resident_instances(space_id) VALUES($1) ON CONFLICT DO NOTHING', [spaceId])
      if (resident === false) await sql.query('DELETE FROM dsh_phalanx.resident_instances WHERE space_id=$1', [spaceId])
    })
  }
  private async advance(sql: PlatformSql, expectedRevision: number): Promise<void> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw this.changed()
    const rows = await sql.query('UPDATE dsh_phalanx.instance_resource_settings SET revision=revision+1 WHERE id=1 AND revision=$1 RETURNING revision', [
      expectedRevision,
    ])
    if (!rows.length) throw this.changed()
  }
  private changed() {
    return new BusinessRuleError('conflict', 'Instance resource settings changed. Reload before saving or applying.', 'instance-resource-revision-conflict')
  }
}
