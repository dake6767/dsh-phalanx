import { StartupTiming } from './startup-timing.js'
import { HostPreparationCache } from './host-preparation-cache.js'
import { InstanceInspection, inspectCapabilities } from './instance-inspection.js'
import type { CommunityStartupStage } from '../domain/admin-contract.js'
import { CgroupInstanceResources } from './instance-resource-cgroup.js'
import type { MemberInstanceResourcePort } from '../ports/instance-resources.js'
import { instanceResourcesApplied, type InstanceResourceLimits } from '../domain/instance-resources.js'
import { instanceResourceArguments, legacyInstanceResources } from '../dsh/member-resource-limits.js'
import { SKILL_USAGE_ENDPOINT_ENV, SKILL_USAGE_PATH, SKILL_USAGE_PROVIDERS_ENV } from '../dsh/skill-usage.js'
import type { MemberExpertsPort, ExpertSkillProjectionPort } from '../ports/experts.js'
import { prepareMemberExperts } from './member-experts.js'
import { expertPresetFailures } from './expert-status.js'
import type { MemberMcpPort } from '../ports/mcp-services.js'
import { memberMcpPreparation } from './mcp-projection.js'
import { memberSkillsMount, memberSkillsProvider } from '../dsh/member-skills.js'
import type { MemberSkillsPort } from '../ports/member-skills.js'
import { prepareMemberSkills } from './member-skills.js'
import type { MemberPluginAccessPort } from '../ports/plugin-access.js'
import type { MemberManagedPluginsPort } from '../ports/managed-plugins.js'
import { preparePluginCoordination, memberProfileBundles } from './plugin-coordination.js'
import { prepareManagedPlugins } from './managed-plugins.js'
import { managedPluginFailures } from './managed-plugin-status.js'
import { createHash, randomUUID } from 'node:crypto'
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
import { WEB_TOOLS_MEMBER_TOKEN_ENV } from '../dsh/web-tools.js'
import { DSH_CONTAINER_HOME, dshHomePath } from '../dsh/profile-layout.js'
import { privateLaunchUrl } from '../dsh/readiness.js'
import { communitySpacePath } from '../domain/community-space.js'
import { loopbackPort } from './loopback-port.js'
import { prepareCommunityPlatformPlugin } from './community-platform-plugin.js'
import { containerClientEnvironment, execFileText } from './runtime-command.js'
import { waitForReady, terminateChild, resolvePublishedPort, rewriteToHostPort } from './runtime-process.js'
import { managedModelsCatalog, managedModelsConfig, managedModelsContainerPath, managedModelsDirectory, managedModelsWatcher } from '../dsh/shared-models.js'
import { FileContainerHostnames } from './container-hostnames.js'

type InspectionResult = Required<Pick<CommunityUserInstance, 'managedFailures' | 'expertFailures'>>
interface ProcessHandle { readonly child: ChildProcess, readonly exited: Promise<void>, readonly inspect: (signal: AbortSignal) => Promise<InspectionResult>, readonly fallback: InspectionResult }

