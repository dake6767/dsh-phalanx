import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { ExecutionFailure } from '../domain/platform-execution.js'
import type { CommunityRuntimeConfig } from '../domain/community-config.js'
import type { CommunityUserSpaceStoragePort } from '../ports/community-user-spaces.js'
import type { ExecutionRunnerPort } from '../ports/platform-execution.js'
import { rootlessContainerUser } from '../dsh/container.js'
import { DSH_CONTAINER_HOME } from '../dsh/profile-layout.js'
import { containerClientEnvironment, execFileText } from './runtime-command.js'

const skillMount = '/dsh-phalanx/execution-skill'
const workspaceMount = '/dsh-phalanx/workspace'
const inside = (root: string, path: string) => { const part = relative(root, path); return part === '' || (!part.startsWith('..') && !isAbsolute(part)) }

/** A new rootless container owns each invocation; only this member's mutable space is mounted. */
export class ContainerExecutionRunner implements ExecutionRunnerPort {
  private readonly shutdown = new AbortController()
  private readonly active = new Set<Promise<number>>()
  private cleanupFailed = false
  private get ownership() { return createHash('sha256').update(resolve(this.runtime.dataRoot)).digest('hex') }
  async recover(): Promise<void> {
    const container = this.runtime.container
    if (!container) return
    const filter = `label=dsh-phalanx.execution=${this.ownership}`
    const ids = (await execFileText(container.runtime, ['ps', '-a', '--filter', filter, '--format', '{{.ID}}'], { env: containerClientEnvironment(), timeout: 30_000 })).trim().split(/\s+/u).filter(Boolean)
    for (const id of ids) {
      if (!/^[a-f0-9]{12,64}$/u.test(id)) throw new Error('Invalid execution container identity')
      const label = (await execFileText(container.runtime, ['inspect', '--format', '{{index .Config.Labels "dsh-phalanx.execution"}}', id], { env: containerClientEnvironment(), timeout: 30_000 })).trim()
      if (label !== this.ownership) throw new Error('Execution container ownership changed')
      await execFileText(container.runtime, ['rm', '--force', '--ignore', id], { env: containerClientEnvironment(), timeout: 30_000 })
    }
    if ((await execFileText(container.runtime, ['ps', '-a', '--filter', filter, '--format', '{{.ID}}'], { env: containerClientEnvironment(), timeout: 30_000 })).trim()) throw new Error('Execution cleanup is incomplete')
    this.cleanupFailed = false
  }
  async stop(): Promise<void> { this.shutdown.abort(); await Promise.allSettled(this.active); await this.recover() }
  run(input: Parameters<ExecutionRunnerPort['run']>[0], emit: Parameters<ExecutionRunnerPort['run']>[1], signal: AbortSignal): Promise<number> {
    if (this.cleanupFailed || this.shutdown.signal.aborted) return Promise.reject(new ExecutionFailure('internal'))
    const task = this.invoke(input, emit, AbortSignal.any([signal, this.shutdown.signal]))
    this.active.add(task); void task.finally(() => { this.active.delete(task) }).catch(() => {})
    return task
  }
  constructor(private readonly runtime: CommunityRuntimeConfig, private readonly spaces: CommunityUserSpaceStoragePort,
    private readonly sources: { directory(version: string): string }) {}
  private async invoke(input: Parameters<ExecutionRunnerPort['run']>[0], emit: Parameters<ExecutionRunnerPort['run']>[1], signal: AbortSignal): Promise<number> {
    const container = this.runtime.container
    if (!container) throw new ExecutionFailure('not-ready')
    const space = await this.spaces.prepare(input.username)
    const mounts = [{ host: space.home, mounted: DSH_CONTAINER_HOME }, { host: space.workspace, mounted: workspaceMount }]
    const mount = mounts.find(row => isAbsolute(input.cwd) && inside(row.mounted, resolve(input.cwd)))
    if (!mount) throw new ExecutionFailure('invalid-directory')
    const hostCwd = resolve(mount.host, relative(mount.mounted, resolve(input.cwd)))
    try { if (!inside(await realpath(mount.host), await realpath(hostCwd)) || !(await stat(hostCwd)).isDirectory()) throw new Error() }
    catch { throw new ExecutionFailure('invalid-directory') }
    const source = this.sources.directory(input.version)
    let command = input.command, argv = [...input.argv]
    if (command.includes('/')) {
      const sourceCommand = resolve(source, command)
      try { if (!inside(source, sourceCommand) || !(await stat(sourceCommand)).isFile()) throw new Error() }
      catch { throw new ExecutionFailure('command-missing') }
      command = join(skillMount, command)
      const script = await readFile(sourceCommand)
      if (!script.subarray(0, 2).equals(Buffer.from('#!'))) {
        const interpreter = command.endsWith('.py') ? 'python3' : /\.[cm]?js$/u.test(command) ? 'node' : command.endsWith('.sh') ? '/bin/sh' : undefined
        if (!interpreter) throw new ExecutionFailure('command-missing')
        argv = [command, ...argv]; command = interpreter
      }
    }
    const runnerDirectory = join(this.runtime.dataRoot, 'execution', 'runner')
    await mkdir(runnerDirectory, { recursive: true, mode: 0o700 })
    const runnerName = createHash('sha256').update(containerBootstrap).digest('hex') + '.mjs'
    const runner = join(runnerDirectory, runnerName)
    try { if (await readFile(runner, 'utf8') !== containerBootstrap) throw new Error('Invalid execution bootstrap') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const temporary = join(runnerDirectory, randomUUID())
      try { await writeFile(temporary, containerBootstrap, { mode: 0o444, flag: 'wx' }); await rename(temporary, runner) }
      finally { await rm(temporary, { force: true }) }
    }
    const name = `dsh-phalanx-execution-${randomUUID()}`
    const environment = { ...input.environment, HOME: '/tmp/phalanx-home', PYTHONNOUSERSITE: '1', PATH: `${skillMount}/bin:${skillMount}:/usr/local/bin:/usr/bin:/bin`, TMPDIR: '/tmp' }
    const args = ['run', '--rm', '--interactive', '--name', name, '--label', `dsh-phalanx.execution=${this.ownership}`,
      '--label', 'dsh-phalanx.community=1', '--label', `dsh-phalanx.community-root=${this.ownership}`,
      '--userns=keep-id', '--user', rootlessContainerUser(), '--read-only', '--tmpfs', '/tmp:rw,nosuid,nodev,size=128m',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '512m', '--cpus', '1', '--pids-limit', '64',
      '--network', 'pasta:-4', '--workdir', resolve(input.cwd),
      ...mounts.flatMap(row => ['--volume', `${row.host}:${row.mounted}`]), '--volume', `${source}:${skillMount}:ro`,
      '--volume', `${runnerDirectory}:/dsh-phalanx/execution-runner:ro`,
      '--entrypoint', 'node', container.image, '/dsh-phalanx/execution-runner/' + runnerName]
    signal.throwIfAborted()
    const child = spawn(container.runtime, args, { env: containerClientEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] })
    const timeout = AbortSignal.timeout(120_000), cancellation = AbortSignal.any([signal, timeout])
    let cleanup: Promise<unknown> | undefined
    const abort = () => {
      child.kill('SIGKILL'); child.stdout.destroy(); child.stderr.destroy()
      cleanup ??= execFileText(container.runtime, ['rm', '--force', '--ignore', name], { env: containerClientEnvironment(), timeout: 15_000 })
      void cleanup.catch(() => {})
    }
    cancellation.addEventListener('abort', abort, { once: true })
    const exited = new Promise<number>((done, fail) => { child.once('error', () => fail(new ExecutionFailure('internal'))); child.once('close', code => done(code ?? 125)) })
    child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify({ environment, command, argv, stdin: Buffer.from(input.stdin).toString('base64') }))
    try {
      let result: number | undefined
      const output = async () => {
        let pending = ''
        for await (const data of child.stdout) {
          pending += (data as Buffer).toString('utf8')
          let end: number
          while ((end = pending.indexOf('\n')) !== -1) {
            const event = JSON.parse(pending.slice(0, end)); pending = pending.slice(end + 1)
            if (event.stream === 'stdout' || event.stream === 'stderr') await cancellableOutput(() => emit({ stream: event.stream, data: Buffer.from(event.data, 'base64') }), cancellation)
            else if (Number.isInteger(event.exit) && event.exit >= 0 && event.exit <= 255) result = event.exit
            else throw new ExecutionFailure('internal')
          }
        }
        if (pending) throw new ExecutionFailure('internal')
      }
      child.stderr.resume()
      const [containerExit] = await Promise.all([exited, output()])
      if (timeout.aborted) throw new ExecutionFailure('timeout')
      signal.throwIfAborted()
      if (containerExit !== 0 || result === undefined) throw new ExecutionFailure('internal')
      return result
    } catch (error) { abort(); if (timeout.aborted) throw new ExecutionFailure('timeout'); throw error }
    finally {
      cancellation.removeEventListener('abort', abort)
      // Explicit removal also handles interrupted CLI startup, where --rm may never have run.
      await Promise.allSettled([exited, ...(cleanup ? [cleanup] : [])])
      await this.removeInvocation(container.runtime, name)
    }
  }
  private async removeInvocation(runtime: string, name: string): Promise<void> {
    try {
      await execFileText(runtime, ['rm', '--force', '--ignore', name], { env: containerClientEnvironment(), timeout: 15_000 })
      const remaining = await execFileText(runtime, ['ps', '-a', '--filter', `name=^${name}$`, '--format', '{{.ID}}'], { env: containerClientEnvironment(), timeout: 15_000 })
      if (remaining.trim()) throw new Error('Execution container remains after removal')
    } catch (error) { this.cleanupFailed = true; throw error }
  }
}

