import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import type { CommunityRuntimeConfig } from '../domain/community-config.js'
import type { McpService } from '../domain/mcp-service.js'
import { mcpTemplateValue } from '../domain/mcp-protocol.js'
import { ExecutionFailure } from '../domain/platform-execution.js'
import type { ExecutionLimitsPort } from '../ports/execution-control.js'
import type { McpSharedActivity, McpSharedProcessPort } from '../ports/mcp-shared-runtime.js'
import { rootlessContainerUser } from '../dsh/container.js'
import type { ContainerExecutionProcess } from './execution-container-process.js'
import { containerClientEnvironment, execFileText } from './runtime-command.js'
import { sharedMcpBridge } from './mcp-shared-bridge.js'
import { sharedMcpMount } from './mcp-shared-preparer.js'

/** Separate carrier ownership from disposable executions; shared sessions survive unrelated preparation. */
export class SharedMcpProcess implements McpSharedProcessPort {
  private readonly readers = new Map<string, number>()
  retainedArtifacts(): readonly string[] { return [...this.readers.keys()].map(path => basename(path)) }
  private cleanupFailed = false
  private readonly ownership: string
  constructor(runtime: CommunityRuntimeConfig, private readonly execution: Pick<ContainerExecutionProcess, 'containerConfig' | 'isolated'>, private readonly limits: Pick<ExecutionLimitsPort, 'get'>) {
    this.ownership = createHash('sha256').update(resolve(runtime.dataRoot)).digest('hex')
  }
  get isolated(): boolean { return this.execution.isolated }
  async recover(): Promise<void> {
    const container = this.execution.containerConfig
    if (!container) return
    const ids = (await execFileText(container.runtime, ['ps', '-a', '--filter', `label=dsh-phalanx.mcp-shared=${this.ownership}`, '--format', '{{.ID}}'], { env: containerClientEnvironment(), timeout: 30_000 })).trim().split(/\s+/u).filter(Boolean)
    for (const id of ids) {
      if (!/^[a-f0-9]{12,64}$/u.test(id)) throw new ExecutionFailure('internal')
      await this.remove(container.runtime, id)
    }
    this.cleanupFailed = false; this.readers.clear()
  }
  async start(service: McpService, activity: (event: McpSharedActivity) => void, signal: AbortSignal) {
    if (this.cleanupFailed || service.run?.location !== 'shared' || !service.prepared) throw new ExecutionFailure('not-ready')
    signal.throwIfAborted()
    const directory = service.prepared.directory
    this.readers.set(directory, (this.readers.get(directory) ?? 0) + 1)
    let handedOff = false
    const release = () => {
      if (this.cleanupFailed) return
      const remaining = (this.readers.get(directory) ?? 1) - 1
      if (remaining) this.readers.set(directory, remaining); else this.readers.delete(directory)
    }
    try {
      const handle = await this.launch(service as McpService & { run: NonNullable<McpService['run']>, prepared: NonNullable<McpService['prepared']> }, activity, signal)
      const closed = handle.closed.finally(release); void closed.catch(() => {})
      handedOff = true; return { ...handle, closed }
    } finally { if (!handedOff) release() }
  }
  private async launch(service: McpService & { run: NonNullable<McpService['run']>, prepared: NonNullable<McpService['prepared']> }, activity: (event: McpSharedActivity) => void, signal: AbortSignal) {
    const container = this.execution.containerConfig, limits = this.limits.get(), token = randomUUID(), name = `dsh-phalanx-mcp-${randomUUID()}`
    const home = container ? undefined : await mkdtemp(join(tmpdir(), 'phalanx-mcp-'))
    const directory = container ? join(sharedMcpMount, basename(service.prepared.directory)) : service.prepared.directory
    const environment = { HOME: home ?? '/tmp/mcp-home', TMPDIR: home ?? '/tmp', PYTHONNOUSERSITE: '1',
      PATH: container ? '/usr/local/bin:/usr/bin:/bin' : `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
      ...Object.fromEntries(service.run.env.map(row => [row.name, mcpTemplateValue(row.value.replaceAll('{dependencies}', directory), service)])) }
    const args = container ? ['run', '--rm', '--interactive', '--name', name, '--label', `dsh-phalanx.mcp-shared=${this.ownership}`,
      '--label', 'dsh-phalanx.community=1', '--label', `dsh-phalanx.community-root=${this.ownership}`,
      '--userns=keep-id', '--user', rootlessContainerUser(), '--read-only', '--tmpfs', '/tmp:rw,nosuid,nodev,size=128m',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', `${limits.memoryMiB}m`, '--cpus', String(limits.cpus), '--pids-limit', String(limits.pids),
      '--network', 'pasta:-4', '--publish', '127.0.0.1::3010', '--volume', `${service.prepared.directory}:${directory}:ro`,
      '--workdir', directory, '--entrypoint', 'node', container.image, '--input-type=module', '-e', sharedMcpBridge]
      : ['--input-type=module', '-e', sharedMcpBridge]
    const child = spawn(container?.runtime ?? process.execPath, args, { env: container ? containerClientEnvironment() : { PATH: environment.PATH }, detached: !container, stdio: ['pipe', 'pipe', 'pipe'] })
    const exited = new Promise<number>((done, fail) => { child.once('error', () => fail(new ExecutionFailure('internal'))); child.once('close', code => done(code ?? 125)) })
    child.stderr.resume(); child.stdin.on('error', () => {})
    let removal: Promise<void> | undefined
    const abort = () => {
      if (container) { child.kill('SIGKILL'); removal ??= this.remove(container.runtime, name, true); void removal.catch(() => {}) }
      else if (child.pid) { try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') this.cleanupFailed = true } }
    }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    child.stdin.end(JSON.stringify({ token, directory, environment, command: service.run.command, args: service.run.args, port: container ? 3010 : 0, host: container ? '0.0.0.0' : '127.0.0.1' }))
    let ready!: (port: number) => void, fail!: (error: unknown) => void
    const listening = new Promise<number>((resolve, reject) => { ready = resolve; fail = reject })
    const output = (async () => {
      for await (const line of createInterface({ input: child.stdout })) {
        if (line.length > 1024) throw new ExecutionFailure('internal')
        const value = JSON.parse(line)
        if (value.type === 'activity') activity({ type: 'activity' })
        else if (['started', 'completed', 'cancelled'].includes(value.type) && Number.isSafeInteger(value.id) && value.id > 0) activity(value.type === 'completed' ? { type: 'completed', id: value.id, failed: value.failed === true } : { type: value.type, id: value.id })
        else if (Number.isInteger(value.port) && value.port > 0 && value.port < 65536) ready(value.port)
        else throw new ExecutionFailure('internal')
      }
    })()
    const closed = Promise.all([exited, output]).then(([code]) => code).finally(async () => {
      fail(new ExecutionFailure('internal')); signal.removeEventListener('abort', abort); abort()
      await exited.catch(() => {})
      if (container) await (removal ?? this.remove(container.runtime, name, true))
      if (home) await rm(home, { recursive: true, force: true })
    })
    void closed.catch(() => {})
    try {
      let port = await listening
      if (container) {
        const address = (await execFileText(container.runtime, ['port', name, '3010/tcp'], { env: containerClientEnvironment(), timeout: 10_000 })).trim()
        const match = /^127\.0\.0\.1:([0-9]+)$/u.exec(address)
        if (!match) throw new ExecutionFailure('internal')
        port = Number(match[1])
      }
      signal.throwIfAborted()
      return { target: { name: service.name, baseUrl: `http://127.0.0.1:${port}/mcp`, credential: '', headers: [{ name: 'Authorization', value: `Bearer ${token}` }] }, closed }
    } catch (error) { abort(); await closed.catch(() => {}); throw error }
  }
  private async remove(runtime: string, id: string, missingAllowed = false): Promise<void> {
    try {
      const present = (await execFileText(runtime, ['ps', '-a', '--filter', `name=^${id}$`, '--format', '{{.ID}}'], { env: containerClientEnvironment(), timeout: 15_000 })).trim()
      // Recovery receives IDs rather than names; inspect their exact ownership before removal.
      if (!present && missingAllowed) { await execFileText(runtime, ['rm', '--force', '--ignore', id], { env: containerClientEnvironment(), timeout: 15_000 }); return }
      let label: string
      try { label = (await execFileText(runtime, ['inspect', '--format', '{{index .Config.Labels "dsh-phalanx.mcp-shared"}}', id], { env: containerClientEnvironment(), timeout: 15_000 })).trim() }
      catch (error) {
        // --rm can remove our carrier between ps and inspect. Only verified absence is safe.
        if (!missingAllowed) throw error
        const remaining = (await execFileText(runtime, ['ps', '-a', '--filter', `name=^${id}$`, '--format', '{{.ID}}'], { env: containerClientEnvironment(), timeout: 15_000 })).trim()
        if (remaining) throw error
        return
      }
      if (label !== this.ownership) throw new ExecutionFailure('internal')
      await execFileText(runtime, ['rm', '--force', '--ignore', id], { env: containerClientEnvironment(), timeout: 15_000 })
    } catch (error) { this.cleanupFailed = true; throw error }
  }
}