/** Owns host I/O and only containers labelled for this exact protected data root. */
export class CommunityRuntimeDriver implements CommunityRuntimeDriverPort {
  private readonly prepared = new HostPreparationCache()
  private readonly inspection = new InstanceInspection()
  private readonly processes = new Map<CommunityUserInstance, ProcessHandle>()
  private readonly cgroups = new CgroupInstanceResources()
  private readonly ownership: string
  private readonly startupTimeoutMs: number
  private readonly hostnames: FileContainerHostnames
  constructor(private readonly config: CommunityRuntimeConfig, private readonly spaces?: CommunityUserSpaceStoragePort, private readonly upgrade?: CommunityEnvironmentUpgradePort, private readonly managedPlugins?: MemberManagedPluginsPort, private readonly pluginAccess?: MemberPluginAccessPort, private readonly skills?: MemberSkillsPort, private readonly mcp?: MemberMcpPort, private readonly experts?: MemberExpertsPort, private readonly expertSkills?: ExpertSkillProjectionPort, private readonly resources?: MemberInstanceResourcePort) {
    // Cold rootless image UID mapping precedes DSH readiness and can take minutes.
    this.startupTimeoutMs = config.startupTimeoutMs ?? (config.container === undefined ? 90_000 : 300_000)
    this.ownership = createHash('sha256').update(resolve(config.dataRoot)).digest('hex')
    this.hostnames = new FileContainerHostnames(join(config.dataRoot, 'container-hostnames'))
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
      const userId = record.labels['dsh-phalanx.user']
      if (userId !== undefined) {
        const hostname = (await execFileText(container.runtime, ['inspect', '--format', '{{.Config.Hostname}}', record.name])).trim()
        await this.hostnames.remember(userId, hostname)
      }
      await this.removeContainer(record.name); removed.push(record.name)
    }
    return removed
  }
  async start(userId: string, publicOriginUrl: string, access: CommunityModelGatewayAccess, signal: AbortSignal, progress?: (stage: CommunityStartupStage) => void): Promise<CommunityUserInstance> {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(userId)) throw new Error('Invalid user-space identity')
    signal.throwIfAborted()
    if (this.spaces === undefined) throw new Error('User space storage is required to start an instance')
    const timing = new StartupTiming(progress)
    const { home, workspace, spaceId } = await this.spaces.prepare(userId)
    const upgraded = await this.upgrade?.prepare(userId, spaceId)
    const profileTask = (async () => {
      try {
        await prepareCommunityProfile(home, this.config.defaultModel.provider, this.config.defaultModel.model)
        return this.managedPlugins ? await memberProfileBundles(home) : []
      } catch (error) { throw new CommunityRuntimeUnavailableError('profile-unavailable', 'Private DSH profile could not be prepared; repair its configuration before retrying', { cause: error }) }
    })()
    const platformTask = prepareCommunityPlatformPlugin(this.config.dataRoot, this.config.container !== undefined, this.prepared)
    const memberTask = (async () => {
      await this.mcp?.prepare(userId)
      await this.skills?.prepare(userId)
      return this.skills ? await prepareMemberSkills(this.config, spaceId, this.prepared) : undefined
    })()
    // Drain every preparation even on failure; a retry cannot overlap abandoned writes.
    const [profileResult, platformResult, memberResult] = await Promise.allSettled([profileTask, platformTask, memberTask] as const)
    for (const result of [profileResult, platformResult, memberResult]) if (result.status === 'rejected') { timing.finish(); throw result.reason }
    if (profileResult.status !== 'fulfilled' || platformResult.status !== 'fulfilled' || memberResult.status !== 'fulfilled') throw new Error('Host preparation did not settle')
    const installed = profileResult.value, platformPatch = platformResult.value, memberSkills = memberResult.value
    const memberMcp = this.mcp ? memberMcpPreparation(this.config, spaceId) : undefined
    const plugins = this.managedPlugins?.effective(userId, installed) ?? []
    const accessiblePlugins = this.managedPlugins?.accessible?.(userId) ?? plugins
    const localPluginSnapshot = this.managedPlugins?.localSelection?.(userId) ?? []
    const pluginAccess = this.pluginAccess?.resolve(accessiblePlugins, access)
    const managedPlugins = await prepareManagedPlugins(this.config.dataRoot, spaceId, accessiblePlugins, this.config.container !== undefined, pluginAccess?.entries, plugins.map(row => row.packageName), this.prepared)
    const expertPlans = this.experts?.plans(userId) ?? []
    const memberExperts = expertPlans.length ? await prepareMemberExperts(this.config, spaceId, expertPlans, this.expertSkills, {
      plugins: accessiblePlugins, global: [...plugins.filter(row => !managedPlugins?.failures.includes(row.packageName)).map(row => row.packageName), ...installed.filter(name => localPluginSnapshot.includes(name))], entries: managedPlugins?.expertEntries ?? {},
    }, this.mcp?.expertProjection?.(userId), this.prepared) : undefined
    const publicOrigin = new URL(publicOriginUrl)
    const publicUrl = new URL(communitySpacePath(spaceId), publicOrigin)
    const listenerPort = this.config.container?.internalPort ?? await loopbackPort()
    try {
      if (this.managedPlugins) await preparePluginCoordination(home, plugins.filter(plugin => !managedPlugins?.failures.includes(plugin.packageName)), this.managedPlugins, this.config.container ? DSH_CONTAINER_HOME : home)
    }
    catch (error) { throw new CommunityRuntimeUnavailableError('profile-unavailable', 'Private DSH profile could not be prepared; repair its configuration before retrying', { cause: error }) }
    await Promise.all([join(home, '.agents'), join(home, 'Documents')]
      .map(path => mkdir(path, { recursive: true, mode: 0o700 })))
    signal.throwIfAborted()
    const inherited: Record<string, string> = {}
    for (const key of ['PATH', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL']) if (process.env[key] !== undefined) inherited[key] = process.env[key]!
    const environment: Record<string, string> = { ...inherited, ...this.config.environment, ...pluginAccess?.environment, HOME: home, DSH_HOME: dshHomePath(home), DSH_AGENTS_HOME: join(home, '.agents'),
      DSH_PHALANX_UPGRADE_NOTICE: upgraded?.selectSharedModel ? 'choose-shared-model' : '',
      DSH_TELEMETRY_MODE: 'DISABLED', DSH_TELEMETRY_DISABLED: '1', DSH_PHALANX_WORKSPACE_DOCUMENTS_DIR: join(home, 'Documents'),
      DSH_PHALANX_DEFAULT_MODEL_SECRET_CATALOG: modelCatalogJson(this.config.defaultModel.model), DSH_PHALANX_MODEL_GATEWAY_URL: access.url,
      [SKILL_USAGE_ENDPOINT_ENV]: new URL(SKILL_USAGE_PATH, access.url).href, [SKILL_USAGE_PROVIDERS_ENV]: JSON.stringify([...(memberSkills ? [memberSkillsProvider] : []), ...(memberExperts?.skillProviders ?? [])]),
      DSH_PHALANX_MODEL_GATEWAY_ACCESS_TOKEN: access.token, [WEB_TOOLS_MEMBER_TOKEN_ENV]: access.token }
    if (memberSkills) {
      const root = this.config.container ? memberSkillsMount : join(this.config.dataRoot, 'skills', 'members', spaceId)
      environment.PATH = `${join(root, 'commands', 'live')}:${join(root, 'dependencies', 'live')}:${environment.PATH ?? '/usr/local/bin:/usr/bin:/bin'}`
    }
    const managed = this.config.container === undefined ? join(this.config.dataRoot, managedModelsDirectory) : managedModelsContainerPath
    Object.assign(environment, { DSH_PHALANX_MANAGED_MODELS_CONFIG: join(managed, managedModelsConfig),
      DSH_PHALANX_MANAGED_MODELS_CATALOG: join(managed, managedModelsCatalog), DSH_PHALANX_MANAGED_MODELS_WATCHER: join(managed, managedModelsWatcher) })
    if (this.config.container !== undefined) {
      const proxy = new URL(access.url).origin
      const authenticated = new URL(proxy)
      authenticated.username = 'dsh'; authenticated.password = access.token
      Object.assign(environment, egressEnvironment(authenticated.href))
    }
    timing.advance('starting')
    let name: string | undefined
    let child: ChildProcess | undefined
    let exited: Promise<void> | undefined
    let requestedResources: InstanceResourceLimits | undefined
    try {
      const container = this.config.container
      if (container === undefined) {
        child = spawn(this.config.command, webServiceArgs(this.config.args, [...(this.config.patches ?? []), fileURLToPath(communityOverlayUrl), join(managed, 'overlay.yml'), platformPatch, ...(managedPlugins ? [managedPlugins.patch] : []), ...(memberSkills ? [memberSkills.patch] : []), ...(memberMcp ? [memberMcp.patch] : []), ...(memberExperts ? [memberExperts.patch] : [])], listenerPort, publicOrigin.host, publicUrl.href),
          { cwd: workspace, env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
      } else {
        requestedResources = this.resources?.forSpace(spaceId) ?? legacyInstanceResources(container.extraArgs)
        const plan = buildCommunityContainerLaunchCommand({ config: this.config, resourceLimits: requestedResources, userId, hostname: await this.hostnames.get(userId), runtimeHome: home, workspace,
          publicAuthority: publicOrigin.host, publicUrl: publicUrl.href, gatewayUrl: access.url, ownership: this.ownership, environment, ...(managedPlugins ? { managedPlugins } : {}), ...(memberSkills ? { memberSkills } : {}), ...(memberMcp ? { memberMcp } : {}), ...(memberExperts ? { memberExperts } : {}) })
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
      timing.advance('connecting')
      let pid = child.pid
      if (container !== undefined && name !== undefined) {
        url = rewriteToHostPort(url, await resolvePublishedPort(container, name))
        pid = Number((await execFileText(container.runtime, ['inspect', '--format', '{{.State.Pid}}', name])).trim())
      }
      signal.throwIfAborted()
      if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) throw new Error('User instance has no valid process identity')
      child.stdout?.resume(); child.stderr?.resume()
      const instance = { userId, resourceKey: randomUUID(), origin: url.origin, launchUrl: url.href, processId: pid, ...(name === undefined ? {} : { containerName: name, resourceLimits: await this.cgroups.read(pid) }) }
      if (requestedResources && (!instance.resourceLimits || !instanceResourcesApplied(instance.resourceLimits, requestedResources))) throw new CommunityRuntimeUnavailableError('startup-unavailable', 'Member resource limits could not be confirmed')
      const managedFailures = managedPlugins?.failures.filter(name => plugins.some(row => row.packageName === name)) ?? []
      const expertFailures = memberExperts?.failures ?? []
      Object.assign(instance, { inspection: 'checking', expertFailures, expertSnapshot: memberExperts?.snapshot ?? [], nativePluginSnapshot: installed, localPluginSnapshot, pluginAccessSnapshot: pluginAccess?.snapshot ?? [], managedSnapshot: plugins.map(plugin => `${plugin.packageName}@${plugin.version}:${plugin.integrity}`).sort(), managedFailures })
      const inspect = async (inspectionSignal: AbortSignal): Promise<InspectionResult> => timing.checking(async () => {
        const { managedFailures: pluginFailures, expertFailures: presetFailures } = await inspectCapabilities(
          managedPluginFailures(instance, publicOrigin, managedPlugins?.modulePrefixes ?? {}, inspectionSignal),
          expertPresetFailures(instance, publicOrigin, memberExperts?.expected ?? [], inspectionSignal),
        )
        const failedExperts = new Map<string, Set<string>>()
        for (const failure of [...expertFailures, ...presetFailures]) failedExperts.set(failure.id, new Set([...(failedExperts.get(failure.id) ?? []), ...failure.entries]))
        return { managedFailures: [...new Set([...managedFailures, ...pluginFailures])], expertFailures: [...failedExperts].map(([id, entries]) => ({ id, entries: [...entries].sort() })) }
      })
      const fallback = { managedFailures: [...new Set([...managedFailures, ...Object.keys(managedPlugins?.modulePrefixes ?? {})])],
        expertFailures: [...expertFailures, ...(memberExperts?.expected ?? []).map(row => ({ id: row.id, entries: ['preset'] }))] }
      signal.throwIfAborted()
      this.processes.set(instance, { child, exited, inspect, fallback })
      timing.finish()
      return instance
    } catch (error) {
      timing.finish()
      let cleanupFailure: unknown
      try { if (name !== undefined) await this.removeContainer(name) } catch (failure) { cleanupFailure = failure }
      try { if (child?.pid !== undefined && exited !== undefined) await terminateChild(child, exited, this.config.shutdownTimeoutMs ?? 10_000) }
      catch (failure) { cleanupFailure ??= failure }
      if (cleanupFailure !== undefined) throw new CommunityRuntimeCleanupError('User instance cleanup could not be confirmed', { cause: cleanupFailure })
      throw error
    }
  }
  inspect(instance: CommunityUserInstance): void {
    const handle = this.processes.get(instance)
    if (handle) void this.inspection.start(instance, handle.inspect, handle.fallback)
  }
  async applyResources(instance: CommunityUserInstance, limits: InstanceResourceLimits) {
    const container = this.config.container
    if (!container || !instance.containerName || !this.processes.has(instance)) throw new Error('Current member container is unavailable')
    await this.assertResourceCarrier(instance)
    try { await execFileText(container.runtime, ['update', ...instanceResourceArguments(limits), instance.containerName], { env: containerClientEnvironment(), timeout: 30_000 }) }
    catch { /* A still-readable carrier can fall back to a confirmed restart. */ }
    await this.assertResourceCarrier(instance)
    const observed = await this.cgroups.read(instance.processId)
    Object.assign(instance, { resourceLimits: observed })
    return observed
  }
  private async assertResourceCarrier(instance: CommunityUserInstance): Promise<void> {
    const value = await execFileText(this.config.container!.runtime, ['inspect', '--format', '{{.State.Running}} {{.State.Pid}} {{index .Config.Labels "dsh-phalanx.community-root"}}', instance.containerName!], { env: containerClientEnvironment() })
    if (value.trim() !== `true ${instance.processId} ${this.ownership}`) throw new Error('Member container identity changed')
  }
  async running(instances: readonly CommunityUserInstance[]): Promise<readonly CommunityUserInstance[]> {
    const container = this.config.container
    if (container === undefined) return instances.filter(instance => this.processAlive(instance))
    const output = await execFileText(container.runtime, ['ps', '--filter', 'status=running',
      '--filter', 'label=dsh-phalanx.community=1', '--filter', `label=dsh-phalanx.community-root=${this.ownership}`, '--format', '{{.Names}}'])
    const names = new Set(output.split('\n').map(name => name.trim()))
    return instances.filter(instance => instance.containerName !== undefined && names.has(instance.containerName))
  }
  async alive(instance: CommunityUserInstance): Promise<boolean> {
    if (instance.containerName !== undefined) {
      const container = this.config.container
      if (container === undefined) throw new Error('Container runtime is unavailable')
      const output = await execFileText(container.runtime, ['ps', '--filter', 'status=running', '--filter', `name=^${instance.containerName}$`, '--format', '{{.Names}}'])
      return output.split('\n').some(name => name.trim() === instance.containerName)
    }
    return this.processAlive(instance)
  }
  private processAlive(instance: CommunityUserInstance): boolean {
    const handle = this.processes.get(instance)
    return handle !== undefined && handle.child.exitCode === null && handle.child.signalCode === null
  }
  async stop(instance: CommunityUserInstance): Promise<void> {
    await this.inspection.stop(instance)
    if (instance.containerName !== undefined) await this.removeContainer(instance.containerName)
    await this.releaseProcess(instance, false)
  }
  async detach(instance: CommunityUserInstance): Promise<void> { await this.inspection.stop(instance); await this.releaseProcess(instance, instance.containerName !== undefined) }
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
