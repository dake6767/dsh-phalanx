import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { mkdtemp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type { CommunityRuntimeConfig, ContainerConfig } from '../domain/community-config.js'
import { DEFAULT_EXECUTION_LIMITS } from '../domain/execution-control.js'
import type { ExecutionLimitsPort } from '../ports/execution-control.js'
import { ExecutionFailure } from '../domain/platform-execution.js'
import { rootlessContainerUser } from '../dsh/container.js'
import { declaredRuntimeRevision } from './runtime-revision.js'
import { containerClientEnvironment, execFileText } from './runtime-command.js'

export interface PlatformReadOnlyMount { readonly host: string, readonly mounted: string }
interface PlatformLaunch {
  readonly name: string
  readonly cwd: string
  readonly nodeArgs: readonly string[]
}
type PlatformContainerLaunch = PlatformLaunch & (
  | { readonly shape: 'disposable', readonly mounts: readonly (PlatformReadOnlyMount & { readonly readOnly?: boolean })[] }
  | { readonly shape: 'shared', readonly dependencies: readonly PlatformReadOnlyMount[], readonly mounts?: never }
)

const inside = (root: string, path: string) => { const part = relative(root, path); return !isAbsolute(part) && part !== '..' && !part.startsWith('../') }
export const platformSystemPath = (prefixes: readonly string[], development = false) => [...prefixes, ...(development ? [dirname(process.execPath)] : []), '/usr/local/bin', '/usr/bin', '/bin'].join(':')

/** One host owns runtime detection, hardening and launch; protocol adapters own their streams. */
export class PlatformProcessHost {
  private detected = false
  private configured: ContainerConfig | undefined
  readonly ownership: string
  constructor(private readonly runtime: CommunityRuntimeConfig, readonly limits: Pick<ExecutionLimitsPort, 'get'> = { get: () => DEFAULT_EXECUTION_LIMITS },
    private readonly supplied?: () => ContainerConfig | undefined) {
    this.configured = runtime.container
    this.ownership = createHash('sha256').update(resolve(runtime.dataRoot)).digest('hex')
  }
  get container(): ContainerConfig | undefined { return this.supplied ? this.supplied() : this.configured }
  async detect(): Promise<void> {
    if (this.supplied || this.detected || this.configured) return
    this.detected = true
    try {
      await execFileText('podman', ['--version'], { env: containerClientEnvironment(), timeout: 10_000 })
      this.configured = { runtime: 'podman', image: `localhost/dsh-phalanx:${declaredRuntimeRevision()}`, internalPort: 4180, gatewayPort: 4181 }
      const images = (await execFileText('podman', ['images', '--filter', `label=dsh.revision=${declaredRuntimeRevision()}`, '--format', '{{.ID}}'], { env: containerClientEnvironment(), timeout: 10_000 })).trim().split(/\s+/u)
      if (images[0]) this.configured = { ...this.configured, image: images[0] }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  async imageIdentity(): Promise<string> {
    const container = this.container
    if (!container) return `development/${process.version}`
    try { return (await execFileText(container.runtime, ['image', 'inspect', '--format', '{{.Id}}', container.image], { env: containerClientEnvironment(), timeout: 30_000 })).trim() }
    catch (error) { if (this.runtime.container) throw error; return container.image }
  }
  /** Shared processes cannot receive user-space mounts, including a link into one. */
  private async validateSharedDependencies(dependencies: readonly PlatformReadOnlyMount[]): Promise<void> {
    const users = resolve(this.runtime.dataRoot, 'users')
    for (const dependency of dependencies) {
      if (inside(users, resolve(dependency.host))) throw new ExecutionFailure('invalid-directory')
      const canonical = await realpath(dependency.host)
      const canonicalUsers = await realpath(users).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error })
      if (canonicalUsers && (inside(canonicalUsers, canonical) || inside(canonical, canonicalUsers))) throw new ExecutionFailure('invalid-directory')
    }
  }
  launch(input: Extract<PlatformContainerLaunch, { shape: 'shared' }>, development?: { readonly path: string }): Promise<ChildProcessWithoutNullStreams>
  launch(input: Extract<PlatformContainerLaunch, { shape: 'disposable' }>, development?: { readonly path: string }): ChildProcessWithoutNullStreams
  launch(input: PlatformContainerLaunch, development?: { readonly path: string }): ChildProcessWithoutNullStreams | Promise<ChildProcessWithoutNullStreams> {
    if (input.shape === 'shared') return this.validateSharedDependencies(input.dependencies).then(() => this.spawn(input, development))
    return this.spawn(input, development)
  }
  private spawn(input: PlatformContainerLaunch, development?: { readonly path: string }): ChildProcessWithoutNullStreams {
    const container = this.container, limits = this.limits.get()
    const mounts = input.shape === 'shared' ? input.dependencies.map(row => ({ ...row, readOnly: true })) : input.mounts
    const label = input.shape === 'shared' ? 'mcp-shared' : 'execution'
    const args = container ? ['run', '--rm', '--interactive', '--name', input.name, '--label', `dsh-phalanx.${label}=${this.ownership}`,
      '--label', 'dsh-phalanx.community=1', '--label', `dsh-phalanx.community-root=${this.ownership}`,
      '--userns=keep-id', '--user', rootlessContainerUser(), '--read-only', '--tmpfs', '/tmp:rw,nosuid,nodev,size=128m',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', `${limits.memoryMiB}m`, '--cpus', String(limits.cpus), '--pids-limit', String(limits.pids),
      '--network', 'pasta:-4', ...(input.shape === 'shared' ? ['--publish', '127.0.0.1::3010'] : []), '--workdir', input.cwd,
      ...mounts.flatMap(row => ['--volume', `${row.host}:${row.mounted}${row.readOnly ? ':ro' : ''}`]),
      '--entrypoint', 'node', container.image, ...input.nodeArgs] : [...input.nodeArgs]
    return spawnPlatformChild(container?.runtime ?? process.execPath, args, container ? containerClientEnvironment() : { PATH: development?.path }, { detached: !container })
  }
}

/** A scoped owner protects artifact retention until all of its containers are confirmed removed. */
export class PlatformContainerOwner {
  private failed = false
  constructor(private readonly host: PlatformProcessHost, private readonly scope: 'execution' | 'mcp-shared') {}
  get canDiscard(): boolean { return !this.failed }
  async recover(): Promise<void> {
    const container = this.host.container
    if (!container) return
    const filter = `label=dsh-phalanx.${this.scope}=${this.host.ownership}`
    const ids = (await execFileText(container.runtime, ['ps', '-a', '--filter', filter, '--format', '{{.ID}}'], { env: containerClientEnvironment(), timeout: 30_000 })).trim().split(/\s+/u).filter(Boolean)
    for (const id of ids) {
      if (!/^[a-f0-9]{12,64}$/u.test(id)) throw new ExecutionFailure('internal')
      await this.remove(id)
    }
    if ((await execFileText(container.runtime, ['ps', '-a', '--filter', filter, '--format', '{{.ID}}'], { env: containerClientEnvironment(), timeout: 30_000 })).trim()) throw new ExecutionFailure('internal')
    this.failed = false
  }
  markFailed(): void { this.failed = true }
  async requestRemoval(id: string): Promise<void> {
    const container = this.host.container
    if (container) await execFileText(container.runtime, ['rm', '--force', '--ignore', id], { env: containerClientEnvironment(), timeout: 15_000 })
  }
  async remove(id: string, invocation?: 'disposable' | 'shared'): Promise<void> {
    const missingAllowed = invocation !== undefined
    const container = this.host.container
    if (!container) return
    const query = () => execFileText(container.runtime, ['ps', '-a', '--filter', `name=^${id}$`, '--format', '{{.ID}}'], { env: containerClientEnvironment(), timeout: 15_000 })
    try {
      const present = (await query()).trim()
      // Disposable calls own their freshly generated name; recovery always verifies the persisted label.
      if (invocation !== 'disposable' && (present || !missingAllowed)) {
        let label: string
        try { label = (await execFileText(container.runtime, ['inspect', '--format', `{{index .Config.Labels "dsh-phalanx.${this.scope}"}}`, id], { env: containerClientEnvironment(), timeout: 15_000 })).trim() }
        catch (error) {
          if (!missingAllowed || (await query()).trim()) throw error
          return
        }
        if (label !== this.host.ownership) throw new ExecutionFailure('internal')
      }
      await this.requestRemoval(id)
      if ((await query()).trim()) throw new ExecutionFailure('internal')
    } catch (error) { this.failed = true; throw error }
  }
}

/** All host fallbacks use a private HOME and an explicit environment, never inherited credentials. */
export const temporaryPlatformHome = () => mkdtemp(resolve(tmpdir(), 'phalanx-platform-home-'))
export function spawnPlatformChild(command: string, args: readonly string[], environment: NodeJS.ProcessEnv, options: { readonly cwd?: string, readonly detached?: boolean } = {}): ChildProcessWithoutNullStreams {
  return spawn(command, [...args], { ...options, env: environment, stdio: ['pipe', 'pipe', 'pipe'] })
}
export function killPlatformChild(child: ChildProcessWithoutNullStreams, isolated: boolean): void {
  if (isolated) { child.kill('SIGKILL'); return }
  if (child.pid) { try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error } }
}
export function sendPlatformInput(child: ChildProcessWithoutNullStreams, input: object): void {
  child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify(input))
}
