import { DEFAULT_EXECUTION_LIMITS, executionLimits, type ExecutionLimits } from '../domain/execution-control.js'
import type { ExecutionLimitsPort } from '../ports/execution-control.js'
import { repositorySql, type RowRepositoryConnection } from './postgres-row-repository.js'

/** Limits are current database facts; callers load them before synchronous admission and registration. */
export class PostgresExecutionLimits implements ExecutionLimitsPort {
  constructor(private readonly connection: RowRepositoryConnection) {}
  async get(): Promise<ExecutionLimits> {
    const row = (await repositorySql(this.connection).query<{ limits: ExecutionLimits }>('SELECT limits FROM dsh_phalanx.execution_limits WHERE id=1'))[0]
    return row ? executionLimits(row.limits) : { ...DEFAULT_EXECUTION_LIMITS }
  }
  async save(value: ExecutionLimits): Promise<void> {
    await repositorySql(this.connection).query(
      `INSERT INTO dsh_phalanx.execution_limits(id,limits) VALUES(1,$1)
      ON CONFLICT(id) DO UPDATE SET limits=EXCLUDED.limits,revision=execution_limits.revision+1`,
      [JSON.stringify(executionLimits(value))],
    )
  }
}
