import { randomBytes } from 'node:crypto'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { communityOverlayUrl } from './community-profile.js'
import { webServiceArgs } from './cli.js'
import { DSH_CONTAINER_HOME, dshHomePath } from './profile-layout.js'
import { managedModelsContainerPath, managedModelsDirectory } from './shared-models.js'
import { platformPluginContainerPath, platformPluginDirectory, platformPluginPatch } from './community-platform-plugin.js'

const CONTAINER_HOME = DSH_CONTAINER_HOME
const CONTAINER_WORKSPACE = '/dsh-phalanx/workspace'
const CONTAINER_DEFAULT_PATCHES = '/dsh-phalanx/patches/defaults'
const CONTAINER_PATCHES = '/dsh-phalanx/patches'

/** Container CLI facts used only for ownership checks and removal. */
export interface ManagedContainerRecord {
  readonly name: string
  readonly running: boolean
  readonly labels: Readonly<Record<string, string>>
}

/** Run as the invoking rootless user so bind-mounted homes remain writable. */
export function rootlessContainerUser(): string {
  if (process.getuid === undefined || process.getgid === undefined) {
    throw new Error('rootless container mode requires a POSIX user identity')
  }
  const uid = process.getuid()
  const gid = process.getgid()
  if (uid === 0 || gid === 0) throw new Error('rootless container mode requires a non-root user and group')
  return `${String(uid)}:${String(gid)}`
}

function resourceLimitArgs(args: readonly string[] | undefined): string[] {
  const checked: string[] = []
  const supplied = args ?? []
  for (let index = 0; index < supplied.length; index += 2) {
    const flag = supplied[index]
    const value = supplied[index + 1]
    if (flag === undefined || value === undefined) throw new Error('container extra arguments must be positive resource limits (--memory, --cpus, --pids-limit)')
    const valid = flag === '--memory' ? /^\d+[bBkKmMgGtTpP]?$/u.test(value) && Number.parseInt(value, 10) > 0
      : flag === '--cpus' ? /^\d+(?:\.\d+)?$/u.test(value) && Number(value) > 0
        : flag === '--pids-limit' ? /^[1-9]\d*$/u.test(value) : false
    if (!valid) throw new Error('container extra arguments must be positive resource limits (--memory, --cpus, --pids-limit)')
    checked.push(flag, value)
  }
  return checked
}

/** One planned rootless-container launch for a DSH user instance. */
export interface ContainerLaunchPlan {
  readonly command: string
  readonly args: readonly string[]
  readonly containerName: string
  /**
   * Values the container CLI copies into the instance via bare `--env KEY`
   * flags, so they never appear on the host argv. Spawn the CLI with these
   * merged into its process environment.
   */
  readonly passthroughEnvironment: Readonly<Record<string, string>>
}

/** Parse the host loopback port from `podman port <name> <port>/tcp` output. */
export function parsePublishedPort(output: string): number {
  const match = /127\.0\.0\.1:(\d+)/u.exec(output)
  if (match?.[1] === undefined) {
    throw new Error('container runtime did not report a host loopback port for the instance')
  }
  const port = Number(match[1])
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('container runtime reported an invalid published port')
  }
  return port
}

/** Parse `podman ps --format json` output (JSON array or JSONL) into records. */
export function parseManagedContainers(output: string): ManagedContainerRecord[] {
  const trimmed = output.trim()
  if (trimmed === '') return []
  let entries: unknown[]
  try {
    const parsed = JSON.parse(trimmed) as unknown
    entries = Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    const lines = trimmed.split('\n').map(line => line.trim()).filter(line => line !== '')
    const records: unknown[] = []
    for (const line of lines) {
      try {
        records.push(JSON.parse(line) as unknown)
      } catch {
        throw new Error('managed container listing contained invalid JSON')
      }
    }
    entries = records
  }
  const records: ManagedContainerRecord[] = []
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) throw new Error('managed container listing contained an invalid row')
    const candidate = entry as { Names?: unknown, Name?: unknown, State?: unknown, Labels?: unknown }
    const names = [...(Array.isArray(candidate.Names) ? candidate.Names : [candidate.Names]), candidate.Name]
    const name = names.find((value): value is string => typeof value === 'string' && value.length > 0)
    if (name === undefined) throw new Error('managed container listing contained a row without a name')
    const labels: Record<string, string> = {}
    if (typeof candidate.Labels === 'object' && candidate.Labels !== null) {
      for (const [key, value] of Object.entries(candidate.Labels as Record<string, unknown>)) {
        if (typeof value === 'string') labels[key] = value
      }
    }
    records.push({ name, running: candidate.State === 'running', labels })
  }
  return records
}

