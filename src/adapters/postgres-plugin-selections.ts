import type { PluginSelectionsPort } from '../ports/plugin-selections.js'
import { pluginAuthorizationRevision, pluginSql, pluginTransaction, type PluginRepositoryConnection } from './postgres-plugin-repository.js'

/** Member choices and local-copy preferences refer to immutable account spaces. */
export class PostgresPluginSelections implements PluginSelectionsPort {
  constructor(
    private readonly connection: PluginRepositoryConnection,
    private readonly kind: 'selected' | 'local' = 'selected',
  ) {}
  authorizationRevision(): string {
    return pluginAuthorizationRevision(this.connection)
  }
  async get(spaceId: string): Promise<readonly string[]> {
    return (
      await pluginSql(this.connection).query<{ package_name: string }>(
        'SELECT package_name FROM dsh_phalanx.plugin_choices WHERE space_id=$1 AND kind=$2 ORDER BY package_name',
        [spaceId, this.kind],
      )
    ).map(row => row.package_name)
  }
  async set(spaceId: string, packages: readonly string[]): Promise<void> {
    await pluginTransaction(this.connection, async sql => {
      await sql.query('SELECT space_id FROM dsh_phalanx.accounts WHERE space_id=$1 FOR UPDATE', [spaceId])
      await sql.query('DELETE FROM dsh_phalanx.plugin_choices WHERE space_id=$1 AND kind=$2 AND NOT(package_name=ANY($3::text[]))', [
        spaceId,
        this.kind,
        packages,
      ])
      for (const name of new Set(packages))
        await sql.query('INSERT INTO dsh_phalanx.plugin_choices(space_id,package_name,kind) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [
          spaceId,
          name,
          this.kind,
        ])
    })
  }
  async members(packageName: string): Promise<readonly string[]> {
    return (
      await pluginSql(this.connection).query<{ space_id: string }>(
        'SELECT space_id FROM dsh_phalanx.plugin_choices WHERE package_name=$1 AND kind=$2 ORDER BY space_id',
        [packageName, this.kind],
      )
    ).map(row => row.space_id)
  }
  async removePackage(packageName: string): Promise<void> {
    await pluginSql(this.connection).query('DELETE FROM dsh_phalanx.plugin_choices WHERE package_name=$1 AND kind=$2', [packageName, this.kind])
  }
  async retainPackages(packages: readonly string[]): Promise<void> {
    await pluginSql(this.connection).query('DELETE FROM dsh_phalanx.plugin_choices WHERE kind=$1 AND NOT(package_name=ANY($2::text[]))', [this.kind, packages])
  }
}