/** Credentials arrive through stdin only; neither host argv nor host subprocess environment contains them. */
const containerBootstrap = `import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { once } from 'node:events';
const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks).toString());
mkdirSync(input.environment.HOME,{recursive:true,mode:0o700});
const send = async event => { if (!process.stdout.write(JSON.stringify(event)+'\\n')) await once(process.stdout,'drain'); };
const child = spawn(input.command, input.argv, { env: input.environment, stdio: ['pipe', 'pipe', 'pipe'] });
const exited = new Promise(resolve => { child.once('error', () => resolve(null)); child.once('close', resolve); });
child.stdin.on('error', () => {}); child.stdin.end(Buffer.from(input.stdin, 'base64'));
const pipe = async (stream, source) => { for await (const chunk of source) await send({stream,data:chunk.toString('base64')}); };
const [code] = await Promise.all([exited,pipe('stdout',child.stdout),pipe('stderr',child.stderr)]);
if (code === null) await send({stream:'stderr',data:Buffer.from(${JSON.stringify(new ExecutionFailure('command-missing').message + '\n')}).toString('base64')});
await send({exit:code ?? 125});
`

/** Output backpressure cannot keep a cancelled invocation or platform shutdown alive. */
async function cancellableOutput(output: () => Promise<void>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  let cancel!: () => void
  const aborted = new Promise<never>((_, reject) => { cancel = () => reject(signal.reason); signal.addEventListener('abort', cancel, { once: true }) })
  try { await Promise.race([output(), aborted]) } finally { signal.removeEventListener('abort', cancel) }
}
