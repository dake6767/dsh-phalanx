import { createHash } from 'node:crypto'
import type { McpService } from './mcp-service.js'
import type { ExecutionConfiguration, ExecutionOwner } from './platform-execution.js'

/** Credentials never belong to a member preparation owner. */
export function memberMcpExecution(service: McpService): { owner: ExecutionOwner, configuration: ExecutionConfiguration } | undefined {
  const run = service.run
  if (run?.location !== 'member') return undefined
  const version = createHash('sha256').update(JSON.stringify([service.name, run])).digest('hex')
  return { owner: { id: `mcp:${service.name}`, version }, configuration: {
    enabled: true, commands: [{ command: run.command, blocked: [] }],
    variables: run.env.map(row => ({ ...row, secret: false })), prepare: run.prepareCommand,
  } }
}
