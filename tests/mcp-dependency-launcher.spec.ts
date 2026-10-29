import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { mcpDependency } from '../src/domain/mcp-dependency.js'

it('launches a prepared MCP command using private runtime input without persisting its arguments', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-dependency-launcher-'))
  const key = 'fictional-runtime-launcher-key'
  const args = ['-e', 'process.stdout.write(process.argv[1])', key]
  let child: ChildProcess | undefined
  let finished: Promise<unknown[]> | undefined
  try {
    const definition = mcpDependency({
      name: 'p-service',
      generation: 1,
      description: '',
      url: '',
      run: { location: 'shared', command: process.execPath, args, env: [], prepareCommand: ':' },
    })
    if (!('prepareCommand' in definition)) throw Error('Expected command dependency')
    expect(definition.prepareCommand).not.toContain(key)
    await promisify(execFile)('sh', ['-c', definition.prepareCommand], { cwd: root })
    const launcher = join(root, '.phalanx-mcp.mjs')
    expect(await readFile(launcher, 'utf8')).not.toContain(key)
    child = spawn(process.execPath, [launcher], { cwd: root, stdio: ['ignore', 'pipe', 'pipe', 'pipe'] })
    const output: Buffer[] = [],
      errors: Buffer[] = []
    child.stdout!.on('data', chunk => output.push(Buffer.from(chunk)))
    child.stderr!.on('data', chunk => errors.push(Buffer.from(chunk)))
    finished = once(child, 'close')
    child.stdio[3]!.on('error', () => {})
    if (!('end' in child.stdio[3]!)) throw Error('Runtime input pipe is unavailable')
    child.stdio[3].end(JSON.stringify({ command: process.execPath, args }))
    expect((await finished)[0], Buffer.concat(errors).toString()).toBe(0)
    expect(Buffer.concat(output).toString()).toBe(key)
    expect(await readFile(launcher, 'utf8')).not.toContain(key)
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await finished?.catch(() => {})
    }
    await rm(root, { recursive: true, force: true })
  }
})
