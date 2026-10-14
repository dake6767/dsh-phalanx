import type { CommunityRuntimeDependencyInput } from './admin-contract.js'
import type { McpService } from './mcp-service.js'
import { preparedMcpCommand } from './mcp-command.js'

/** Generated entry exposes only the service command, keeping incidental package binaries private. */
export function mcpDependency(service: McpService): CommunityRuntimeDependencyInput {
  const commandName = service.dependencyTarget ?? `mcp-${service.name}`
  const entry = `#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const directory = fileURLToPath(new URL('.', import.meta.url))
const preparedMcpCommand = ${preparedMcpCommand.toString()}
const config = { directory, compatibility: true, command: ${JSON.stringify(service.run!.command)}, args: ${JSON.stringify(service.run!.args)} }
const invocation = preparedMcpCommand(config, { node: process.execPath, read: path => readFileSync(path, 'utf8'), exists: existsSync, join, resolve })
const child = spawn(invocation.command, [...invocation.args, ...process.argv.slice(2)], { cwd: directory, stdio: 'inherit' })
child.on('error', () => { process.exitCode = 1 }); child.on('exit', code => { process.exitCode = code ?? 1 })
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal))
`
  const installEntry = `node --input-type=module - <<'PHALANX_MCP_ENTRY'\nimport { mkdirSync, writeFileSync, symlinkSync } from 'node:fs'; mkdirSync('.phalanx-bin', { recursive: true }); writeFileSync('.phalanx-mcp.mjs', ${JSON.stringify(entry)}, { mode: 0o755 }); symlinkSync('../.phalanx-mcp.mjs', ${JSON.stringify('.phalanx-bin/' + commandName)});\nPHALANX_MCP_ENTRY`
  return { name: `mcp-${service.name}`, prepareCommand: `set -e\n${service.run!.prepareCommand || ':'}\n${installEntry}`, pathDirectories: ['.phalanx-bin'] }
}
