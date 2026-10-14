// Frozen legacy preparation fixture for upgrade and cleanup regression only.
import { createHash } from 'node:crypto'
import { mcpTemplateValue } from '../../../src/domain/mcp-protocol.js'
import type { McpService } from '../../../src/domain/mcp-service.js'
import type { ExecutionConfiguration, ExecutionOwner } from '../../../src/domain/platform-execution.js'

/** Credentials never belong to a member preparation owner. */
export function memberMcpExecution(service: McpService): { owner: ExecutionOwner, configuration: ExecutionConfiguration } | undefined {
  const run = service.run
  if (run?.location !== 'member') return undefined
  const version = createHash('sha256').update(JSON.stringify([service.preparationName ?? service.name, run])).digest('hex')
  return { owner: { id: `mcp:${service.preparationName ?? service.name}`, version }, configuration: {
    enabled: true, commands: [{ command: run.command, blocked: [] }],
    variables: run.env.map(row => ({ ...row, secret: false })), prepare: run.prepareCommand ?? '',
  } }
}

/** Shared owner identities include credentials, but expose only a digest to preparation records. */
export function sharedMcpExecution(service: McpService): ReturnType<typeof memberMcpExecution> {
  const run = service.run
  if (run?.location !== 'shared') return undefined
  const variables = run.env.map(row => ({ name: row.name, value: mcpTemplateValue(row.value, service), secret: true }))
  const version = createHash('sha256').update(JSON.stringify([service.preparationName ?? service.name, run, service.credentials, service.credential])).digest('hex')
  return { owner: { id: `mcp:${service.preparationName ?? service.name}`, version }, configuration: {
    enabled: true, commands: [{ command: run.command, blocked: [] }], variables, prepare: run.prepareCommand ?? '',
  } }
}
