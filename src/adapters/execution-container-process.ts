import { privatePythonBootstrap, pythonStartupEnvironmentNames } from './execution-python-bootstrap.js'
import { DevelopmentExecutionProcess } from './execution-development-process.js'
import { DEFAULT_EXECUTION_LIMITS } from '../domain/execution-control.js'
import type { ExecutionLimitsPort } from '../ports/execution-control.js'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ExecutionFailure, type ExecutionEvent } from '../domain/platform-execution.js'
import type { CommunityRuntimeConfig, ContainerConfig } from '../domain/community-config.js'
import { PlatformContainerOwner, PlatformProcessHost, killPlatformChild, sendPlatformInput } from './platform-process-host.js'

export interface ContainerExecutionInput {
  readonly mounts: readonly { readonly host: string; readonly mounted: string; readonly readOnly?: boolean }[]
  readonly cwd: string
  readonly command: string
  readonly argv: readonly string[]
  readonly pythonScript?: string
  readonly stdin: Uint8Array
  readonly environment: Readonly<Record<string, string>>
  readonly timeoutMs?: number
}
/** Shared owner of disposable execution and preparation container lifecycle. */
export class ContainerExecutionProcess {
  private readonly shutdown = new AbortController()
  private readonly active = new Set<Promise<number>>()
  readonly host: PlatformProcessHost
  private readonly owner: PlatformContainerOwner
  get containerConfig(): ContainerConfig | undefined {
    return this.host.container
  }
  get isolated(): boolean {
    return this.host.container !== undefined
  }
  imageIdentity(): Promise<string> {
    return this.host.imageIdentity()
  }
  get canDiscardArtifacts(): boolean {
    return this.owner.canDiscard
  }
  get ownership(): string {
    return this.host.ownership
  }
  async recover(): Promise<void> {
    await this.host.detect()
    await this.owner.recover()
  }
  async stop(): Promise<void> {
    this.shutdown.abort()
    await Promise.allSettled(this.active)
    await this.recover()
  }
  run(input: ContainerExecutionInput, emit: (event: ExecutionEvent) => Promise<void>, signal: AbortSignal): Promise<number> {
    if (!this.owner.canDiscard || this.shutdown.signal.aborted) return Promise.reject(new ExecutionFailure('internal'))
    const task = this.invoke(input, emit, AbortSignal.any([signal, this.shutdown.signal]))
    this.active.add(task)
    void task
      .finally(() => {
        this.active.delete(task)
      })
      .catch(() => {})
    return task
  }
  constructor(
    private readonly runtime: CommunityRuntimeConfig,
    private readonly limits: Pick<ExecutionLimitsPort, 'get'> = { get: async () => DEFAULT_EXECUTION_LIMITS },
  ) {
    this.host = new PlatformProcessHost(runtime, limits)
    this.owner = new PlatformContainerOwner(this.host, 'execution')
  }
  private async invoke(input: ContainerExecutionInput, emit: (event: ExecutionEvent) => Promise<void>, signal: AbortSignal): Promise<number> {
    const timeoutMs = input.timeoutMs ?? (await this.limits.get()).timeoutSeconds * 1000
    signal.throwIfAborted()
    const container = this.host.container
    if (!container) return new DevelopmentExecutionProcess().run({ ...input, timeoutMs }, emit, signal)
    const runnerDirectory = join(this.runtime.dataRoot, 'execution', 'runner')
    await mkdir(runnerDirectory, { recursive: true, mode: 0o700 })
    const runnerName = createHash('sha256').update(containerBootstrap).digest('hex') + '.mjs'
    const runner = join(runnerDirectory, runnerName)
    try {
      if ((await readFile(runner, 'utf8')) !== containerBootstrap) throw new Error('Invalid execution bootstrap')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const temporary = join(runnerDirectory, randomUUID())
      try {
        await writeFile(temporary, containerBootstrap, { mode: 0o444, flag: 'wx' })
        await rename(temporary, runner)
      } finally {
        await rm(temporary, { force: true })
      }
    }
    const name = `dsh-phalanx-execution-${randomUUID()}`
    const environment = input.environment
    signal.throwIfAborted()
    const child = await this.host.launch({
      shape: 'disposable',
      name,
      cwd: input.cwd,
      mounts: [...input.mounts, { host: runnerDirectory, mounted: '/dsh-phalanx/execution-runner', readOnly: true }],
      nodeArgs: ['/dsh-phalanx/execution-runner/' + runnerName],
    })
    const timeout = AbortSignal.timeout(timeoutMs),
      cancellation = AbortSignal.any([signal, timeout])
    let cleanup: Promise<unknown> | undefined
    const abort = () => {
      killPlatformChild(child, true)
      child.stdout.destroy()
      child.stderr.destroy()
      cleanup ??= this.owner.requestRemoval(name)
      void cleanup.catch(() => {})
    }
    const exited = new Promise<number>((done, fail) => {
      child.once('error', () => fail(new ExecutionFailure('internal')))
      child.once('close', code => done(code ?? 125))
    })
    try {
      cancellation.addEventListener('abort', abort, { once: true })
      cancellation.throwIfAborted()
      sendPlatformInput(child, {
        environment,
        command: input.command,
        argv: input.argv,
        ...(input.pythonScript ? { pythonScript: input.pythonScript } : {}),
        stdin: Buffer.from(input.stdin).toString('base64'),
      })
      let result: number | undefined
      const output = async () => {
        let pending = ''
        for await (const data of child.stdout) {
          pending += (data as Buffer).toString('utf8')
          let end: number
          while ((end = pending.indexOf('\n')) !== -1) {
            const event = JSON.parse(pending.slice(0, end))
            pending = pending.slice(end + 1)
            if (event.stream === 'stdout' || event.stream === 'stderr')
              await cancellableOutput(() => emit({ stream: event.stream, data: Buffer.from(event.data, 'base64') }), cancellation)
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
    } catch (error) {
      abort()
      if (timeout.aborted) throw new ExecutionFailure('timeout')
      throw error
    } finally {
      cancellation.removeEventListener('abort', abort)
      // Explicit removal also handles interrupted CLI startup, where --rm may never have run.
      await Promise.allSettled([exited, ...(cleanup ? [cleanup] : [])])
      await this.owner.remove(name, 'disposable')
    }
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
const environment = input.pythonScript ? Object.fromEntries(${JSON.stringify(pythonStartupEnvironmentNames)}.filter(name => input.environment[name] !== undefined).map(name => [name,input.environment[name]])) : input.environment;
const argv = input.pythonScript ? ['-I','-c',${JSON.stringify(privatePythonBootstrap)},input.pythonScript,...input.argv] : input.argv;
const child = spawn(input.command, argv, { env: environment, stdio: input.pythonScript ? ['pipe','pipe','pipe','pipe'] : ['pipe','pipe','pipe'] });
if (input.pythonScript && child.stdio[3]) { child.stdio[3].on('error',()=>{}); child.stdio[3].end(JSON.stringify(input.environment)); }
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
  const aborted = new Promise<never>((_, reject) => {
    cancel = () => reject(signal.reason)
    signal.addEventListener('abort', cancel, { once: true })
  })
  try {
    await Promise.race([output(), aborted])
  } finally {
    signal.removeEventListener('abort', cancel)
  }
}
