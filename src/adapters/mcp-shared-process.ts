import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { createInterface } from 'node:readline'
import type { CommunityRuntimeConfig } from '../domain/community-config.js'
import type { McpService } from '../domain/mcp-service.js'
import { mcpTemplateValue } from '../domain/mcp-protocol.js'
import { ExecutionFailure } from '../domain/platform-execution.js'
import type { ExecutionLimitsPort } from '../ports/execution-control.js'
import type { McpSharedActivity, McpSharedProcessPort } from '../ports/mcp-shared-runtime.js'
import type { ContainerExecutionProcess } from './execution-container-process.js'
import { containerClientEnvironment, execFileText } from './runtime-command.js'
import { sharedMcpBridge } from './mcp-shared-bridge.js'
const sharedMcpMount = '/dsh-phalanx/shared-mcp'
import {
  PlatformContainerOwner,
  PlatformProcessHost,
  platformSystemPath,
  temporaryPlatformHome,
  killPlatformChild,
  sendPlatformInput,
} from './platform-process-host.js'

/** Separate carrier ownership from disposable executions; shared sessions survive unrelated preparation. */
export class SharedMcpProcess implements McpSharedProcessPort {
  private readonly readers = new Map<string, number>()
  retainedArtifacts(): readonly string[] {
    return [...this.readers.keys()].map(path => basename(path))
  }
  private readonly host: PlatformProcessHost
  private readonly owner: PlatformContainerOwner
  constructor(
    runtime: CommunityRuntimeConfig,
    execution: Pick<ContainerExecutionProcess, 'containerConfig' | 'isolated'> & Partial<Pick<ContainerExecutionProcess, 'host'>>,
    limits: Pick<ExecutionLimitsPort, 'get'>,
  ) {
    this.host = execution.host ?? new PlatformProcessHost(runtime, limits, () => execution.containerConfig)
    this.owner = new PlatformContainerOwner(this.host, 'mcp-shared')
  }
  get isolated(): boolean {
    return this.host.container !== undefined
  }
  async recover(): Promise<void> {
    await this.owner.recover()
    this.readers.clear()
  }
  async start(service: McpService, activity: (event: McpSharedActivity) => void, signal: AbortSignal) {
    if (!this.owner.canDiscard || service.run?.location !== 'shared' || !service.prepared) throw new ExecutionFailure('not-ready')
    signal.throwIfAborted()
    const directories = service.prepared.dependencies?.map(row => row.directory) ?? [service.prepared.directory]
    for (const directory of directories) this.readers.set(directory, (this.readers.get(directory) ?? 0) + 1)
    let handedOff = false
    const release = () => {
      if (!this.owner.canDiscard) return
      for (const directory of directories) {
        const remaining = (this.readers.get(directory) ?? 1) - 1
        if (remaining) this.readers.set(directory, remaining)
        else this.readers.delete(directory)
      }
    }
    try {
      const handle = await this.launch(
        service as McpService & { run: NonNullable<McpService['run']>; prepared: NonNullable<McpService['prepared']> },
        activity,
        signal,
      )
      const closed = handle.closed.finally(release)
      void closed.catch(() => {})
      handedOff = true
      return { ...handle, closed }
    } finally {
      if (!handedOff) release()
    }
  }
  private async launch(
    service: McpService & { run: NonNullable<McpService['run']>; prepared: NonNullable<McpService['prepared']> },
    activity: (event: McpSharedActivity) => void,
    signal: AbortSignal,
  ) {
    const container = this.host.container,
      token = randomUUID(),
      name = `dsh-phalanx-mcp-${randomUUID()}`
    const home = container ? undefined : await temporaryPlatformHome()
    const directory = !service.prepared.dependencies && container ? join(sharedMcpMount, basename(service.prepared.directory)) : service.prepared.directory
    const environment = {
      HOME: home ?? '/tmp/mcp-home',
      TMPDIR: home ?? '/tmp',
      PYTHONNOUSERSITE: '1',
      DSH_PHALANX_MCP_DEPENDENCIES: directory,
      ...Object.fromEntries(service.run.env.map(row => [row.name, mcpTemplateValue(row.value.replaceAll('{dependencies}', directory), service)])),
      PATH: platformSystemPath(
        (service.prepared.dependencies ?? []).flatMap(row => row.pathDirectories.map(path => `${row.mountedPath}/${path}`)),
        !container,
      ),
    }
    const child = await this.host
      .launch(
        {
          shape: 'shared',
          name,
          cwd: directory,
          dependencies: service.prepared.dependencies?.map(row => ({ host: row.directory, mounted: row.mountedPath })) ?? [
            { host: service.prepared.directory, mounted: directory },
          ],
          nodeArgs: ['--input-type=module', '-e', sharedMcpBridge],
        },
        { path: environment.PATH },
      )
      .catch(async error => {
        if (home) await rm(home, { recursive: true, force: true })
        throw error
      })
    const exited = new Promise<number>((done, fail) => {
      child.once('error', () => fail(new ExecutionFailure('internal')))
      child.once('close', code => done(code ?? 125))
    })
    child.stderr.resume()
    let removal: Promise<void> | undefined
    const abort = () => {
      if (container) {
        killPlatformChild(child, true)
        removal ??= this.owner.remove(name, 'shared')
        void removal.catch(() => {})
      } else {
        try {
          killPlatformChild(child, false)
        } catch (error) {
          // macOS can report EPERM for a process group that has just exited.
          // Verify absence before allowing another carrier or releasing artifacts.
          removal ??= execFileText('ps', ['-axo', 'pgid='])
            .then(groups => {
              if (groups.trim().split(/\s+/u).includes(String(child.pid))) throw error
            })
            .catch(error => {
              this.owner.markFailed()
              throw error
            })
          void removal.catch(() => {})
        }
      }
    }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    sendPlatformInput(child, {
      token,
      directory,
      environment,
      compatibility: !!service.dependencyName && !!service.run.runtimeDependencies?.includes(service.dependencyName),
      command: service.run.command,
      args: service.run.args,
      port: container ? 3010 : 0,
      host: container ? '0.0.0.0' : '127.0.0.1',
    })
    let ready!: (port: number) => void, fail!: (error: unknown) => void
    const listening = new Promise<number>((resolve, reject) => {
      ready = resolve
      fail = reject
    })
    const output = (async () => {
      for await (const line of createInterface({ input: child.stdout })) {
        if (line.length > 1024) throw new ExecutionFailure('internal')
        const value = JSON.parse(line)
        if (value.type === 'activity') activity({ type: 'activity' })
        else if (['started', 'completed', 'cancelled'].includes(value.type) && Number.isSafeInteger(value.id) && value.id > 0)
          activity(value.type === 'completed' ? { type: 'completed', id: value.id, failed: value.failed === true } : { type: value.type, id: value.id })
        else if (Number.isInteger(value.port) && value.port > 0 && value.port < 65536) ready(value.port)
        else throw new ExecutionFailure('internal')
      }
    })()
    const closed = Promise.all([exited, output])
      .then(([code]) => code)
      .finally(async () => {
        fail(new ExecutionFailure('internal'))
        signal.removeEventListener('abort', abort)
        abort()
        await exited.catch(() => {})
        if (container) await (removal ?? this.owner.remove(name, 'shared'))
        else await removal
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
      return {
        target: { name: service.name, baseUrl: `http://127.0.0.1:${port}/mcp`, credential: '', headers: [{ name: 'Authorization', value: `Bearer ${token}` }] },
        closed,
      }
    } catch (error) {
      abort()
      await closed.catch(() => {})
      throw error
    }
  }
}
