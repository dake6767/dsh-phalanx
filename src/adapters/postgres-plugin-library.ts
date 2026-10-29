import { PostgresRuntimeReferences } from './postgres-runtime-references.js'
import { BusinessRuleError } from '../domain/business-error.js'
import type { LibraryPlugin } from '../domain/plugin-library.js'
import { assertPluginIdentity } from '../domain/plugin-library.js'
import type { PluginLibraryStorePort } from '../ports/plugin-library.js'
import { pluginAuthorizationRevision, pluginSql, pluginTransaction, type PluginRepositoryConnection } from './postgres-plugin-repository.js'

/** Library rows and upload references change together, without retaining a fact snapshot. */
export class PostgresPluginLibraryStore implements PluginLibraryStorePort {
  constructor(private readonly connection: PluginRepositoryConnection) {}
  authorizationRevision(): string {
    return pluginAuthorizationRevision(this.connection)
  }
  async list(): Promise<readonly LibraryPlugin[]> {
    return pluginTransaction(this.connection, async sql => {
      const rows = await sql.query<{
        package_name: string
        revision: string
        version: string
        stage: LibraryPlugin['stage']
        published: boolean
        current: LibraryPlugin['current']
        replacement: LibraryPlugin['replacement'] | null
        identities: LibraryPlugin['identities'] | null
        provenance: LibraryPlugin['provenance'] | null
        suite_origin: string | null
        dependencies: readonly string[]
        configuration: Partial<LibraryPlugin>
        uploads: readonly { scope: string; archive: string; integrity: string }[]
      }>(
        `SELECT plugin_library.*,
          ARRAY(SELECT dependency FROM dsh_phalanx.plugin_runtime_dependencies WHERE owner_id=plugin_library.package_name AND owner_scope='current' ORDER BY position) AS dependencies,
          COALESCE((SELECT jsonb_agg(jsonb_build_object('scope',scope,'archive',archive,'integrity',integrity)) FROM dsh_phalanx.plugin_uploads WHERE package_name=plugin_library.package_name),'[]'::jsonb) AS uploads
         FROM dsh_phalanx.plugin_library ORDER BY package_name`,
      )
      return rows.map(row => {
        const uploaded = (scope: string) => {
          const ref = row.uploads.find(value => value.scope === scope)
          return ref ? { archive: ref.archive, integrity: ref.integrity } : undefined
        }
        const upload = uploaded('current'),
          replacementUpload = uploaded('replacement')
        return {
          ...row.configuration,
          ...(Object.hasOwn(row.configuration, 'runtimeDependencies') || row.dependencies.length ? { runtimeDependencies: row.dependencies } : {}),
          packageName: row.package_name,
          revision: Number(row.revision),
          version: row.version,
          stage: row.stage,
          published: row.published,
          current: row.current,
          ...(row.replacement ? { replacement: { ...row.replacement, ...(replacementUpload ? { upload: replacementUpload } : {}) } } : {}),
          ...(row.identities ? { identities: row.identities } : {}),
          ...(row.provenance ? { provenance: row.provenance } : {}),
          ...(row.suite_origin ? { suiteOrigin: row.suite_origin } : {}),
          ...(upload ? { upload } : {}),
        }
      })
    })
  }
  async lock(packageName: string, expectedRevision: number | 'none'): Promise<void> {
    if (!('sql' in this.connection)) throw Error('Plugin adoption locks require a transaction')
    const [row] = await this.connection.sql.query<{ revision: string }>('SELECT revision FROM dsh_phalanx.plugin_library WHERE package_name=$1 FOR UPDATE', [
      packageName,
    ])
    if ((row ? Number(row.revision) : 'none') !== expectedRevision)
      throw new BusinessRuleError('conflict', 'Review the changed plugin impact.', 'plugin-impact-changed')
  }
  async save(plugin: LibraryPlugin, expectedRevision: number | 'none' | undefined = plugin.revision): Promise<void> {
    assertPluginIdentity(plugin)
    const {
      removing,
      revision,
      packageName,
      version,
      stage,
      published,
      current,
      replacement,
      identities,
      provenance,
      suiteOrigin,
      upload,
      runtimeDependencies,
      ...metadata
    } = plugin
    void removing
    void revision
    void upload
    const { upload: replacementUpload, ...candidate } = replacement ?? {}
    void replacementUpload
    await pluginTransaction(this.connection, async sql => {
      const values = [
        packageName,
        version,
        stage,
        published,
        JSON.stringify(current),
        replacement ? JSON.stringify(candidate) : null,
        identities ? JSON.stringify(identities) : null,
        provenance ? JSON.stringify(provenance) : null,
        suiteOrigin ?? null,
        JSON.stringify({ ...metadata, ...(runtimeDependencies ? { runtimeDependencies: [] } : {}) }),
      ]
      const saved =
        typeof expectedRevision !== 'number'
          ? await sql.query(
              `INSERT INTO dsh_phalanx.plugin_library(package_name,version,stage,published,current,replacement,identities,provenance,suite_origin,configuration) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ${expectedRevision === 'none' ? 'ON CONFLICT(package_name) DO NOTHING RETURNING revision' : 'ON CONFLICT(package_name) DO UPDATE SET version=EXCLUDED.version,stage=EXCLUDED.stage,published=EXCLUDED.published,current=EXCLUDED.current,replacement=EXCLUDED.replacement,identities=EXCLUDED.identities,provenance=EXCLUDED.provenance,suite_origin=EXCLUDED.suite_origin,configuration=EXCLUDED.configuration,revision=plugin_library.revision+1 RETURNING revision'}`,
              values,
            )
          : await sql.query(
              `UPDATE dsh_phalanx.plugin_library SET version=$2,stage=$3,published=$4,current=$5,replacement=$6,identities=$7,provenance=$8,suite_origin=$9,configuration=$10,revision=revision+1 WHERE package_name=$1 AND revision=$11 RETURNING revision`,
              [...values, expectedRevision],
            )
      if (!saved.length) throw new BusinessRuleError('conflict', 'Platform configuration changed. Reload before saving.', 'platform-configuration-conflict')
      const cipher = 'sql' in this.connection ? this.connection.cipher : this.connection.cipher()
      await new PostgresRuntimeReferences({ sql, cipher }).replace({ kind: 'plugin', name: packageName }, runtimeDependencies ?? [])
      for (const [scope, upload] of [
        ['current', plugin.upload],
        ['replacement', plugin.replacement?.upload],
      ] as const) {
        if (upload)
          await sql.query(
            `INSERT INTO dsh_phalanx.plugin_uploads(package_name,scope,archive,integrity) VALUES($1,$2,$3,$4)
          ON CONFLICT(package_name,scope) DO UPDATE SET archive=EXCLUDED.archive,integrity=EXCLUDED.integrity`,
            [plugin.packageName, scope, upload.archive, upload.integrity],
          )
        else await sql.query('DELETE FROM dsh_phalanx.plugin_uploads WHERE package_name=$1 AND scope=$2', [plugin.packageName, scope])
      }
    })
  }
  async remove(packageName: string, expectedRevision?: number): Promise<void> {
    const removed = await pluginSql(this.connection).query(
      expectedRevision === undefined
        ? 'DELETE FROM dsh_phalanx.plugin_library WHERE package_name=$1 RETURNING package_name'
        : 'DELETE FROM dsh_phalanx.plugin_library WHERE package_name=$1 AND revision=$2 RETURNING package_name',
      expectedRevision === undefined ? [packageName] : [packageName, expectedRevision],
    )
    if (expectedRevision !== undefined && !removed.length)
      throw new BusinessRuleError('conflict', 'The plugin impact changed. Review it again.', 'plugin-impact-changed')
  }
}
