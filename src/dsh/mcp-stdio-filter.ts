import { secretOutputRedactor } from '../domain/secret-output.js'
import { preparedMcpCommand } from './mcp-command.js'
import { filterMcpResponse, inspectMcpRequest, mcpRecord, redactMcpFields, redactMcpValue } from '../domain/mcp-protocol.js'

/** Member-side usability filter; members can run their own processes and bypass it. */
export const memberMcpFilter = `
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { StringDecoder } from 'node:string_decoder'
import { delimiter, join, resolve } from 'node:path'
import { readFileSync, existsSync } from 'node:fs'
const mcpRecord = ${mcpRecord.toString()}
class McpProtocolError extends Error {}
const redactMcpFields = ${redactMcpFields.toString()}
const redactMcpValue = ${redactMcpValue.toString()}
const inspectMcpRequest = ${inspectMcpRequest.toString()}
const filterMcpResponse = ${filterMcpResponse.toString()}
const reference = JSON.parse(process.argv[2])
let config
try {
  if (!/^\\/mcp-member(?:-test)?\\/p-[A-Za-z0-9_-]{1,30}\\?generation=[1-9][0-9]*$/.test(reference.path)) throw Error('Invalid MCP reference')
  const token = process.env.DSH_PHALANX_MODEL_GATEWAY_ACCESS_TOKEN
  if (!/^[A-Za-z0-9_-]{43}$/.test(token ?? '')) throw Error('Missing member access')
  const response = await fetch(new URL(reference.path, process.env.DSH_PHALANX_MODEL_GATEWAY_URL), { headers: { authorization: 'Bearer ' + token }, redirect: 'error', signal: AbortSignal.timeout(30000) })
  if (!response.ok) throw Error('MCP configuration unavailable')
  config = await response.json()
} catch {
  process.stderr.write('Member MCP configuration unavailable. Wait for the current service configuration and retry.\\n')
  process.exit(1)
}
const disabled = config.disabledTools ?? []
const secrets = [...new Set([...(config.secretValues ?? []), ...config.env.map(row => row.value)].filter(Boolean))]
const configuredEnvironment = Object.fromEntries(config.env.map(row => [row.name, row.value.replaceAll('{dependencies}', config.directory)]))
const environment = { ...process.env, ...configuredEnvironment,
  DSH_PHALANX_MCP_DEPENDENCIES: config.directory,
  PATH: [...(config.pathDirectories ?? []), configuredEnvironment.PATH ?? process.env.PATH ?? ''].join(delimiter) }
const preparedMcpCommand = ${preparedMcpCommand.toString()}
const { command, args } = preparedMcpCommand(config, { node: process.execPath, read: path => readFileSync(path, 'utf8'), exists: existsSync, join, resolve })
const child = spawn(command, args, { env: environment, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
const secretOutputRedactor = ${secretOutputRedactor.toString()}
const stderrRedactor = secretOutputRedactor(secrets)
const outputShutdown = new AbortController()
const writeBytes = async (stream, value) => {
  outputShutdown.signal.throwIfAborted()
  if (value.length && !stream.write(value)) await once(stream, 'drain', { signal: outputShutdown.signal })
}
const errorOutput = (async () => {
  for await (const chunk of child.stderr) { await writeBytes(process.stderr, stderrRedactor.write(chunk)) }
  await writeBytes(process.stderr, stderrRedactor.flush())
})()
const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
const terminate = signal => { if (child.pid) { try { process.kill(-child.pid, signal) } catch (error) { if (error.code !== 'ESRCH') throw error } } }
const stop = () => { outputShutdown.abort(); process.stdout.destroy(); process.stderr.destroy(); terminate('SIGTERM'); setTimeout(() => terminate('SIGKILL'), 1000).unref() }
let closing
process.once('SIGTERM', stop); process.once('SIGINT', stop)
const timeout = config.timeoutMs ? setTimeout(stop, config.timeoutMs) : undefined
child.stdin.on('error', () => {})
const write = (stream, value) => writeBytes(stream, JSON.stringify(value) + '\\n')
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
  const output = pipe(child.stdout, value => write(process.stdout, filterMcpResponse(value, disabled, secrets)))
  // A server ending must also release the idle client-input reader.
  void exited.finally(() => process.stdin.destroy()).catch(() => {})
  const [code] = await Promise.all([exited, input, output, errorOutput]); process.exitCode = Number.isInteger(code) ? code : 1
} catch {
  if (!outputShutdown.signal.aborted) process.stderr.write('Prepared MCP process failed. Check its configuration and preparation log.\\n')
  stop(); process.stdin.destroy(); await Promise.allSettled([exited, errorOutput]); process.exitCode = 1
} finally { clearTimeout(timeout); clearTimeout(closing); terminate('SIGKILL') }
// Node's process stdio destroy can leave an unread write pending. Forced shutdown
// drops that output only after the child and its readers have been reclaimed.
if (outputShutdown.signal.aborted) process.exit(process.exitCode ?? 1)
`
