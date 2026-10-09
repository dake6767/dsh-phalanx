import type { MemberPluginAccessPort } from '../ports/plugin-access.js'
import type { MemberManagedPluginsPort } from '../ports/managed-plugins.js'
import { preparePluginCoordination } from './plugin-coordination.js'
import { prepareManagedPlugins } from './managed-plugins.js'
import { managedPluginFailures } from './managed-plugin-status.js'
import { createHash } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CommunityEnvironmentUpgradePort } from '../ports/community-environment-upgrade.js'
import type { CommunityUserSpaceStoragePort } from '../ports/community-user-spaces.js'
import { communityOverlayUrl } from '../dsh/community-profile.js'
import { prepareCommunityProfile } from './community-profile.js'
import { egressEnvironment } from '../domain/egress-environment.js'
import type { CommunityRuntimeConfig } from '../domain/community-config.js'
import { modelCatalogJson } from '../domain/model-catalog.js'
import { CommunityRuntimeUnavailableError, type CommunityModelGatewayAccess, type CommunityUserInstance } from '../ports/community-runtime.js'
import { CommunityRuntimeCleanupError, type CommunityRuntimeDriverPort } from '../ports/community-runtime-driver.js'
import { buildCommunityContainerLaunchCommand, parseManagedContainers } from '../dsh/container.js'
import { webServiceArgs } from '../dsh/cli.js'
import { dshHomePath } from '../dsh/profile-layout.js'
import { privateLaunchUrl } from '../dsh/readiness.js'
import { communitySpacePath } from '../domain/community-space.js'
import { loopbackPort } from './loopback-port.js'
import { prepareCommunityPlatformPlugin } from './community-platform-plugin.js'
import { containerClientEnvironment, execFileText } from './runtime-command.js'
import { waitForReady, terminateChild, resolvePublishedPort, rewriteToHostPort } from './runtime-process.js'
import { managedModelsCatalog, managedModelsConfig, managedModelsContainerPath, managedModelsDirectory, managedModelsWatcher } from '../dsh/shared-models.js'

interface ProcessHandle { readonly child: ChildProcess, readonly exited: Promise<void> }

