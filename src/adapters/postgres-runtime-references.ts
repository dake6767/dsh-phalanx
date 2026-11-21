import { BusinessRuleError } from '../domain/business-error.js'
import { isPlaywrightResource, type InstalledNativeResourceBinding } from '../domain/plugin-preinstall.js'
import type { RuntimeDependencyOwnerReference, RuntimeDependencyReference } from '../domain/runtime-dependency.js'
import { PLAYWRIGHT_NPM_PACKAGE } from '../domain/suite-resource-bindings.js'
import type { BrowserDependencyConsumer, RuntimeDependencyReferencesPort } from '../ports/runtime-dependencies.js'
import type { PlatformSql } from './platform-database.js'
import { repositorySql, repositoryTransaction, type RowRepositoryConnection } from './postgres-row-repository.js'

const tables = {
  skill: 'skill_runtime_dependencies',
  plugin: 'plugin_runtime_dependencies',
  mcp: 'mcp_runtime_dependencies',
  execution: 'execution_runtime_dependencies',
} as const

const parents = {
  skill: ['skills', 'name'],
  plugin: ['plugin_library', 'package_name'],
  mcp: ['mcp_services', 'name'],
  execution: ['execution_configurations', 'owner'],
} as const

/** Typed owner foreign keys retire references with their actual parent, including concurrent deletion. */
export class PostgresRuntimeReferences implements RuntimeDependencyReferencesPort {
  constructor(private readonly connection: RowRepositoryConnection) {}
  async list(name: string): Promise<readonly RuntimeDependencyReference[]> {
    const query = Object.entries(tables)
      .map(([kind, table]) => `SELECT '${kind}' AS kind,owner_id AS name FROM dsh_phalanx.${table} WHERE dependency=$1`)
      .concat("SELECT 'member-plugin' AS kind,package_name AS name FROM dsh_phalanx.member_browser_dependencies WHERE dependency=$1")
      .concat("SELECT 'member-plugin' AS kind,package_name AS name FROM dsh_phalanx.member_browser_reservations WHERE dependency=$1")
      .join(' UNION ')
    return repositorySql(this.connection).query<RuntimeDependencyReference>(`${query} ORDER BY kind,name`, [name])
  }
  async browserConsumers(name: string): Promise<readonly BrowserDependencyConsumer[]> {
    const rows = await repositorySql(this.connection).query<{
      name: string
      bindings: InstalledNativeResourceBinding[]
      member: boolean
      playwright_version: string | null
    }>(
      `SELECT COALESCE(NULLIF(l.current->>'title',''),l.package_name) AS name,
         COALESCE(l.configuration->'suiteResourceBindings','[]'::jsonb) AS bindings, false AS member, NULL::text AS playwright_version
       FROM dsh_phalanx.plugin_library l
       INNER JOIN dsh_phalanx.plugin_runtime_dependencies r ON r.owner_id=l.package_name AND r.owner_scope='current'
       WHERE r.dependency=$1
       UNION ALL
       SELECT m.title, m.bindings, true, m.playwright_version FROM dsh_phalanx.member_browser_dependencies m
       WHERE m.dependency=$1
       UNION ALL
       SELECT m.title, m.bindings, false, m.playwright_version FROM dsh_phalanx.member_browser_reservations m
       WHERE m.dependency=$1`,
      [name],
    )
    return rows.flatMap(row => {
      const bindings = Array.isArray(row.bindings) ? row.bindings : []
      const playwright =
        row.playwright_version ??
        bindings.find(binding => binding.kind === 'native-package-cache')?.packages.find(item => item.packageName === PLAYWRIGHT_NPM_PACKAGE)?.version
      const browser = bindings.filter(binding => binding.runtimeDependency === name && isPlaywrightResource(binding))
      const typed = new Map(
        browser.flatMap(binding => (binding.kind === 'playwright-browser' ? [[binding.chromiumBuild, binding.playwrightVersion] as const] : [])),
      )
      if (typed.size)
        return [...typed].map(([build, playwrightVersion]) => ({ name: row.name, build, playwrightVersion, ...(row.member ? { memberCopies: 1 } : {}) }))
      return [
        {
          name: row.name,
          ...(row.member ? { memberCopies: 1 } : {}),
          ...(playwright ? { playwrightVersion: playwright } : {}),
        },
      ]
    })
  }
  async retainedBrowserBindings(): Promise<readonly InstalledNativeResourceBinding[]> {
    const rows = await repositorySql(this.connection).query<{ binding: InstalledNativeResourceBinding }>(
      `SELECT jsonb_array_elements(bindings) AS binding FROM dsh_phalanx.member_browser_dependencies
       UNION SELECT jsonb_array_elements(bindings) AS binding FROM dsh_phalanx.member_browser_reservations`,
    )
    return rows.flatMap(({ binding }) => (isPlaywrightResource(binding) ? [binding] : []))
  }
  async names(owner: RuntimeDependencyOwnerReference, scope = 'current'): Promise<readonly string[]> {
    return (
      await repositorySql(this.connection).query<{ dependency: string }>(
        `SELECT dependency FROM dsh_phalanx.${tables[owner.kind]} WHERE owner_id=$1 AND owner_scope=$2 ORDER BY position`,
        [owner.name, scope],
      )
    ).map(row => row.dependency)
  }
  async replace(owner: RuntimeDependencyOwnerReference, names: readonly string[], scope = 'current'): Promise<void> {
    const table = tables[owner.kind]
    await repositoryTransaction(this.connection, async sql => {
      await this.lockOwner(sql, owner, true)
      const parents = await sql.query<{ name: string }>(
        'SELECT name FROM dsh_phalanx.runtime_dependencies WHERE name=ANY($1::text[]) ORDER BY name FOR KEY SHARE',
        [names],
      )
      if (parents.length !== new Set(names).size)
        throw new BusinessRuleError('conflict', 'Runtime dependency is unavailable.', 'runtime-dependency-unavailable')
      await sql.query(`DELETE FROM dsh_phalanx.${table} WHERE owner_id=$1 AND owner_scope=$2 AND NOT(dependency=ANY($3::text[]))`, [owner.name, scope, names])
      for (const [position, dependency] of [...new Set(names)].entries())
        await sql.query(
          `INSERT INTO dsh_phalanx.${table}(dependency,owner_id,owner_scope,position) VALUES($1,$2,$3,$4)
           ON CONFLICT(dependency,owner_id,owner_scope) DO UPDATE SET position=EXCLUDED.position
           WHERE ${table}.position IS DISTINCT FROM EXCLUDED.position`,
          [dependency, owner.name, scope, position],
        )
    })
  }
  async removeOwner(owner: RuntimeDependencyOwnerReference): Promise<void> {
    await repositoryTransaction(this.connection, async sql => {
      await this.lockOwner(sql, owner, false)
      await sql.query(`DELETE FROM dsh_phalanx.${tables[owner.kind]} WHERE owner_id=$1`, [owner.name])
    })
  }
  private async lockOwner(sql: PlatformSql, owner: RuntimeDependencyOwnerReference, required: boolean): Promise<void> {
    const [table, column] = parents[owner.kind]
    const rows = await sql.query(`SELECT ${column} FROM dsh_phalanx.${table} WHERE ${column}=$1 FOR UPDATE`, [owner.name])
    if (required && !rows.length) throw new BusinessRuleError('missing', 'Runtime dependency owner is unavailable.', 'runtime-dependency-unavailable')
  }
}
