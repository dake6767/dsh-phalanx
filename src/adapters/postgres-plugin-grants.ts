import type { ContributionReceipt } from '../domain/contribution-receipt.js'
import { assertPluginGroupConfiguration } from '../domain/plugin-group-configuration.js'
import type { PluginGroupConfigurationPort } from '../ports/managed-plugins.js'
import { pluginAuthorizationRevision, pluginSql, pluginTransaction, type PluginRepositoryConnection } from './postgres-plugin-repository.js'

/** Grants, preinstalls and adoption receipts have independent lifetimes. */
export class PostgresPluginGrants implements PluginGroupConfigurationPort {
  constructor(private readonly connection: PluginRepositoryConnection) {}
  authorizationRevision(): string {
    return pluginAuthorizationRevision(this.connection)
  }
  async contributionReceipt(groupId: string, packageName: string): Promise<ContributionReceipt | undefined> {
    return (
      await pluginSql(this.connection).query<{ receipt: ContributionReceipt }>(
        'SELECT receipt FROM dsh_phalanx.plugin_grant_receipts WHERE group_id=$1 AND package_name=$2',
        [groupId, packageName],
      )
    )[0]?.receipt
  }
  async grantContribution(groupId: string, packageName: string, receipt: ContributionReceipt): Promise<void> {
    await pluginTransaction(this.connection, async sql => {
      await sql.query('SELECT id FROM dsh_phalanx.groups WHERE id=$1 FOR UPDATE', [groupId])
      const grants = new PostgresPluginGrants({ sql, cipher: 'sql' in this.connection ? this.connection.cipher : this.connection.cipher() })
      const controlled = await grants.get(groupId),
        preinstalled = await grants.preinstalls(groupId)
      assertPluginGroupConfiguration([...controlled, packageName], preinstalled)
      await sql.query(
        `INSERT INTO dsh_phalanx.plugin_grants(group_id,package_name,mode) VALUES($1,$2,'controlled') ON CONFLICT(group_id,package_name) DO NOTHING`,
        [groupId, packageName],
      )
      await sql.query(
        `INSERT INTO dsh_phalanx.plugin_grant_receipts(group_id,package_name,receipt) VALUES($1,$2,$3) ON CONFLICT(group_id,package_name) DO UPDATE SET receipt=EXCLUDED.receipt`,
        [groupId, packageName, JSON.stringify(receipt)],
      )
    })
  }
  async get(groupId: string): Promise<readonly string[]> {
    return this.names(groupId, 'controlled')
  }
  async preinstalls(groupId: string): Promise<readonly string[]> {
    return this.names(groupId, 'preinstall')
  }
  private async names(groupId: string, mode: string): Promise<readonly string[]> {
    return (
      await pluginSql(this.connection).query<{ package_name: string }>(
        'SELECT package_name FROM dsh_phalanx.plugin_grants WHERE group_id=$1 AND mode=$2 ORDER BY package_name',
        [groupId, mode],
      )
    ).map(row => row.package_name)
  }
  async configure(groupId: string, controlled: readonly string[], preinstalled: readonly string[]): Promise<void> {
    assertPluginGroupConfiguration(controlled, preinstalled)
    await pluginTransaction(this.connection, async sql => {
      await sql.query('SELECT id FROM dsh_phalanx.groups WHERE id=$1 FOR UPDATE', [groupId])
      await sql.query('DELETE FROM dsh_phalanx.plugin_grants WHERE group_id=$1 AND NOT(package_name=ANY($2::text[]))', [
        groupId,
        [...controlled, ...preinstalled],
      ])
      for (const [mode, names] of [
        ['controlled', controlled],
        ['preinstall', preinstalled],
      ] as const)
        for (const name of new Set(names))
          await sql.query(
            `INSERT INTO dsh_phalanx.plugin_grants(group_id,package_name,mode) VALUES($1,$2,$3) ON CONFLICT(group_id,package_name) DO UPDATE SET mode=EXCLUDED.mode`,
            [groupId, name, mode],
          )
    })
  }
  async set(groupId: string, packages: readonly string[]): Promise<void> {
    await pluginTransaction(this.connection, async sql => {
      await sql.query('SELECT id FROM dsh_phalanx.groups WHERE id=$1 FOR UPDATE', [groupId])
      const grants = new PostgresPluginGrants({ sql, cipher: 'sql' in this.connection ? this.connection.cipher : this.connection.cipher() })
      await grants.configure(groupId, packages, await grants.preinstalls(groupId))
    })
  }
  async remove(groupId: string): Promise<void> {
    await pluginTransaction(this.connection, async sql => {
      await sql.query('DELETE FROM dsh_phalanx.plugin_grants WHERE group_id=$1', [groupId])
      await sql.query('DELETE FROM dsh_phalanx.plugin_grant_receipts WHERE group_id=$1', [groupId])
    })
  }
  async retainGroups(groupIds: readonly string[]): Promise<void> {
    await pluginTransaction(this.connection, async sql => {
      await sql.query('DELETE FROM dsh_phalanx.plugin_grants WHERE NOT(group_id=ANY($1::text[]))', [groupIds])
      await sql.query('DELETE FROM dsh_phalanx.plugin_grant_receipts WHERE NOT(group_id=ANY($1::text[]))', [groupIds])
    })
  }
}
