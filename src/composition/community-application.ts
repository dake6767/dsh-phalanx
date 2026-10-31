import { Agent } from 'node:http'
import { join } from 'node:path'
import { BootstrapDatabase } from '../adapters/bootstrap-database.js'
import { CommunityBootstrapCredential, assertCommunityDataRoot } from '../adapters/community-bootstrap.js'
import { FileCommunityMaintenance } from '../adapters/community-maintenance.js'
import { CommunityRuntimeDriver } from '../adapters/community-runtime-driver.js'
import { FileCommunityUserSpaces } from '../adapters/community-user-spaces.js'
import { ContributionMaintenance } from '../adapters/contribution-maintenance.js'
import { FileContributionPluginFiles } from '../adapters/contribution-plugin-files.js'
import { FileContributionArtifacts } from '../adapters/contribution-storage.js'
import { HttpDshSession } from '../adapters/dsh-session.js'
import { NodeInstanceResourceHost } from '../adapters/instance-resource-cgroup.js'
import { MemorySessionRegistry } from '../adapters/memory-session-registry.js'
import { FilePlatformDatabaseConfig } from '../adapters/platform-database-config.js'
import { prepareDatabaseSwitchRecovery } from '../adapters/platform-database-switch-recovery.js'
import { PlatformDatabase } from '../adapters/platform-database.js'
import { finishPlatformKeyRecovery, preparePlatformKeyRecovery } from '../adapters/platform-key-recovery.js'
import { PlatformLock } from '../adapters/platform-lock.js'
import { YamlPluginAccessSyntax } from '../adapters/plugin-access-syntax.js'
import { FilePluginContributionPreparation } from '../adapters/plugin-contribution-preparation.js'
import { PostgresCommunityAccountStore } from '../adapters/postgres-community-accounts.js'
import { PostgresCommunityModelAccess } from '../adapters/postgres-community-model-access.js'
import { PostgresSessionKey } from '../adapters/postgres-session-key.js'
import { PostgresSharedModelStore } from '../adapters/postgres-shared-model-store.js'
import { PostgresUsageRecords } from '../adapters/postgres-usage-records.js'
import { declaredPlatformVersion, pluginCompatibilityTarget } from '../adapters/runtime-revision.js'
import { runtimeSkillNames } from '../adapters/runtime-skills.js'
import { FileSharedModelProjection } from '../adapters/shared-model-projection.js'
import { systemClock } from '../adapters/system-clock.js'
import { validateCommunityNetworkAddresses, type CommunityConfig } from '../domain/community-config.js'
import { validateConfig } from '../domain/config-validation.js'
import { MODEL_GATEWAY_BASE_PATH } from '../dsh/model-protocol.js'
import { PlatformSessionCodec } from '../inbound/platform-session.js'
import type { CommunityApplication } from '../ports/community-application.js'
import type { CommunityRuntimePort } from '../ports/community-runtime.js'
import { CommunityAccountAdministration } from '../use-cases/community-account-administration.js'
import { CommunityEntry } from '../use-cases/community-entry.js'
import { CommunityInstanceActions } from '../use-cases/community-instance-actions.js'
import { CommunityInstanceLifecycle } from '../use-cases/community-instance-lifecycle.js'
import { CommunityOnboarding } from '../use-cases/community-onboarding.js'
import { ContributionPolicy } from '../use-cases/contribution-policy.js'
import { createIdleReclamation } from '../use-cases/idle-reclamation.js'
import { InstanceResources } from '../use-cases/instance-resources.js'
import { MemberContributions } from '../use-cases/member-contributions.js'
import { PluginContributionAdministration } from '../use-cases/plugin-contribution-administration.js'
import { PluginContributionDistribution } from '../use-cases/plugin-contribution-distribution.js'
import { PluginContributions } from '../use-cases/plugin-contributions.js'
import { ResidentInstances } from '../use-cases/resident-instances.js'
import { SharedModelAdministration } from '../use-cases/shared-model-administration.js'
import { createCommunityCapabilities } from './community-capabilities.js'
import { CommunityConstructionError } from './community-construction.js'
import { createCommunityEntryHandlers } from './community-entry-handlers.js'
import { CommunityLifecycle } from './community-lifecycle.js'
import { createCommunityPluginMembers, createCommunityPlugins } from './community-plugins.js'
import { createSpaceStorage } from './community-space-storage.js'
import { createContributionStorage } from './contribution-storage.js'
import { createMcpStorage } from './mcp-storage.js'
import { createSuiteApplication } from './suite-application.js'