/** Community containers mount only their own mutable space and official static patches. */
export function buildCommunityContainerLaunchCommand(input: {
  readonly config: import('../domain/community-config.js').CommunityRuntimeConfig
  readonly userId: string
  readonly runtimeHome: string
  readonly workspace: string
  readonly publicAuthority: string
  readonly publicUrl?: string
  readonly ownership: string
  readonly gatewayUrl: string
  readonly environment: Readonly<Record<string, string>>
  readonly managedPlugins?: { readonly patch: string, readonly volumes: readonly { host: string, mounted: string }[] }
}): ContainerLaunchPlan {
  const { config } = input
  const container = config.container
  if (container === undefined) throw new Error('Community container configuration is missing')
  const name = `dsh-phalanx-${input.userId}-${randomBytes(6).toString('hex')}`
  const defaultPatchFile = fileURLToPath(communityOverlayUrl)
  const mountedDefaultPatch = join(CONTAINER_DEFAULT_PATCHES, basename(defaultPatchFile))
  const extraPatches = (config.patches ?? []).map((path, index) => ({ host: resolve(path), mounted: join(`${CONTAINER_PATCHES}/p${index}`, basename(path)) }))
  const gateway = new URL(input.gatewayUrl)
  if (gateway.hostname !== '127.0.0.1' || Number(gateway.port) !== container.gatewayPort) throw new Error('Community gateway must use its private loopback listener')
  const argvEnvironment = { HOME: CONTAINER_HOME, DSH_HOME: dshHomePath(CONTAINER_HOME),
    DSH_AGENTS_HOME: join(CONTAINER_HOME, '.agents'), DSH_PHALANX_WORKSPACE_DOCUMENTS_DIR: join(CONTAINER_HOME, 'Documents') }
  const environment = { ...input.environment }
  for (const key of Object.keys(argvEnvironment)) delete environment[key]
  return { command: container.runtime, containerName: name, passthroughEnvironment: environment, args: [
    'run', '--detach', '--name', name,
    '--label', 'dsh-phalanx.community=1', '--label', `dsh-phalanx.community-root=${input.ownership}`, '--label', `dsh-phalanx.user=${input.userId}`,
    '--security-opt', 'unmask=/proc/*', '--userns=keep-id', '--user', rootlessContainerUser(),
    '--network', `pasta:-4,-T,${container.gatewayPort},--no-udp,--no-icmp,-o,127.0.0.1`,
    '--publish', `127.0.0.1::${container.internalPort}`,
    '--volume', `${input.runtimeHome}:${CONTAINER_HOME}`, '--volume', `${input.workspace}:${CONTAINER_WORKSPACE}`,
    '--volume', `${defaultPatchFile}:${mountedDefaultPatch}:ro`,
    '--volume', `${join(config.dataRoot, managedModelsDirectory)}:${managedModelsContainerPath}:ro`,
    '--volume', `${join(config.dataRoot, platformPluginDirectory)}:${platformPluginContainerPath}:ro`,
    ...(input.managedPlugins?.volumes ?? []).flatMap(volume => ['--volume', `${volume.host}:${volume.mounted}:ro`]),
    ...extraPatches.flatMap(patch => ['--volume', `${patch.host}:${patch.mounted}:ro`]),
    '--workdir', CONTAINER_WORKSPACE,
    ...Object.entries(argvEnvironment).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
    ...Object.keys(environment).flatMap(key => ['--env', key]),
    ...resourceLimitArgs(container.extraArgs), container.image, config.command,
    ...webServiceArgs(config.args, [...extraPatches.map(patch => patch.mounted), mountedDefaultPatch, join(managedModelsContainerPath, 'overlay.yml'), join(platformPluginContainerPath, platformPluginPatch), ...(input.managedPlugins ? [input.managedPlugins.patch] : [])], container.internalPort, input.publicAuthority, input.publicUrl),
  ] }
}
