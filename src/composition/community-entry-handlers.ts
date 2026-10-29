import { createProxyServer } from 'http-proxy-3'
import { Agent, type IncomingMessage } from 'node:http'
import { fileURLToPath } from 'node:url'
import { BootstrapDatabase } from '../adapters/bootstrap-database.js'
import { CommunityBootstrapCredential } from '../adapters/community-bootstrap.js'
import { FileCommunityMaintenance } from '../adapters/community-maintenance.js'
import { SharedCommunityModelUpstream } from '../adapters/community-model-upstream.js'
import { UnixCommunitySystemUpdate } from '../adapters/community-system-update.js'
import { FileCommunityUserSpaces } from '../adapters/community-user-spaces.js'
import { communityWebToolsUpstream } from '../adapters/community-web-tools-upstream.js'
import { FileAdminAssetSource } from '../adapters/file-admin-assets.js'
import { MemberMcpProbe } from '../adapters/mcp-member-probe.js'
import { GatewayMcpProbe } from '../adapters/mcp-probe.js'
import { McpHttpWire } from '../adapters/mcp-wire.js'
import { MemorySessionRegistry } from '../adapters/memory-session-registry.js'
import { PlatformDatabase } from '../adapters/platform-database.js'
import { FilePluginArchiveSource } from '../adapters/plugin-archive-source.js'
import { NodePluginUpstreamTransport } from '../adapters/plugin-upstream-transport.js'
import { PostgresCommunityAccountStore } from '../adapters/postgres-community-accounts.js'
import { PostgresCommunityModelAccess } from '../adapters/postgres-community-model-access.js'
import { PostgresPluginGrants } from '../adapters/postgres-plugin-grants.js'
import { PostgresPluginLibraryStore } from '../adapters/postgres-plugin-library.js'
import { PostgresPluginUpstreams } from '../adapters/postgres-plugin-upstreams.js'
import { PostgresSharedModelStore } from '../adapters/postgres-shared-model-store.js'
import { PostgresSystemStatus } from '../adapters/postgres-system-status.js'
import { NodeNetworkResolver, NodeNetworkTransport } from '../adapters/public-network.js'
import { declaredRuntimeRevision } from '../adapters/runtime-revision.js'
import { ContainerServicePreviewTransport, RandomPreviewCapabilities } from '../adapters/service-preview-transport.js'
import { type CommunityConfig } from '../domain/community-config.js'
import { SHARED_MCP_REQUEST_CEILING_MS } from '../domain/mcp-service.js'
import { AdminAssetServer } from '../inbound/admin-assets.js'
import { communityAccountRoutes } from '../inbound/community-account-routes.js'
import { createCommunityAdminRoute } from '../inbound/community-admin-route.js'
import { protectCommunityEntry } from '../inbound/community-http-entry.js'
import { createCommunityMemberRoute } from '../inbound/community-member-route.js'
import { createCommunityModelGateway } from '../inbound/community-model-gateway.js'
import { createCommunityNetworkProxy } from '../inbound/community-network-proxy.js'
import { secureCommunityProxyCookies } from '../inbound/community-proxy-cookies.js'
import { createCommunityWebToolsGateway } from '../inbound/community-web-tools-gateway.js'
import { createContributionGateway } from '../inbound/contribution-route.js'
import { createExecutionGateway } from '../inbound/execution-gateway.js'
import { createHttpEntry } from '../inbound/http-entry.js'
import { createMcpGateway } from '../inbound/mcp-gateway.js'
import { PlatformSessionCodec, createEntrySessionGate, previewIdentity, rememberRuntimeCookie } from '../inbound/platform-session.js'
import { createPluginDownload } from '../inbound/plugin-download.js'
import { createPluginMarketRoute } from '../inbound/plugin-market-route.js'
import { createPluginUpstreamGateway } from '../inbound/plugin-upstream-gateway.js'
import { closeIncompleteProxyResponse, handleProxyError } from '../inbound/proxy-error.js'
import { createGatewayOnlyServer, createPublicServer } from '../inbound/public-server.js'
import { servicePreviewEntry } from '../inbound/service-preview-entry.js'
import { createServicePreviewGateway } from '../inbound/service-preview-gateway.js'
import { createUsageReportGateway } from '../inbound/usage-report-gateway.js'
import type { Clock } from '../ports/clock.js'
import type { CommunityRuntimePort } from '../ports/community-runtime.js'
import { CommunityAccountAdministration } from '../use-cases/community-account-administration.js'
import { CommunityDatabaseOnboarding } from '../use-cases/community-database-onboarding.js'
import { CommunityEntry } from '../use-cases/community-entry.js'
import { CommunityModelAuthorization } from '../use-cases/community-model-authorization.js'
import { CommunityNetworkAccess } from '../use-cases/community-network-access.js'
import { CommunityOnboarding } from '../use-cases/community-onboarding.js'
import { CommunitySystemStatus } from '../use-cases/community-system-status.js'
import { CommunitySystemUpdate } from '../use-cases/community-system-update.js'
import { DownloadSources } from '../use-cases/download-sources.js'
import { ExecutionAdministration } from '../use-cases/execution-administration.js'
import { ExecutionOperations } from '../use-cases/execution-operations.js'
import { InstanceResources } from '../use-cases/instance-resources.js'
import { ManagedPluginAdministration } from '../use-cases/managed-plugin-administration.js'
import { McpCatalogImports } from '../use-cases/mcp-catalog-imports.js'
import { McpConnectionTest } from '../use-cases/mcp-connection-test.js'
import { McpServices } from '../use-cases/mcp-services.js'
import { McpSharedRuntime } from '../use-cases/mcp-shared-runtime.js'
import { MemberContributions } from '../use-cases/member-contributions.js'
import { NativePluginDownloads } from '../use-cases/native-plugin-downloads.js'
import { PlatformExecution } from '../use-cases/platform-execution.js'
import { PluginAccessAdministration } from '../use-cases/plugin-access-administration.js'
import { PluginLibrary } from '../use-cases/plugin-library.js'
import { PluginLocalCopies } from '../use-cases/plugin-local-copies.js'
import { PluginMarket } from '../use-cases/plugin-market.js'
import { PluginUpstreamAccess } from '../use-cases/plugin-upstream-access.js'
import { PluginUpstreamAdministration } from '../use-cases/plugin-upstream-administration.js'
import { PluginUpstreamTest } from '../use-cases/plugin-upstream-test.js'
import { RuntimeDependencies } from '../use-cases/runtime-dependencies.js'
import { ServicePreview } from '../use-cases/service-preview.js'
import { SharedModelAdministration } from '../use-cases/shared-model-administration.js'
import { SkillLibrary } from '../use-cases/skill-library.js'
import { SkillPacks } from '../use-cases/skill-packs.js'
import { UsagePolicy } from '../use-cases/usage-policy.js'
import { CommunityLifecycle } from './community-lifecycle.js'
import { createExpertLibrary } from './expert-library.js'
import { createSuiteApplication } from './suite-application.js'

