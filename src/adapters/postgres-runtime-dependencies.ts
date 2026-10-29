import { runtimeCommandLock } from './advisory-locks.js'
import { runtimeConflicts } from '../domain/runtime-dependency-record.js'
import { RuntimeDependencyPreparationFailure } from '../domain/runtime-dependency.js'
import { BusinessRuleError } from '../domain/business-error.js'
import { assertRuntimeDependencyRow, type RuntimeDependency } from '../domain/runtime-dependency.js'
import type { RuntimeDependencyStorePort } from '../ports/runtime-dependencies.js'
import { repositorySql, repositoryTransaction, type RowRepositoryConnection } from './postgres-row-repository.js'
import { PostgresRuntimeReferences } from './postgres-runtime-references.js'

type Definition<T = RuntimeDependency> = T extends RuntimeDependency
  ? Omit<T, 'rowRevision' | 'current' | 'previous' | 'stage' | 'updatedAt' | 'log' | 'checks'>
  : never
interface DependencyRow {
  name: string
  definition: Definition
  current_version: RuntimeDependency['current'] | null
  previous_version: RuntimeDependency['previous'] | null
  stage: RuntimeDependency['stage']
  updated_at: string
  log_summary: string
  checks: RuntimeDependency['checks']
  revision: string
}
/** Ordinary reads query rows; synchronous preparation consumers receive a separately registered view. */
export class PostgresRuntimeDependencyStore implements RuntimeDependencyStorePort {
  constructor(private readonly connection: RowRepositoryConnection) {}
  async list(): Promise<readonly RuntimeDependency[]> {
    return (await repositorySql(this.connection).query<DependencyRow>('SELECT * FROM dsh_phalanx.runtime_dependencies ORDER BY name')).map(row => {
      const value: RuntimeDependency = {
        ...row.definition,
        name: row.name,
        stage: row.stage,
        updatedAt: Number(row.updated_at),
        log: row.log_summary,
        checks: row.checks,
        rowRevision: Number(row.revision),
        ...(row.current_version ? { current: row.current_version } : {}),
        ...(row.previous_version ? { previous: row.previous_version } : {}),
      }
      assertRuntimeDependencyRow(value)
      return value
    })
  }
  async save(row: RuntimeDependency): Promise<void> {
    assertRuntimeDependencyRow(row)
    const { rowRevision, current, previous, stage, updatedAt, log, checks, ...definition } = row
    const values = [
      row.name,
      JSON.stringify(definition),
      current ? JSON.stringify(current) : null,
      previous ? JSON.stringify(previous) : null,
      stage,
      updatedAt,
      log,
      JSON.stringify(checks),
    ]
    await repositoryTransaction(this.connection, async sql => {
      if (current) {
        for (const command of [...new Set(current.commands)].sort()) await sql.query(runtimeCommandLock, [command])
        const others = await new PostgresRuntimeDependencyStore({ sql, cipher: this.cipher() }).list()
        const conflict = others
          .filter(
            other =>
              other.name !== row.name && other.name !== row.replaces && other.replaces !== row.name && !(row.replaces && other.replaces === row.replaces),
          )
          .flatMap(other => runtimeConflicts(current, other))
        if (conflict.length)
          throw new RuntimeDependencyPreparationFailure('command-conflict', `Command names conflict with ${conflict.join(', ')}.`, [
            ...current.checks,
            { kind: 'commands', passed: false, detail: conflict.join(', ') },
          ])
      }
      const saved = await sql.query(
        rowRevision === undefined
          ? `INSERT INTO dsh_phalanx.runtime_dependencies(name,definition,current_version,previous_version,stage,updated_at,log_summary,checks)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(name) DO NOTHING RETURNING revision`
          : `UPDATE dsh_phalanx.runtime_dependencies SET definition=$2,current_version=$3,previous_version=$4,stage=$5,updated_at=$6,log_summary=$7,checks=$8,
         revision=revision+1 WHERE name=$1 AND revision=$9 RETURNING revision`,
        rowRevision === undefined ? values : [...values, rowRevision],
      )
      if (!saved.length) throw new BusinessRuleError('conflict', 'Runtime dependency changed; review its current state.', 'runtime-dependency-unavailable')
    })
  }
  async remove(name: string): Promise<void> {
    await repositoryTransaction(this.connection, async sql => {
      // A referencing insert takes a key-share lock, so no new owner can race a confirmed deletion.
      await sql.query('SELECT name FROM dsh_phalanx.runtime_dependencies WHERE name=$1 FOR UPDATE', [name])
      const references = await new PostgresRuntimeReferences({ sql, cipher: this.cipher() }).list(name)
      if (references.length)
        throw new BusinessRuleError('conflict', 'Runtime dependency is still referenced.', 'runtime-dependency-referenced', {
          references: references.map(row => `${row.kind}: ${row.name}`).join(', '),
        })
      await sql.query('DELETE FROM dsh_phalanx.runtime_dependencies WHERE name=$1', [name])
    })
  }
  private cipher() {
    return 'sql' in this.connection ? this.connection.cipher : this.connection.cipher()
  }
}