/** Owns host I/O and only containers labelled for this exact protected data root. */
export class CommunityRuntimeDriver implements CommunityRuntimeDriverPort {
  private readonly processes = new Map<CommunityUserInstance, ProcessHandle>()
  private readonly ownership: string
  private readonly startupTimeoutMs: number
  constructor(private readonly config: CommunityRuntimeConfig, private readonly spaces?: CommunityUserSpaceStoragePort, private readonly upgrade?: CommunityEnvironmentUpgradePort, private readonly managedPlugins?: MemberManagedPluginsPort, private readonly pluginAccess?: MemberPluginAccessPort) {
    // Cold rootless image UID mapping precedes DSH readiness and can take minutes.
    this.startupTimeoutMs = config.startupTimeoutMs ?? (config.container === undefined ? 90_000 : 300_000)
    this.ownership = createHash('sha256').update(resolve(config.dataRoot)).digest('hex')
  }
  async rebuild(): Promise<readonly string[]> {
    const container = this.config.container
    if (container === undefined) return []
    const output = await execFileText(container.runtime, ['ps', '--all', '--filter', 'label=dsh-phalanx.community=1',
      '--filter', `label=dsh-phalanx.community-root=${this.ownership}`, '--format', 'json'])
    const records = parseManagedContainers(output)
    const removed: string[] = []
    for (const record of records) {
      if (record.labels['dsh-phalanx.community'] !== '1' || record.labels['dsh-phalanx.community-root'] !== this.ownership) throw new Error('Container ownership listing is inconsistent')
      await this.removeContainer(record.name); removed.push(record.name)
    }
    return removed
  }
  async start(userId: string, publicOriginUrl: string, access: CommunityModelGatewayAccess, signal: AbortSignal): Promise<CommunityUserInstance> {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(userId)) throw new Error('Invalid user-space identity')
    signal.throwIfAborted()
    if (this.spaces === undefined) throw new Error('User space storage is required to start an instance')
    const { home, workspace, spaceId } = await this.spaces.prepare(userId)
    const upgraded = await this.upgrade?.prepare(userId, spaceId)
    const plugins = this.managedPlugins?.effective(userId) ?? []
    const pluginAccess = this.pluginAccess?.resolve(plugins, access)
    const managedPlugins = await prepareManagedPlugins(this.config.dataRoot, spaceId, plugins, this.config.container !== undefined, pluginAccess?.entries)
    const publicOrigin = new URL(publicOriginUrl)
    const publicUrl = new URL(communitySpacePath(spaceId), publicOrigin)
    const listenerPort = this.config.container?.internalPort ?? await loopbackPort()
    const platformPatch = await prepareCommunityPlatformPlugin(this.config.dataRoot, this.config.container !== undefined)
    try {
      await prepareCommunityProfile(home, this.config.defaultModel.provider, this.config.defaultModel.model)
      if (this.managedPlugins) await preparePluginCoordination(home, plugins.filter(plugin => !managedPlugins?.failures.includes(plugin.packageName)), this.managedPlugins)
    }
    catch (error) { throw new CommunityRuntimeUnavailableError('profile-unavailable', 'Private DSH profile could not be prepared; repair its configuration before retrying', { cause: error }) }
    await Promise.all([join(home, '.agents'), join(home, 'Documents')]
      .map(path => mkdir(path, { recursive: true, mode: 0o700 })))
    signal.throwIfAborted()
    const inherited: Record<string, string> = {}
    for (const key of ['PATH', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL']) if (process.env[key] !== undefined) inherited[key] = process.env[key]!
    const environment = { ...inherited, ...this.config.environment, ...pluginAccess?.environment, HOME: home, DSH_HOME: dshHomePath(home), DSH_AGENTS_HOME: join(home, '.agents'),
      DSH_PHALANX_UPGRADE_NOTICE: upgraded?.selectSharedModel ? 'choose-shared-model' : '',
      DSH_TELEMETRY_MODE: 'DISABLED', DSH_TELEMETRY_DISABLED: '1', DSH_PHALANX_WORKSPACE_DOCUMENTS_DIR: join(home, 'Documents'),
      DSH_PHALANX_DEFAULT_MODEL_SECRET_CATALOG: modelCatalogJson(this.config.defaultModel.model), DSH_PHALANX_MODEL_GATEWAY_URL: access.url,
      DSH_PHALANX_MODEL_GATEWAY_ACCESS_TOKEN: access.token }
    const managed = this.config.container === undefined ? join(this.config.dataRoot, managedModelsDirectory) : managedModelsContainerPath
    Object.assign(environment, { DSH_PHALANX_MANAGED_MODELS_CONFIG: join(managed, managedModelsConfig),
      DSH_PHALANX_MANAGED_MODELS_CATALOG: join(managed, managedModelsCatalog), DSH_PHALANX_MANAGED_MODELS_WATCHER: join(managed, managedModelsWatcher) })
    if (this.config.container !== undefined) {
      const proxy = new URL(access.url).origin
      const authenticated = new URL(proxy)
      authenticated.username = 'dsh'; authenticated.password = access.token
      Object.assign(environment, egressEnvironment(authenticated.href))
    }
    let name: string | undefined
    let child: ChildProcess | undefined
    let exited: Promise<void> | undefined
    try {
      const container = this.config.container
      if (container === undefined) {
        child = spawn(this.config.command, webServiceArgs(this.config.args, [...(this.config.patches ?? []), fileURLToPath(communityOverlayUrl), join(managed, 'overlay.yml'), platformPatch, ...(managedPlugins ? [managedPlugins.patch] : [])], listenerPort, publicOrigin.host, publicUrl.href),
          { cwd: workspace, env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
      } else {
        const plan = buildCommunityContainerLaunchCommand({ config: this.config, userId, runtimeHome: home, workspace,
          publicAuthority: publicOrigin.host, publicUrl: publicUrl.href, gatewayUrl: access.url, ownership: this.ownership, environment, ...(managedPlugins ? { managedPlugins } : {}) })
        name = plan.containerName
        await execFileText(plan.command, plan.args, { env: { ...containerClientEnvironment(), ...plan.passthroughEnvironment }, timeout: this.startupTimeoutMs })
        signal.throwIfAborted()
        child = spawn(container.runtime, ['logs', '--follow', name], { env: containerClientEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] })
      }
      const launched = child
      exited = new Promise<void>((done, reject) => {
        launched.once('exit', () => { launched.stdout?.destroy(); launched.stderr?.destroy(); done() })
        launched.once('close', done); launched.once('error', reject)
      })
      void exited.catch(() => undefined)
      let url = privateLaunchUrl(await waitForReady(child, this.startupTimeoutMs, signal), publicUrl, listenerPort)
      let pid = child.pid
      if (container !== undefined && name !== undefined) {
        url = rewriteToHostPort(url, await resolvePublishedPort(container, name))
        pid = Number((await execFileText(container.runtime, ['inspect', '--format', '{{.State.Pid}}', name])).trim())
      }
      signal.throwIfAborted()
      if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) throw new Error('User instance has no valid process identity')
      child.stdout?.resume(); child.stderr?.resume()
      const instance = { userId, origin: url.origin, launchUrl: url.href, processId: pid, ...(name === undefined ? {} : { containerName: name }) }
      const managedFailures = [...(managedPlugins?.failures ?? []), ...await managedPluginFailures(instance, publicOrigin, managedPlugins?.modulePrefixes ?? {}, signal)]
      Object.assign(instance, { pluginAccessSnapshot: pluginAccess?.snapshot ?? [], managedSnapshot: plugins.map(plugin => `${plugin.packageName}@${plugin.version}:${plugin.integrity}`).sort(), managedFailures })
      signal.throwIfAborted()
      this.processes.set(instance, { child, exited })
      return instance
    } catch (error) {
      let cleanupFailure: unknown
      try { if (name !== undefined) await this.removeContainer(name) } catch (failure) { cleanupFailure = failure }
      try { if (child?.pid !== undefined && exited !== undefined) await terminateChild(child, exited, this.config.shutdownTimeoutMs ?? 10_000) }
      catch (failure) { cleanupFailure ??= failure }
      if (cleanupFailure !== undefined) throw new CommunityRuntimeCleanupError('User instance cleanup could not be confirmed', { cause: cleanupFailure })
      throw error
    }
  }
  async alive(instance: CommunityUserInstance): Promise<boolean> {
    if (instance.containerName !== undefined) {
      const container = this.config.container
      if (container === undefined) throw new Error('Container runtime is unavailable')
      const output = await execFileText(container.runtime, ['ps', '--filter', 'status=running', '--filter', `name=^${instance.containerName}$`, '--format', '{{.Names}}'])
      return output.split('\n').some(name => name.trim() === instance.containerName)
    }
    const handle = this.processes.get(instance)
    return handle !== undefined && handle.child.exitCode === null && handle.child.signalCode === null
  }
  async stop(instance: CommunityUserInstance): Promise<void> {
    if (instance.containerName !== undefined) await this.removeContainer(instance.containerName)
    await this.releaseProcess(instance, false)
  }
  async detach(instance: CommunityUserInstance): Promise<void> { await this.releaseProcess(instance, instance.containerName !== undefined) }
  private async releaseProcess(instance: CommunityUserInstance, detach: boolean): Promise<void> {
    const handle = this.processes.get(instance)
    if (handle === undefined) return
    if (detach) { handle.child.kill('SIGKILL'); await handle.exited }
    else await terminateChild(handle.child, handle.exited, this.config.shutdownTimeoutMs ?? 10_000)
    this.processes.delete(instance)
  }
  private async removeContainer(name: string): Promise<void> {
    const container = this.config.container
    if (container === undefined) throw new Error('Container runtime is unavailable')
    await execFileText(container.runtime, ['rm', '--force', '--ignore', '--time', '0', name])
    const remaining = await execFileText(container.runtime, ['ps', '--all', '--filter', `name=^${name}$`, '--format', '{{.Names}}'])
    if (remaining.split('\n').some(candidate => candidate.trim() === name)) throw new Error('Owned user container remains after removal')
  }
}