import { FileCommunityEnvironment } from '../adapters/community-environment.js'
import { CommunityEnvironmentRecovery } from '../use-cases/community-environment-recovery.js'
import type { CommunityApplicationOptions } from './community-application-options.js'

export type { CommunityApplicationOptions } from './community-application-options.js'

/** Wires the community product entry, accounts, private instances and model defaults. */
export function createCommunityApplication(config: CommunityConfig, options: CommunityApplicationOptions = {}): CommunityApplication {
  const dataRoot = config.runtime.dataRoot
  const testOnlyWebToolsBaseUrl = options.testOnlyWebToolsUpstreamBaseUrl
  const clock = options.clock ?? systemClock
  validateConfig(config)
  validateCommunityNetworkAddresses(config)
  const maintenance = new FileCommunityMaintenance(config.maintenanceFile)
  const canDiscardArtifacts = () => !maintenance.closed()
  assertCommunityDataRoot(dataRoot)
  const lock = new PlatformLock(dataRoot)
  let cleanupDatabase: PlatformDatabase | undefined
  let cleanupAgent: Agent | undefined
  let cleanupProxy: { close(): void } | undefined
  try {
    prepareDatabaseSwitchRecovery(config.platformDatabaseConfigFile ?? '/etc/dsh-phalanx/database.json', dataRoot)
    preparePlatformKeyRecovery(config.platformDatabaseConfigFile ?? '/etc/dsh-phalanx/database.json', dataRoot)
    const savedDatabase: ReturnType<typeof FilePlatformDatabaseConfig.open> = FilePlatformDatabaseConfig.open(
      config.platformDatabaseConfigFile ?? '/etc/dsh-phalanx/database.json',
      dataRoot,
    )
    const database: PlatformDatabase = new PlatformDatabase(savedDatabase.connection, savedDatabase.security)
    cleanupDatabase = database
    const usageStore: PostgresUsageRecords = new PostgresUsageRecords(database)
    const accounts: PostgresCommunityAccountStore = new PostgresCommunityAccountStore(database)
    const databaseBootstrap = new BootstrapDatabase(config.platformDatabaseConfigFile ?? '/etc/dsh-phalanx/database.json', dataRoot, database)
    const sessionKey = new PostgresSessionKey(database)
    const sessions = new PlatformSessionCodec(sessionKey)
    const spaceStorage = createSpaceStorage(database, config.runtime, config.idleReclaimSeconds ?? 1800, () => !maintenance.closed())
    const mcpStore = createMcpStorage(database)
    const modelStore: PostgresSharedModelStore = new PostgresSharedModelStore(database, new FileSharedModelProjection(dataRoot, config.runtime))
    const modelAccess: PostgresCommunityModelAccess = new PostgresCommunityModelAccess(database)
    const userSpaces: FileCommunityUserSpaces = new FileCommunityUserSpaces(config.runtime, accounts, spaceStorage.guard)
    const {
      skillStorage,
      skillStore,
      artifacts,
      downloadSourceStore,
      downloads,
      experts,
      expertStorage,
      usage,
      memberDependencyPreparation,
      runtimeStorage,
      expertSkillProjection,
      contributionCommands,
      runtimeDependencies,
      sharedMcp,
      mcpPreparation,
      mcp,
      executionPreparation,
      executionRunner,
      execution,
      executionOperations,
      executionAdministration,
      skills,
      skillPacks,
    } = createCommunityCapabilities({
      database,
      config,
      options,
      accounts,
      userSpaces,
      usageStore,
      modelStore,
      mcpStore,
      clock,
      runtime: () => runtime,
      pluginStore: () => pluginStore,
      memberPluginAccess: () => memberPluginAccess,
      recordsReady: () => lifecycle.recordsReady(),
      canDiscardArtifacts,
    })
    const pluginLibrary = createCommunityPlugins({
      database,
      config,
      options,
      accounts,
      downloads,
      runtimeDependencies,
      experts,
      expertStorage,
      canDiscardArtifacts,
    })
    const {
      pluginStore,
      accessStore,
      upstreamStore,
      pluginGrants,
      localCopies,
      managedPlugins,
      compatibility,
      plugins,
      accessAdministration,
      memberPluginAccess,
      preinstallPolicy,
    } = pluginLibrary
    const contributionPolicy: ContributionPolicy = new ContributionPolicy(
      skillStore,
      pluginStore,
      artifacts,
      new FileContributionPluginFiles(join(dataRoot, 'plugins')),
    )
    const credential = new CommunityBootstrapCredential(dataRoot, databaseBootstrap.complete.bind(databaseBootstrap))
    const catalogAddress = options.suiteCatalog?.address ?? config.suiteCatalog?.address
    const suites = createSuiteApplication({
      database,
      accounts,
      downloads,
      clock,
      platformVersion: declaredPlatformVersion(),
      compatibilityTarget: pluginCompatibilityTarget(),
      architecture: process.arch === 'x64' ? 'amd64' : 'arm64',
      catalog: {
        ...(catalogAddress !== undefined ? { address: catalogAddress } : {}),
        ...(options.suiteCatalog?.trustedKeys ? { trustedKeys: options.suiteCatalog.trustedKeys } : {}),
      },
      dependencies: runtimeDependencies,
      skills,
      packs: skillPacks,
      execution: executionAdministration,
      plugins,
      access: accessAdministration,
      changed: () => executionPreparation.changed(),
    })
    const environmentStorage = options.environment ?? new FileCommunityEnvironment(userSpaces.root, userSpaces, clock)
    const memberGatewayAccess = async (userId: string) => ({
      url: `${lifecycle.gatewayOrigin().origin}${MODEL_GATEWAY_BASE_PATH}`,
      token: await modelAccess.forUser(userId, (await accounts.getState(userId))!.spaceId),
    })
    const runtime: CommunityRuntimePort =
      options.runtime ??
      new CommunityInstanceLifecycle(
        new CommunityRuntimeDriver(
          config.runtime,
          userSpaces,
          managedPlugins,
          memberPluginAccess,
          skills,
          mcp,
          experts,
          expertSkillProjection,
          { forSpace: spaceId => instanceResources.forSpace(spaceId) },
          preinstallPolicy,
          memberDependencyPreparation,
          spaceStorage.hostnames,
          canDiscardArtifacts,
        ),
        memberGatewayAccess,
        async (userId, instance, origin) => {
          await residentInstances.ready(userId)
          preinstallDelivery.ready(instance, new URL(origin))
        },
      )
    const dshSession = new HttpDshSession()
    const onboarding = new CommunityOnboarding(accounts, credential)
    const connections = new MemorySessionRegistry()
    const residentInstances = new ResidentInstances(
      accounts,
      spaceStorage.resources.rows,
      runtime,
      clock,
      () => lifecycle.origin(),
      () => !maintenance.closed(),
    )
    const instanceResources: InstanceResources = new InstanceResources(
      accounts,
      spaceStorage.resources,
      new NodeInstanceResourceHost(),
      runtime,
      connections,
      config.runtime.container !== undefined,
      residentInstances,
    )
    const actions = new CommunityInstanceActions(accounts, runtime, connections)
    const entry = new CommunityEntry(accounts, runtime, dshSession, userSpaces, actions)
    const administration = new CommunityAccountAdministration(accounts, runtime, connections, pluginGrants, async () => {
      await entry.reconcile()
      await instanceResources.reconcileMembers()
      await experts.recover()
      await skills.recover()
      await mcp.recover()
      await contributions.recover()
    })
    const modelAdministration = new SharedModelAdministration(accounts, modelStore)
    const { nativeDownloads, nativeJobs, preinstallDelivery, managedAdministration, market, upstreams, upstreamTransport, upstreamTest } =
      createCommunityPluginMembers({ pluginLibrary, config, options, accounts, runtime, actions, sessionKey, clock, downloads })
    const environment = new CommunityEnvironmentRecovery(accounts, runtime, environmentStorage, connections, spaceStorage.resets, clock, preinstallDelivery)
    const contributionStorage = createContributionStorage(database)
    const contributions = new MemberContributions(
      accounts,
      contributionStorage,
      new FileContributionArtifacts(join(dataRoot, 'contributions', 'artifacts'), runtimeSkillNames(), contributionCommands, canDiscardArtifacts),
      skills,
      systemClock,
      new ContributionMaintenance(),
      executionAdministration,
      new PluginContributions(
        new FilePluginContributionPreparation(config.runtime, downloads, canDiscardArtifacts),
        plugins,
        new PluginContributionAdministration(
          accessAdministration,
          upstreams,
          new YamlPluginAccessSyntax(),
          new PluginContributionDistribution(pluginStore, managedAdministration, market),
          upstreamTest,
        ),
      ),
      contributionPolicy,
      kind => (kind === 'skill' ? executionPreparation.changed() : Promise.resolve()),
    )
    const { mcpImports, memberMcpProbe, mcpProbe, proxyAgent, proxy, preview, origin, databaseOnboarding, listeners } = createCommunityEntryHandlers({
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
      lifecycle: () => lifecycle,
      ownAgent: agent => {
        cleanupAgent = agent
      },
      ownProxy: proxy => {
        cleanupProxy = proxy
      },
    })
    const idle = createIdleReclamation({
      idleSeconds: async () => (await spaceStorage.resources.rows.read()).idleSeconds,
      resident: residentInstances.resident.bind(residentInstances),
      afterHealthCheck: residentInstances.scan.bind(residentInstances),
      clock,
      sessions: connections,
      runtime,
      dsh: dshSession,
      users: async () => [...(await onboarding.activeUsernames())],
      recordsReady: () => lifecycle.recordsReady(),
      gateClosed: entry.accessClosed.bind(entry),
      origin,
      previewActivity: preview.lastActivity.bind(preview),
      onReclaimed: connections.clearIdle.bind(connections),
      onError: () => {
        console.warn('Idle user-space check failed; retained the instance')
      },
    })
    const lifecycle: CommunityLifecycle = new CommunityLifecycle({
      ...(options.publicEntry
        ? {
            publicEntry: options.publicEntry,
            registerPublicConnection: socket => {
              connections.registerConnection(socket, true)
            },
          }
        : {}),
      prepareEntry: async () => {
        await finishPlatformKeyRecovery(config.platformDatabaseConfigFile ?? '/etc/dsh-phalanx/database.json', dataRoot)
        if (await databaseBootstrap.prepare()) return true
        await credential.prepare()
        return false
      },
      config,
      knownUsers: onboarding.activeUsernames.bind(onboarding),
      runtime,
      connections,
      startBackgroundWork: async () => {
        await usage.start()
        await runtimeDependencies.start()
        contributions.start()
        mcpPreparation.start()
        await residentInstances.scan()
      },
      prepareBootstrap: async () => {
        await databaseBootstrap.claim(() => lifecycle.fail())
        await database.initialize()
        await spaceStorage.initialize()
        await skillStore.initialize()
        await sessionKey.initialize()
        await modelStore.initialize()
        await modelAccess.initialize()
        await upstreamStore.initialize()
        await runtimeStorage.initialize()
        await expertStorage.initialize()
        await mcpStore.initialize()
        await accessStore.initialize()
        await downloadSourceStore.initialize()
        assertCommunityDataRoot(dataRoot, await accounts.bootstrapComplete())
        await executionRunner.recover()
        await mcpPreparation.recover()
        await runtimeDependencies.recover()
        await suites.recover()
        await executionPreparation.recover()
        await credential.prepare()
        await experts.recover()
        await skills.recover()
        await mcp.interruptCatalogTests()
        await plugins.recover()
        await compatibility.recover()
        await contributions.recover()
        await managedPlugins.recover()
      },
      checkIdle: idle.check,
      checkIntervalMs: idle.intervalMs,
      closeResources: async () => {
        try {
          await databaseOnboarding.close()
          await residentInstances.drain()
          await instanceResources.stop()
          await contributions.stop()
          const stopped = await Promise.allSettled([
            preinstallDelivery.stop(),
            nativeJobs.stop(),
            runtimeDependencies.stop(),
            mcpImports.stop(),
            mcpPreparation.stop(),
            memberMcpProbe.stop(),
            mcpProbe.stop(),
            mcp.stop(),
            suites.stop(),
            executionPreparation.stop(),
            executionRunner.stop(),
            compatibility.stop(),
            plugins.stop(),
            skills.stop(),
          ])
          await mcpImports.drain()
          const failures = stopped.flatMap(result => (result.status === 'rejected' ? [result.reason] : []))
          if (failures.length) throw new AggregateError(failures, 'Community library shutdown failed')
        } finally {
          entry.close()
          preview.close()
          proxy.close()
          proxyAgent.destroy()
          try {
            await usage.stop()
          } finally {
            try {
              await Promise.allSettled([
                skillStorage.close(),
                expertStorage.close(),
                modelStore.close(),
                modelAccess.close(),
                sessionKey.close(),
                upstreamStore.close(),
                runtimeStorage.close(),
                mcpStore.close(),
                accessStore.close(),
                downloadSourceStore.close(),
              ])
              await database.close()
            } finally {
              lock.close()
            }
          }
        }
      },
      ...listeners,
    })
    return lifecycle
  } catch (error) {
    cleanupProxy?.close()
    cleanupAgent?.destroy()
    const cleanup = (cleanupDatabase?.close() ?? Promise.resolve()).finally(() => {
      lock.close()
    })
    void cleanup.catch(() => {})
    throw new CommunityConstructionError(error, cleanup)
  }
}
