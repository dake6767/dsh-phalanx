import { ContributionMaintenance } from '../adapters/contribution-maintenance.js'
import { MemberContributions } from '../use-cases/member-contributions.js'
import { FileContributionStore, FileContributionArtifacts } from '../adapters/contribution-storage.js'
import { createContributionGateway } from '../inbound/contribution-route.js'
import { SHARED_MCP_REQUEST_CEILING_MS } from '../domain/mcp-service.js'
import { MemberMcpProbe } from '../adapters/mcp-member-probe.js'
import { SharedMcpPreparer } from '../adapters/mcp-shared-preparer.js'
import { SharedMcpProcess } from '../adapters/mcp-shared-process.js'
import { McpSharedRuntime } from '../use-cases/mcp-shared-runtime.js'
import { McpRuntimeCoordination, McpRuntimePreparation } from '../use-cases/mcp-runtime-preparation.js'
import { MemberMcpPreparer } from '../adapters/mcp-member-preparer.js'
import { GatewayMcpProbe } from '../adapters/mcp-probe.js'
import { McpCatalogImports } from '../use-cases/mcp-catalog-imports.js'
import { McpConnectionTest } from '../use-cases/mcp-connection-test.js'
import { McpHttpWire } from '../adapters/mcp-wire.js'
import { FileMcpAudit } from '../adapters/mcp-audit.js'
import { McpServices } from '../use-cases/mcp-services.js'
import { FileMcpStore } from '../adapters/mcp-store.js'
import { FileMcpProjection } from '../adapters/mcp-projection.js'
import { createMcpGateway } from '../inbound/mcp-gateway.js'
import type { Clock } from '../ports/clock.js'
import type { ExecutionDeadlinePort } from '../ports/execution-control.js'
import { ServicePreview } from '../use-cases/service-preview.js'
import { ContainerServicePreviewTransport, RandomPreviewCapabilities } from '../adapters/service-preview-transport.js'
import { createServicePreviewGateway } from '../inbound/service-preview-gateway.js'
import { servicePreviewEntry } from '../inbound/service-preview-entry.js'
import { GitSkillRepository } from '../adapters/skill-git.js'
import { FileSkillImportIntent } from '../adapters/skill-import-intent.js'
import { SkillPacks } from '../use-cases/skill-packs.js'
import { FileSkillPackStore } from '../adapters/skill-pack-store.js'
import { FileExecutionLimits, FileExecutionAudit, ExecutionDeadlines, ExecutionMaintenance } from '../adapters/execution-control-store.js'
import { ExecutionControl } from '../use-cases/execution-control.js'
import { ExecutionOperations } from '../use-cases/execution-operations.js'
import { FileExecutionInspection } from '../adapters/execution-inspection.js'
import { ExecutionPreparation } from '../use-cases/execution-preparation.js'
import { FileExecutionPreparations } from '../adapters/execution-preparation-store.js'
import { FileExecutionArtifacts } from '../adapters/execution-artifacts.js'
import { ContainerExecutionProcess } from '../adapters/execution-container-process.js'
import { ContainerExecutionPreparer } from '../adapters/execution-preparer.js'
import { FileExecutionConfigurations } from '../adapters/execution-configuration-store.js'
import { FileExecutionProjection } from '../adapters/execution-projection.js'
import { ContainerExecutionRunner } from '../adapters/execution-runner.js'
import { PlatformExecution } from '../use-cases/platform-execution.js'
import { ExecutionAdministration } from '../use-cases/execution-administration.js'
import { SkillExecutionOwners } from '../use-cases/skill-execution-owners.js'
import { createExecutionGateway } from '../inbound/execution-gateway.js'
import { memberSkillsMount } from '../dsh/member-skills.js'
import { FileMemberSkillNames } from '../adapters/member-skill-names.js'
import { SkillMembership } from '../use-cases/skill-membership.js'
import { MemberEffectiveSkills } from '../use-cases/member-effective-skills.js'
import { FileSkillAssignments } from '../adapters/skill-assignments.js'
import { FileSkillDistribution } from '../adapters/skill-distribution.js'
import { SkillLibrary } from '../use-cases/skill-library.js'
import { FileSkillLibraryStore } from '../adapters/skill-library-store.js'
import { FileSkillArtifacts } from '../adapters/skill-artifacts.js'
import { runtimeSkillNames } from '../adapters/runtime-skills.js'
import { FilePluginAccessStore } from '../adapters/plugin-access-store.js'
import { YamlPluginAccessSyntax } from '../adapters/plugin-access-syntax.js'
import { PluginAccessAdministration } from '../use-cases/plugin-access-administration.js'
import { MemberPluginAccess } from '../use-cases/member-plugin-access.js'
import { FilePluginSelections } from '../adapters/plugin-selections.js'
import { PluginUpstreamTest } from '../use-cases/plugin-upstream-test.js'
import { FilePluginUpstreams } from '../adapters/plugin-upstreams.js'
import { NodePluginUpstreamTransport } from '../adapters/plugin-upstream-transport.js'
import { PluginUpstreamAdministration } from '../use-cases/plugin-upstream-administration.js'
import { PluginUpstreamAccess } from '../use-cases/plugin-upstream-access.js'
import { createPluginUpstreamGateway } from '../inbound/plugin-upstream-gateway.js'
import { PluginCompatibility } from '../use-cases/plugin-compatibility.js'
import { PluginLibraryMembership } from '../use-cases/plugin-library-membership.js'
import { PluginMarket } from '../use-cases/plugin-market.js'
import { NativeMemberPluginManager } from '../adapters/member-plugin-manager.js'
import { createPluginMarketRoute } from '../inbound/plugin-market-route.js'
import type { MemberPluginManagerPort } from '../ports/plugin-market.js'
import { FilePluginGrants } from '../adapters/plugin-grants.js'
import { MemberManagedPlugins } from '../use-cases/member-managed-plugins.js'
import { ManagedPluginAdministration } from '../use-cases/managed-plugin-administration.js'
import { declaredRuntimeRevision, pluginCompatibilityTarget } from '../adapters/runtime-revision.js'
import { FilePluginUpload } from '../adapters/plugin-upload.js'
import { ContainerPluginArchiveInspector } from '../adapters/plugin-archive-inspector.js'
import { FilePluginLibraryStore } from '../adapters/plugin-library-store.js'
import { ContainerPluginPreparer } from '../adapters/plugin-preparer.js'
import { PluginLibrary } from '../use-cases/plugin-library.js'
import type { PluginPreparerPort, PluginArchiveInspectorPort } from '../ports/plugin-library.js'
import { CommunitySystemUpdate } from '../use-cases/community-system-update.js'
import { UnixCommunitySystemUpdate } from '../adapters/community-system-update.js'
import type { CommunitySystemUpdatePort } from '../ports/community-system-update.js'
import { FileCommunityMaintenance } from '../adapters/community-maintenance.js'
import { secureCommunityProxyCookies } from '../inbound/community-proxy-cookies.js'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createProxyServer } from 'http-proxy-3'
import type { IncomingMessage } from 'node:http'
import { validateCommunityModelCredential, validateCommunityNetworkAddresses, type CommunityConfig } from '../domain/community-config.js'
import { validateConfig } from '../domain/config-validation.js'
import type { CommunityRuntimePort } from '../ports/community-runtime.js'
import type { CommunityApplication } from '../ports/community-application.js'
import { FileCommunityModelAccess } from '../adapters/community-model-access.js'
import { SharedCommunityModelUpstream } from '../adapters/community-model-upstream.js'
import { CommunityModelAuthorization } from '../use-cases/community-model-authorization.js'
import { createCommunityModelGateway } from '../inbound/community-model-gateway.js'
import { CommunityAccountStore } from '../adapters/community-account-store.js'
import { CommunityBootstrapCredential, assertCommunityDataRoot } from '../adapters/community-bootstrap.js'
import { PlatformLock } from '../adapters/platform-lock.js'
import { FileCommunityUserSpaces } from '../adapters/community-user-spaces.js'
import { CommunityRuntimeDriver } from '../adapters/community-runtime-driver.js'
import { CommunityInstanceLifecycle } from '../use-cases/community-instance-lifecycle.js'
import { HttpDshSession } from '../adapters/dsh-session.js'
import { MemorySessionRegistry } from '../adapters/memory-session-registry.js'
import { FileAdminAssetSource } from '../adapters/file-admin-assets.js'
import { AdminAssetServer } from '../inbound/admin-assets.js'
import { CommunityOnboarding } from '../use-cases/community-onboarding.js'
import { CommunityEntry } from '../use-cases/community-entry.js'
import { CommunityAccountAdministration } from '../use-cases/community-account-administration.js'
import { createCommunityAdminRoute } from '../inbound/community-admin-route.js'
import { communityAccountRoutes } from '../inbound/community-account-routes.js'
import { createHttpEntry } from '../inbound/http-entry.js'
import { handleProxyError, closeIncompleteProxyResponse } from '../inbound/proxy-error.js'
import { createGatewayOnlyServer, createPublicServer } from '../inbound/public-server.js'
import { protectCommunityEntry } from '../inbound/community-http-entry.js'
import { PlatformSessionCodec, authenticatedUser, rememberRuntimeCookie, previewIdentity } from '../inbound/platform-session.js'
import { MODEL_GATEWAY_BASE_PATH } from '../dsh/model-protocol.js'
import { systemClock } from '../adapters/system-clock.js'
import { createIdleReclamation } from '../use-cases/idle-reclamation.js'
import { CommunityLifecycle } from './community-lifecycle.js'
import { CommunityNetworkAccess } from '../use-cases/community-network-access.js'
import { NodeNetworkResolver, NodeNetworkTransport } from '../adapters/public-network.js'
import { createCommunityNetworkProxy } from '../inbound/community-network-proxy.js'
import { FileSharedModelStore, initialSharedModelState } from '../adapters/shared-model-store.js'
import { SharedModelAdministration } from '../use-cases/shared-model-administration.js'
import { CommunityInstanceActions } from '../use-cases/community-instance-actions.js'
import { createCommunityMemberRoute } from '../inbound/community-member-route.js'

