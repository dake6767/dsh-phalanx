import { preparedMcpCommand } from './mcp-command.js'
import { filterMcpResponse, inspectMcpRequest, mcpRecord } from '../domain/mcp-protocol.js'

/** Member-side usability filter; members can run their own processes and bypass it. */
export const memberMcpFilter = `
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { StringDecoder } from 'node:string_decoder'
import { delimiter, join, resolve } from 'node:path'
import { readFileSync, existsSync } from 'node:fs'
const mcpRecord = ${mcpRecord.toString()}
class McpProtocolError extends Error {}
// This member transport has no platform credentials; filtering uses an empty secret set.
const redactMcpValue = value => value
const inspectMcpRequest = ${inspectMcpRequest.toString()}
const filterMcpResponse = ${filterMcpResponse.toString()}
const config = JSON.parse(process.argv[2])
const disabled = config.disabledTools ?? []
const configuredEnvironment = Object.fromEntries(config.env.map(row => [row.name, row.value.replaceAll('{dependencies}', config.directory)]))
const environment = { ...process.env, ...configuredEnvironment,
  DSH_PHALANX_MCP_DEPENDENCIES: config.directory,
  PATH: [join(config.directory, 'node_modules/.bin'), join(config.directory, '.venv/bin'), join(config.directory, 'bin'), configuredEnvironment.PATH ?? process.env.PATH ?? ''].join(delimiter) }
const preparedMcpCommand = ${preparedMcpCommand.toString()}
const { command, args } = preparedMcpCommand(config, { node: process.execPath, read: path => readFileSync(path, 'utf8'), exists: existsSync, join, resolve })
const child = spawn(command, args, { env: environment, detached: true, stdio: ['pipe', 'pipe', 'inherit'] })
const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
const terminate = signal => { if (child.pid) { try { process.kill(-child.pid, signal) } catch (error) { if (error.code !== 'ESRCH') throw error } } }
const stop = () => { terminate('SIGTERM'); setTimeout(() => terminate('SIGKILL'), 1000).unref() }
let closing
process.once('SIGTERM', stop); process.once('SIGINT', stop)
const timeout = config.timeoutMs ? setTimeout(stop, config.timeoutMs) : undefined
child.stdin.on('error', () => {})
const write = async (stream, value) => { if (!stream.write(JSON.stringify(value) + '\\n')) await once(stream, 'drain') }
async function pipe(source, accept) {
  const decoder = new StringDecoder('utf8'); let pending = ''
  for await (const chunk of source) {
    pending += decoder.write(chunk)
    let end
    while ((end = pending.indexOf('\\n')) !== -1) {
      const line = pending.slice(0, end); pending = pending.slice(end + 1)
      if (Buffer.byteLength(line) > 16 * 1024 * 1024) throw Error('MCP message exceeds limit')
      if (line.trim()) await accept(JSON.parse(line))
    }
    if (Buffer.byteLength(pending) > 16 * 1024 * 1024) throw Error('MCP message exceeds limit')
  }
  pending += decoder.end()
  if (pending.trim()) throw Error('Incomplete MCP message')
}
try {
  const input = pipe(process.stdin, async value => {
    const admission = inspectMcpRequest(value, disabled)
    if (admission.denied) await write(process.stdout, admission.error)
    else await write(child.stdin, value)
  }).then(() => { child.stdin.end(); closing = setTimeout(stop, 1000); closing.unref() })
  const output = pipe(child.stdout, value => write(process.stdout, filterMcpResponse(value, disabled, [])))
  // A server ending must also release the idle client-input reader.
  void exited.finally(() => process.stdin.destroy()).catch(() => {})
  const [code] = await Promise.all([exited, input, output]); process.exitCode = Number.isInteger(code) ? code : 1
} catch {
  stop(); process.stdin.destroy(); await exited.catch(() => {}); process.exitCode = 1
  process.stderr.write('Prepared MCP process failed. Check its configuration and preparation log.\\n')
} finally { clearTimeout(timeout); clearTimeout(closing); terminate('SIGKILL') }
`
