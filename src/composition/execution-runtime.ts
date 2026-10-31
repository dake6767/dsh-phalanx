import type { CommunityRuntimeConfig } from '../domain/community-config.js'
import type { ExecutionDeadlinePort } from '../ports/execution-control.js'
import type { PlatformDatabase } from '../adapters/platform-database.js'
import { PostgresExecutionLimits } from '../adapters/postgres-execution-limits.js'
import { ExecutionDeadlines } from '../adapters/execution-control-store.js'
import { ContainerExecutionProcess } from '../adapters/execution-container-process.js'
import { SharedMcpProcess } from '../adapters/mcp-shared-process.js'
import { ExecutionControl } from '../use-cases/execution-control.js'

/** Disposable execution and shared MCP carriers use the same admission and database limits. */
export function createExecutionRuntime(
  runtime: CommunityRuntimeConfig,
  database: PlatformDatabase,
  deadlines?: ExecutionDeadlinePort,
  canDiscard: () => boolean = () => true,
) {
  const limits = new PostgresExecutionLimits(database)
  const control = new ExecutionControl(limits, deadlines ?? new ExecutionDeadlines())
  const process = new ContainerExecutionProcess(runtime, limits, canDiscard)
  return { control, process, shared: new SharedMcpProcess(runtime, process, limits) }
}