import { CommunityEnvironmentRecovery } from '../use-cases/community-environment-recovery.js'

import type { CommunityApplicationOptions } from './community-application-options.js'
/** Wires HTTP gateways and entry handlers around the application's single lifecycle owner. */
export function createCommunityEntryHandlers(input: {
  accounts: PostgresCommunityAccountStore
  modelAccess: PostgresCommunityModelAccess
  pluginStore: PostgresPluginLibraryStore
  pluginGrants: PostgresPluginGrants
  upstreamStore: PostgresPluginUpstreams
  localCopies: PluginLocalCopies
  runtime: CommunityRuntimePort
  experts: ReturnType<typeof createExpertLibrary>['experts']
  upstreamTransport: NodePluginUpstreamTransport
  nativeDownloads: NativePluginDownloads
  dataRoot: string
  usage: UsagePolicy
  config: CommunityConfig
  mcp: McpServices
  entry: CommunityEntry
  userSpaces: FileCommunityUserSpaces
  memberGatewayAccess: ConstructorParameters<typeof MemberMcpProbe>[4]
  sharedMcp: McpSharedRuntime
  options: CommunityApplicationOptions
  contributions: MemberContributions
  execution: PlatformExecution
  connections: MemorySessionRegistry
  modelStore: PostgresSharedModelStore
  testOnlyWebToolsBaseUrl: string | undefined
  sessions: PlatformSessionCodec
  clock: Clock
  credential: CommunityBootstrapCredential
  databaseBootstrap: BootstrapDatabase
  database: PlatformDatabase
  executionAdministration: ExecutionAdministration
  accessAdministration: PluginAccessAdministration
  modelAdministration: SharedModelAdministration
  managedAdministration: ManagedPluginAdministration
  onboarding: CommunityOnboarding
  environment: CommunityEnvironmentRecovery
  administration: CommunityAccountAdministration
  instanceResources: InstanceResources
  market: PluginMarket
  runtimeDependencies: RuntimeDependencies
  suites: ReturnType<typeof createSuiteApplication>
  downloads: DownloadSources
  executionOperations: ExecutionOperations
  upstreams: PluginUpstreamAdministration
  upstreamTest: PluginUpstreamTest
  plugins: PluginLibrary
  skills: SkillLibrary
  skillPacks: SkillPacks
  maintenance: FileCommunityMaintenance
  lifecycle: () => CommunityLifecycle
  ownAgent: (agent: Agent) => void
  ownProxy: (proxy: { close(): void }) => void
}) {
  const {
    accounts,
    modelAccess,
    pluginStore,
    pluginGrants,
    upstreamStore,
    localCopies,
    runtime,
    experts,
    upstreamTransport,
    nativeDownloads,
    dataRoot,
    usage,
    config,
    mcp,
    entry,
    userSpaces,
    memberGatewayAccess,
    sharedMcp,
    options,
    contributions,
    execution,
    connections,
    modelStore,
    testOnlyWebToolsBaseUrl,
    sessions,
    clock,
    credential,
    databaseBootstrap,
    database,
    executionAdministration,
    accessAdministration,
    modelAdministration,
    managedAdministration,
    onboarding,
    environment,
    administration,
    instanceResources,
    market,
    runtimeDependencies,
    suites,
    downloads,
    executionOperations,
    upstreams,
    upstreamTest,
    plugins,
    skills,
    skillPacks,
    maintenance,
    lifecycle,
    ownAgent,
    ownProxy,
  } = input
  const pluginUpstreams = createPluginUpstreamGateway({
    usage,
    access: new PluginUpstreamAccess(accounts, modelAccess, pluginStore, pluginGrants, upstreamStore, declaredRuntimeRevision(), localCopies, runtime, experts),
    transport: upstreamTransport,
    connections,
  })
  const modelAuthorization = new CommunityModelAuthorization(accounts, modelAccess)
  const pluginDownloads = createPluginDownload({
    connections,
    authorization: modelAuthorization,
    downloads: nativeDownloads,
    archives: new FilePluginArchiveSource(dataRoot),
  })
  const usageReports = createUsageReportGateway(modelAuthorization, usage)
  const mcpProbe = new GatewayMcpProbe(() => lifecycle().gatewayOrigin(), modelAccess, new McpHttpWire())
  const memberMcpProbe = new MemberMcpProbe(
    config.runtime,
    mcp.diagnostic.bind(mcp),
    username => entry.ensure(username, lifecycle().origin()),
    userSpaces,
    memberGatewayAccess,
  )
  const mcpTest = new McpConnectionTest(mcp, mcpProbe, memberMcpProbe)
  const mcpImports = new McpCatalogImports(mcp, mcpTest, mcpProbe)
  const mcpGateway = createMcpGateway({
    authorization: modelAuthorization,
    services: mcp,
    shared: sharedMcp,
    wire: new McpHttpWire(),
    transport: options.mcpTransport ?? new NodePluginUpstreamTransport('idle'),
    sharedTransport: options.mcpTransport ?? new NodePluginUpstreamTransport('idle', SHARED_MCP_REQUEST_CEILING_MS),
    usage,
    connections,
  })
  const contributionGateway = createContributionGateway(contributions, modelAuthorization, entry.account.bind(entry))
  const executionGateway = createExecutionGateway(execution, modelAuthorization, connections)
  const model = createCommunityModelGateway({ authorization: modelAuthorization, connections, usage, upstream: new SharedCommunityModelUpstream(modelStore) })
  const webTools = createCommunityWebToolsGateway({
    authorization: modelAuthorization,
    connections,
    usage,
    upstream: communityWebToolsUpstream(modelStore, testOnlyWebToolsBaseUrl),
  })
  const networkAccess = new CommunityNetworkAccess(modelAuthorization, new NodeNetworkResolver(config.listen.publicOrigin, config.network?.hostPublicAddresses))
  const network = createCommunityNetworkProxy({ access: networkAccess, transport: new NodeNetworkTransport(), connections })
  const proxyAgent = new Agent({ keepAlive: true })
  ownAgent(proxyAgent)
  const proxy = createProxyServer({ ws: true, agent: proxyAgent })
  ownProxy(proxy)
  proxy.on('error', handleProxyError)
  proxy.on('proxyRes', closeIncompleteProxyResponse)
  const session = createEntrySessionGate(sessions, accounts)
  const authenticate = session.authenticate
  const preview = new ServicePreview(
    accounts,
    runtime,
    clock,
    [config.listen.port, config.runtime.container?.internalPort ?? 4180, config.runtime.container?.gatewayPort ?? 3081, config.preview?.port ?? 0],
    new RandomPreviewCapabilities(),
  )
  const previewSession = async (request: IncomingMessage) => ((await authenticate(request)) ? previewIdentity(request, sessions) : undefined)
  const rememberCookie = (username: string, header: string | undefined) => rememberRuntimeCookie(connections, username, header)
  const assets = new AdminAssetServer(
    new FileAdminAssetSource(config.adminUiRoot ?? fileURLToPath(new URL('../../admin-ui/dist', import.meta.url)), 'community.html'),
  )
  const origin = () => lifecycle().origin()
  proxy.on('proxyRes', secureCommunityProxyCookies(origin))
  const databaseOnboarding = new CommunityDatabaseOnboarding(
    credential,
    databaseBootstrap,
    () => lifecycle().activateRecords(),
    () => lifecycle().fail(),
  )
  const routes = communityAccountRoutes({ onboarding, databaseOnboarding, entry, sessions, origin, recordsReady: () => lifecycle().recordsReady() })
  const recovery = createCommunityMemberRoute({ entry, environment })
  const admin = createCommunityAdminRoute({
    authenticate,
    onboarding,
    administration,
    runtime,
    assets,
    origin,
    instanceResources,
    systemStatus: new CommunitySystemStatus(accounts, new PostgresSystemStatus(database, () => databaseBootstrap.selection())),
    usage,
    experts,
    contributions,
    market,
    runtimeDependencies,
    suites,
    downloads,
    mcp,
    mcpTest,
    mcpImports,
    execution: executionAdministration,
    executionOperations,
    access: accessAdministration,
    upstreams,
    upstreamTest,
    models: modelAdministration,
    plugins,
    skills,
    skillPacks,
    managed: managedAdministration,
    environment,
    updates: new CommunitySystemUpdate(accounts, options.systemUpdate ?? new UnixCommunitySystemUpdate()),
  })
  const runtimeMount = entry.spacePath.bind(entry)
  const runtimeStatus = entry.status.bind(entry)
  const currentRuntime = entry.currentInstance.bind(entry)
  const dispatch = createHttpEntry({
    onLogout: request => {
      const identity = previewIdentity(request, sessions)
      if (identity) preview.revoke(identity)
    },
    maintenance,
    origin,
    recordsReady: () => lifecycle().recordsReady(),
    connections,
    usageReports,
    contributions: contributionGateway,
    model,
    webTools,
    mcp: mcpGateway,
    execution: executionGateway,
    pluginUpstreams,
    processGateways: config.runtime.container === undefined,
    bootstrap: routes.bootstrap,
    admin,
    enter: routes.enter,
    market: createPluginMarketRoute({ experts, contributions, mcp, market, skills, skillPacks, entry }),
    loginForm: routes.loginForm,
    login: routes.login,
    recovery,
    session,
    runtimeMount,
    ...(runtime.check ? { checkRuntime: runtime.check.bind(runtime) } : {}),
    runtimeStatus,
    currentRuntime,
    startRuntime: entry.start.bind(entry),
    navigateRuntime: entry.navigate.bind(entry),
    rememberRuntimeCookie: rememberCookie,
    proxy,
  })

  const listeners = {
    sweepPreview: preview.sweep.bind(preview),
    ...(config.preview
      ? {
          createPreviewListener: createServicePreviewGateway({
            access: preview,
            transport: new ContainerServicePreviewTransport(config.runtime.container!.runtime),
            identity: previewSession,
            platformOrigin: origin,
            previewOrigin: () => new URL(config.preview!.publicOrigin),
            available: () => lifecycle().recordsReady() && !maintenance.closed(),
            connections,
          }),
        }
      : {}),
    createGatewayListener: () =>
      createGatewayOnlyServer({
        usageReports,
        contributions: contributionGateway,
        maintenance,
        connections,
        model,
        webTools,
        network,
        pluginDownloads,
        pluginUpstreams,
        mcp: mcpGateway,
        execution: executionGateway,
      }),
    createListener: () =>
      createPublicServer({
        connections,
        handle: protectCommunityEntry(
          servicePreviewEntry({
            connections,
            dispatch,
            access: preview,
            identity: previewSession,
            origin,
            previewOrigin: config.preview ? new URL(config.preview.publicOrigin).origin : undefined,
            available: () => lifecycle().recordsReady() && !maintenance.closed(),
          }),
          origin,
        ),
        upgrade: {
          maintenance,
          origin,
          recordsReady: lifecycle().recordsReady.bind(lifecycle()),
          session,
          runtimeMount,
          ...(runtime.check ? { checkRuntime: runtime.check.bind(runtime) } : {}),
          runtimeStatus,
          currentRuntime,
          rememberCookie,
          connections,
          proxy,
        },
      }),
  }
  return { mcpImports, memberMcpProbe, mcpProbe, proxyAgent, proxy, preview, origin, databaseOnboarding, listeners }
}