import { FileCommunityEnvironmentUpgrade } from '../adapters/community-environment-upgrade.js'
import { CommunityEnvironmentUpgrade } from '../use-cases/community-environment-upgrade.js'
import { FileCommunityEnvironment } from '../adapters/community-environment.js'
import { CommunityEnvironmentRecovery } from '../use-cases/community-environment-recovery.js'
import type { CommunityEnvironmentPort } from '../ports/community-environment.js'

export interface CommunityApplicationOptions {
  readonly mcpPresets?: readonly import('../domain/mcp-catalog.js').McpPreset[]
  readonly mcpTransport?: import('../ports/plugin-upstreams.js').PluginUpstreamTransportPort
  readonly clock?: Clock
  readonly executionDeadlines?: ExecutionDeadlinePort
  readonly pluginManager?: MemberPluginManagerPort
  readonly pluginArchiveInspector?: PluginArchiveInspectorPort
  readonly pluginPreparer?: PluginPreparerPort
  readonly runtime?: CommunityRuntimePort
  readonly environment?: CommunityEnvironmentPort
  readonly systemUpdate?: CommunitySystemUpdatePort
}

/** Wires the community product entry, accounts, private instances and model defaults. */
export function createCommunityApplication(config: CommunityConfig, options: CommunityApplicationOptions = {}): CommunityApplication {
  const clock = options.clock ?? systemClock
  validateConfig(config)
  validateCommunityModelCredential(config)
  validateCommunityNetworkAddresses(config)
  const maintenance = new FileCommunityMaintenance(config.maintenanceFile)
  const sessions = new PlatformSessionCodec(config.sessionSecret)
  assertCommunityDataRoot(config.runtime.dataRoot)
  const lock = new PlatformLock(config.runtime.dataRoot)
  let accounts: CommunityAccountStore
  try { accounts = new CommunityAccountStore(join(config.runtime.dataRoot, 'community-accounts.db')) }
  catch (error) { lock.close(); throw error }
  let userSpaces: FileCommunityUserSpaces
  let modelAccess: FileCommunityModelAccess
  let modelStore: FileSharedModelStore
  let compatibility: PluginCompatibility
  let executionRunner: ContainerExecutionRunner
  let executionPreparation: ExecutionPreparation
  let executionControl: ExecutionControl
  let executionOperations: ExecutionOperations
  let execution: PlatformExecution
  let executionAdministration: ExecutionAdministration
  let skillPacks: SkillPacks
  let mcpPreparation: McpRuntimeCoordination
  let sharedMcp: McpSharedRuntime
  let mcp: McpServices
  let skills: SkillLibrary
  let plugins: PluginLibrary
  let pluginStore: FilePluginLibraryStore
  let accessStore: FilePluginAccessStore
  let selections: FilePluginSelections
  let upstreamStore: FilePluginUpstreams
  let pluginGrants: FilePluginGrants
  let managedPlugins: MemberManagedPlugins
  try {
    const mcpStore = new FileMcpStore(join(config.runtime.dataRoot, 'mcp', 'library.json'))
    modelStore = new FileSharedModelStore(join(config.runtime.dataRoot, 'shared-models.json'), initialSharedModelState(config), config.runtime)
    modelAccess = new FileCommunityModelAccess(join(config.runtime.dataRoot, 'model-access.json'))
    userSpaces = new FileCommunityUserSpaces(config.runtime, accounts)
    const skillRoot = join(config.runtime.dataRoot, 'skills'), bundledSkillNames = runtimeSkillNames()
    const skillStore = new FileSkillLibraryStore(join(skillRoot, 'library.json')), artifacts = new FileSkillArtifacts(join(skillRoot, 'artifacts'), bundledSkillNames, new GitSkillRepository(join(skillRoot, 'git-intake'), { proxy: process.env.HTTPS_PROXY ?? process.env.https_proxy, caFile: process.env.GIT_SSL_CAINFO }))
    const skillGrants = new FileSkillAssignments(join(skillRoot, 'grants.json')), skillSelections = new FileSkillAssignments(join(skillRoot, 'selections.json'))
    const packState = { store: new FileSkillPackStore(join(skillRoot, 'packs.json')), grants: new FileSkillAssignments(join(skillRoot, 'pack-grants.json')), selections: new FileSkillAssignments(join(skillRoot, 'pack-selections.json')) }
    const effectiveSkills = new MemberEffectiveSkills(accounts, skillStore, skillGrants, skillSelections, packState)
    const executionStore = new FileExecutionConfigurations(join(config.runtime.dataRoot, 'execution', 'configuration.json'))
    const executionOwners = new SkillExecutionOwners(skillStore, effectiveSkills, accounts, executionStore)
    const projection = new FileExecutionProjection(join(skillRoot, 'members'), config.runtime.container ? memberSkillsMount : undefined, executionOwners.commands.bind(executionOwners))
    const executionLimits = new FileExecutionLimits(join(config.runtime.dataRoot, 'execution', 'limits.json'))
    executionControl = new ExecutionControl(executionLimits, new FileExecutionAudit(join(config.runtime.dataRoot, 'execution', 'audit.json')), clock, options.executionDeadlines ?? new ExecutionDeadlines(), new ExecutionMaintenance())
    const executionProcess = new ContainerExecutionProcess(config.runtime, executionLimits)
    const memberPreparation = new McpRuntimePreparation(mcpStore, new FileExecutionPreparations(join(config.runtime.dataRoot, 'mcp', 'preparations.json')),
      new MemberMcpPreparer(config.runtime, executionProcess), systemClock, () => mcp.recover())
    const sharedProcess = new SharedMcpProcess(config.runtime, executionProcess, executionLimits)
    sharedMcp = new McpSharedRuntime(sharedProcess, executionControl, clock, new ExecutionMaintenance(5000), (...args) => mcp.runtimeService(...args))
    const sharedPreparation = new McpRuntimePreparation(mcpStore, new FileExecutionPreparations(join(config.runtime.dataRoot, 'mcp', 'shared-preparations.json')),
      new SharedMcpPreparer(config.runtime, executionProcess, sharedProcess.retainedArtifacts.bind(sharedProcess)), systemClock, () => mcp.recover(), 'shared')
    mcpPreparation = new McpRuntimeCoordination(memberPreparation, sharedPreparation, sharedMcp, () => sharedProcess.isolated)
    mcp = new McpServices(accounts, mcpStore, new FileMcpProjection(config.runtime), mcpPreparation, options.mcpPresets)
    const executionArtifacts = new FileExecutionArtifacts(join(config.runtime.dataRoot, 'execution', 'artifacts'))
    executionPreparation = new ExecutionPreparation(executionOwners, executionStore,
      new FileExecutionPreparations(join(config.runtime.dataRoot, 'execution', 'preparations.json')),
      new ContainerExecutionPreparer(config.runtime, executionProcess, artifacts, executionArtifacts), systemClock)
    executionRunner = new ContainerExecutionRunner(config.runtime, userSpaces, artifacts, executionProcess, executionArtifacts)
    const executionInspection = new FileExecutionInspection(artifacts)
    execution = new PlatformExecution(executionOwners, executionStore, executionRunner, executionPreparation, executionInspection, executionControl)
    executionOperations = new ExecutionOperations(accounts, executionControl, execution, userSpaces, config.runtime.container !== undefined, () => executionProcess.isolated)
    executionAdministration = new ExecutionAdministration(accounts, executionOwners, executionStore, async () => { await skills.recover() }, executionPreparation, executionInspection)
    skills = new SkillLibrary(accounts, skillStore, artifacts, systemClock, new SkillMembership(accounts, skillStore, skillGrants, skillSelections, effectiveSkills, new FileSkillDistribution(join(skillRoot, 'members'), artifacts, projection), () => executionPreparation.changed(), packState), new FileMemberSkillNames(config.runtime, accounts), bundledSkillNames, packState, new FileSkillImportIntent(join(skillRoot, 'import-intent.json')))
    skillPacks = new SkillPacks(accounts, skillStore, packState, skillGrants, skills, artifacts, systemClock, bundledSkillNames, skillSelections)
    pluginStore = new FilePluginLibraryStore(join(config.runtime.dataRoot, 'plugins', 'library.json'))
    accessStore = new FilePluginAccessStore(join(config.runtime.dataRoot, 'plugins', 'access.json'))
    selections = new FilePluginSelections(join(config.runtime.dataRoot, 'plugins', 'selections.json'))
    upstreamStore = new FilePluginUpstreams(join(config.runtime.dataRoot, 'plugin-upstreams.json'))
    pluginGrants = new FilePluginGrants(join(config.runtime.dataRoot, 'plugins', 'grants.json'))
    managedPlugins = new MemberManagedPlugins(accounts, pluginStore, pluginGrants, declaredRuntimeRevision(), selections)
    const preparer = options.pluginPreparer ?? new ContainerPluginPreparer(config.runtime)
    compatibility = new PluginCompatibility(pluginStore, preparer, pluginCompatibilityTarget())
    plugins = new PluginLibrary(accounts, pluginStore, preparer, new FilePluginUpload(config.runtime.dataRoot, options.pluginArchiveInspector ?? new ContainerPluginArchiveInspector(config.runtime)), new PluginLibraryMembership(accounts, pluginGrants, selections), pluginCompatibilityTarget(), { access: accessStore, upstreams: upstreamStore })
  }
  catch (error) { accounts.close(); lock.close(); throw error }
  const credential = new CommunityBootstrapCredential(config.runtime.dataRoot, accounts.bootstrapComplete.bind(accounts))
  const environmentStorage = options.environment ?? new FileCommunityEnvironment(config.runtime.dataRoot, userSpaces)
  const upgrade = new CommunityEnvironmentUpgrade(new FileCommunityEnvironmentUpgrade(config.runtime.dataRoot, userSpaces), environmentStorage)
  const memberPluginAccess = new MemberPluginAccess(managedPlugins, accessStore)
  const accessAdministration = new PluginAccessAdministration(accounts, pluginStore, accessStore, upstreamStore, new YamlPluginAccessSyntax())
  const runtime = options.runtime ?? new CommunityInstanceLifecycle(new CommunityRuntimeDriver(config.runtime, userSpaces, upgrade, managedPlugins, memberPluginAccess, skills, mcp),
    userId => ({ url: `${lifecycle.gatewayOrigin().origin}${MODEL_GATEWAY_BASE_PATH}`, token: modelAccess.forUser(userId, accounts.getState(userId)!.spaceId) }))
  const dshSession = new HttpDshSession()
  const onboarding = new CommunityOnboarding(accounts, credential)
  const entry = new CommunityEntry(accounts, runtime, dshSession, userSpaces)
  const connections = new MemorySessionRegistry()
  const contributions = new MemberContributions(accounts, new FileContributionStore(join(config.runtime.dataRoot, 'contributions', 'records.json')), new FileContributionArtifacts(join(config.runtime.dataRoot, 'contributions', 'artifacts'), runtimeSkillNames()), skills, systemClock, new ContributionMaintenance())
  const administration = new CommunityAccountAdministration(accounts, runtime, connections, pluginGrants, async () => { await skills.recover(); await mcp.recover(); await contributions.recover() })
  const actions = new CommunityInstanceActions(accounts, runtime, connections)
  const managedAdministration = new ManagedPluginAdministration(accounts, pluginStore, pluginGrants, managedPlugins, runtime, actions, declaredRuntimeRevision(), memberPluginAccess)
  const environment = new CommunityEnvironmentRecovery(accounts, runtime, environmentStorage, connections)
  const modelAdministration = new SharedModelAdministration(accounts, modelStore)
  const market = new PluginMarket(accounts, pluginStore, options.pluginManager ?? new NativeMemberPluginManager(), runtime, selections, managedPlugins, declaredRuntimeRevision(), memberPluginAccess, upstreamStore)
  const upstreams = new PluginUpstreamAdministration(accounts, pluginStore, upstreamStore, accessAdministration)
  const upstreamTransport = new NodePluginUpstreamTransport()
  const upstreamTest = new PluginUpstreamTest(upstreams, upstreamStore, upstreamTransport, systemClock)
  const pluginUpstreams = createPluginUpstreamGateway({ access: new PluginUpstreamAccess(accounts, modelAccess, pluginStore, pluginGrants, upstreamStore, declaredRuntimeRevision()), transport: upstreamTransport, connections })
  const modelAuthorization = new CommunityModelAuthorization(accounts, modelAccess)
  const mcpProbe = new GatewayMcpProbe(() => lifecycle.gatewayOrigin(), modelAccess, new McpHttpWire())
  const memberMcpProbe = new MemberMcpProbe(config.runtime, mcp.diagnostic.bind(mcp), username => entry.ensure(username, lifecycle.origin()), userSpaces)
  const mcpTest = new McpConnectionTest(mcp, mcpProbe, memberMcpProbe)
  const mcpImports = new McpCatalogImports(mcp, mcpTest, mcpProbe)
  const mcpGateway = createMcpGateway({ authorization: modelAuthorization, services: mcp, shared: sharedMcp, wire: new McpHttpWire(), transport: options.mcpTransport ?? new NodePluginUpstreamTransport('idle'), sharedTransport: options.mcpTransport ?? new NodePluginUpstreamTransport('idle', SHARED_MCP_REQUEST_CEILING_MS), clock, audit: new FileMcpAudit(join(config.runtime.dataRoot, 'mcp', 'audit.json')), connections })
  const contributionGateway = createContributionGateway(contributions, modelAuthorization, entry.account.bind(entry))
  const executionGateway = createExecutionGateway(execution, modelAuthorization, connections)
  const model = createCommunityModelGateway({ authorization: modelAuthorization, connections,
    upstream: new SharedCommunityModelUpstream(modelStore) })
  const networkAccess = new CommunityNetworkAccess(modelAuthorization, new NodeNetworkResolver(config.listen.publicOrigin, config.network?.hostPublicAddresses))
  const network = createCommunityNetworkProxy({ access: networkAccess, transport: new NodeNetworkTransport(), connections })
  const proxy = createProxyServer({ ws: true })
  proxy.on('error', handleProxyError)
  proxy.on('proxyRes', closeIncompleteProxyResponse)
  const authenticate = (request: IncomingMessage) => authenticatedUser(request, sessions, accounts.getState.bind(accounts))
  const session = { authenticate,
    current: (request: IncomingMessage, username: string) => authenticate(request) === username }
  const preview = new ServicePreview(accounts, runtime, clock, [config.listen.port, config.runtime.container?.internalPort ?? 4180, config.runtime.container?.gatewayPort ?? 3081, config.preview?.port ?? 0], new RandomPreviewCapabilities())
  const previewSession = (request: IncomingMessage) => authenticate(request) ? previewIdentity(request, sessions) : undefined
  const rememberCookie = (username: string, header: string | undefined) => rememberRuntimeCookie(connections, username, header)
  const assets = new AdminAssetServer(new FileAdminAssetSource(config.adminUiRoot
    ?? fileURLToPath(new URL('../../admin-ui/dist', import.meta.url)), 'community.html'))
  const origin = () => lifecycle.origin()
  proxy.on('proxyRes', secureCommunityProxyCookies(origin))
  const routes = communityAccountRoutes({ onboarding, entry, sessions, origin })
  const recovery = createCommunityMemberRoute({ entry, actions })
  const admin = createCommunityAdminRoute({ authenticate, onboarding, administration, runtime, assets, origin,
    contributions, market, mcp, mcpTest, mcpImports, execution: executionAdministration, executionOperations, access: accessAdministration, upstreams, upstreamTest, models: modelAdministration, plugins, skills, skillPacks, managed: managedAdministration, environment, updates: new CommunitySystemUpdate(accounts, options.systemUpdate ?? new UnixCommunitySystemUpdate()) })
  const runtimeMount = entry.spacePath.bind(entry)
  const ensureRuntime = entry.ensure.bind(entry)
  const dispatch = createHttpEntry({ onLogout: request => { const identity = previewSession(request); if (identity) preview.revoke(identity) }, maintenance, origin, recordsReady: () => lifecycle.recordsReady(), connections,
    contributions: contributionGateway, model, mcp: mcpGateway, execution: executionGateway, pluginUpstreams, processGateways: config.runtime.container === undefined, bootstrap: routes.bootstrap, admin, enter: routes.enter,
    market: createPluginMarketRoute({ contributions, mcp, market, skills, skillPacks, entry }), loginForm: routes.loginForm, login: routes.login, recovery,
    session, runtimeMount, ensureRuntime, rememberRuntimeCookie: rememberCookie, proxy })
  const idle = createIdleReclamation({ idleSeconds: config.idleReclaimSeconds, clock, sessions: connections, runtime, dsh: dshSession,
    users: () => [...onboarding.activeUsernames()], recordsReady: () => lifecycle.recordsReady(), gateClosed: entry.accessClosed.bind(entry),
    origin, previewActivity: preview.lastActivity.bind(preview), onReclaimed: connections.clearIdle.bind(connections), onError: () => { console.warn('Idle user-space check failed; retained the instance') } })
  const lifecycle: CommunityLifecycle = new CommunityLifecycle({ config, knownUsers: onboarding.activeUsernames.bind(onboarding), runtime, connections,
    startBackgroundWork: () => { contributions.start(); executionPreparation.start(); mcpPreparation.start(); executionControl.start() },
    prepareBootstrap: async () => { executionControl.prune(); await executionPreparation.recover(); await mcpPreparation.recover(); credential.prepare(); await contributions.recover(); await skills.recover(); await mcp.interruptCatalogTests(); await plugins.recover(); await compatibility.recover(); managedPlugins.recover() }, checkIdle: idle.check, closeResources: async () => { try {
      executionControl.stop()
      await contributions.stop()
      const stopped = await Promise.allSettled([ mcpImports.stop(), mcpPreparation.stop(), memberMcpProbe.stop(), mcpProbe.stop(), mcp.stop(), executionPreparation.stop(), executionRunner.stop(), compatibility.stop(), plugins.stop(), skills.stop()])
      await mcpImports.drain()
      const failures = stopped.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
      if (failures.length) throw new AggregateError(failures, 'Community library shutdown failed')
    } finally { preview.close(); proxy.close(); accounts.close(); lock.close() } },
    sweepPreview: preview.sweep.bind(preview),
    ...(config.preview ? { createPreviewListener: createServicePreviewGateway({ access: preview, transport: new ContainerServicePreviewTransport(config.runtime.container!.runtime), identity: previewSession, platformOrigin: origin, previewOrigin: () => new URL(config.preview!.publicOrigin), available: () => lifecycle.recordsReady() && !maintenance.closed(), connections }) } : {}),
    createGatewayListener: () => createGatewayOnlyServer({ contributions: contributionGateway, maintenance, connections, model, network, pluginUpstreams, mcp: mcpGateway, execution: executionGateway }),
    createListener: () => createPublicServer({ connections,
      handle: protectCommunityEntry(servicePreviewEntry({ connections, dispatch, access: preview, identity: previewSession, origin, previewOrigin: config.preview ? new URL(config.preview.publicOrigin).origin : undefined, available: () => lifecycle.recordsReady() && !maintenance.closed() }), origin),
      upgrade: { maintenance, origin, recordsReady: lifecycle.recordsReady.bind(lifecycle),
        session, runtimeMount, ensureRuntime, rememberCookie, connections, proxy },
    }),
  })
  return lifecycle
}
