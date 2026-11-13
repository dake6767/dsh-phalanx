import { MemberNativeServiceSettings } from '../use-cases/member-native-service-settings.js'
import type { NativePluginInstallTransport, NativeServiceSettingsTransport } from '../ports/member-native-plugins.js'
import { NativePluginServiceAccess } from '../use-cases/native-plugin-service-access.js'
import { CatalogPluginArchives } from '../adapters/catalog-plugin-archives.js'
import { HttpNpmPluginSource } from '../adapters/npm-plugin-source.js'
import { GithubPluginArchives } from '../adapters/github-plugin-archives.js'
import { HttpGithubPluginSource } from '../adapters/github-plugin-source.js'
import { ContainerPluginSourcePacker } from '../adapters/plugin-source-packer.js'
import { pluginIntakeToken } from '../adapters/plugin-intake-token.js'
import { PluginIntake } from '../use-cases/plugin-intake.js'
import { MemberNativePackageCache } from '../adapters/member-native-package-cache.js'
import { NativeMemberPluginManager } from '../adapters/member-plugin-manager.js'
import { PlatformDatabase } from '../adapters/platform-database.js'
import { YamlPluginAccessSyntax } from '../adapters/plugin-access-syntax.js'
import { ContainerPluginArchiveInspector } from '../adapters/plugin-archive-inspector.js'
import { SignedPluginDownloadTokens } from '../adapters/plugin-download-tokens.js'
import { ContainerPluginPreparer } from '../adapters/plugin-preparer.js'
import { FilePluginUpload } from '../adapters/plugin-upload.js'
import { NodePluginUpstreamTransport } from '../adapters/plugin-upstream-transport.js'
import { PostgresCommunityAccountStore } from '../adapters/postgres-community-accounts.js'
import { PostgresExpertReferences } from '../adapters/postgres-expert-references.js'
import { PostgresPluginAccessStore } from '../adapters/postgres-plugin-access-store.js'
import { PostgresPluginGrants } from '../adapters/postgres-plugin-grants.js'
import { PostgresPluginInstallations } from '../adapters/postgres-plugin-installations.js'
import { PostgresPluginLibraryStore } from '../adapters/postgres-plugin-library.js'
import { PostgresPluginSelections } from '../adapters/postgres-plugin-selections.js'
import { PostgresPluginUpstreams } from '../adapters/postgres-plugin-upstreams.js'
import { PostgresSessionKey } from '../adapters/postgres-session-key.js'
import { PostgresUnitOfWork } from '../adapters/postgres-unit-of-work.js'
import { declaredRuntimeRevision, pluginCompatibilityTarget } from '../adapters/runtime-revision.js'
import { systemClock } from '../adapters/system-clock.js'
import { type CommunityConfig } from '../domain/community-config.js'
import type { Clock } from '../ports/clock.js'
import type { CommunityRuntimePort } from '../ports/community-runtime.js'
import { CommunityInstanceActions } from '../use-cases/community-instance-actions.js'
import { DownloadSources } from '../use-cases/download-sources.js'
import { GroupPluginPreinstalls } from '../use-cases/group-plugin-preinstalls.js'
import { ManagedPluginAdministration } from '../use-cases/managed-plugin-administration.js'
import { MemberManagedPlugins } from '../use-cases/member-managed-plugins.js'
import { MemberNativePluginJobs } from '../use-cases/member-native-plugin-jobs.js'
import { MemberNativePlugins } from '../use-cases/member-native-plugins.js'
import { MemberPluginAccess } from '../use-cases/member-plugin-access.js'
import { MemberPluginPreinstalls } from '../use-cases/member-plugin-preinstalls.js'
import { NativePluginDownloads } from '../use-cases/native-plugin-downloads.js'
import { PluginAccessAdministration } from '../use-cases/plugin-access-administration.js'
import { PluginCompatibility } from '../use-cases/plugin-compatibility.js'
import { PluginLibraryMembership } from '../use-cases/plugin-library-membership.js'
import { PluginLibrary } from '../use-cases/plugin-library.js'
import { PluginUpdates } from '../use-cases/plugin-updates.js'
import { PluginLocalCopies } from '../use-cases/plugin-local-copies.js'
import { PluginMarket } from '../use-cases/plugin-market.js'
import { PluginUpstreamAdministration } from '../use-cases/plugin-upstream-administration.js'
import { PluginUpstreamTest } from '../use-cases/plugin-upstream-test.js'
import { RuntimeDependencies } from '../use-cases/runtime-dependencies.js'
import { KeyedOperations } from '../use-cases/support/keyed-operations.js'
import { createExpertLibrary } from './expert-library.js'

import type { CommunityApplicationOptions } from './community-application-options.js'

/** Owns plugin library storage, preparation, selection and access policy wiring. */
export function createCommunityPlugins(input: {
  database: PlatformDatabase
  config: CommunityConfig
  options: CommunityApplicationOptions
  accounts: PostgresCommunityAccountStore
  downloads: DownloadSources
  runtimeDependencies: RuntimeDependencies
  experts: ReturnType<typeof createExpertLibrary>['experts']
  expertStorage: ReturnType<typeof createExpertLibrary>['storage']
  canDiscardArtifacts: () => boolean
}) {
  const { database, config, options, accounts, downloads, runtimeDependencies, experts, expertStorage, canDiscardArtifacts } = input
  const dataRoot = config.runtime.dataRoot
  const pluginOperations = new KeyedOperations()
  const pluginStore: PostgresPluginLibraryStore = new PostgresPluginLibraryStore(database)
  const accessStore: PostgresPluginAccessStore = new PostgresPluginAccessStore(database)
  const installations: PostgresPluginInstallations = new PostgresPluginInstallations(database)
  const selections: PostgresPluginSelections = new PostgresPluginSelections(database)
  const upstreamStore: PostgresPluginUpstreams = new PostgresPluginUpstreams(database)
  const pluginGrants: PostgresPluginGrants = new PostgresPluginGrants(database)
  const localCopies: PluginLocalCopies = new PluginLocalCopies(
    accounts,
    pluginStore,
    pluginGrants,
    selections,
    new PostgresPluginSelections(database, 'local'),
    declaredRuntimeRevision(),
    experts,
    upstreamStore,
  )
  const managedPlugins: MemberManagedPlugins = new MemberManagedPlugins(
    accounts,
    pluginStore,
    pluginGrants,
    declaredRuntimeRevision(),
    selections,
    localCopies,
    experts,
    upstreamStore,
  )
  const preparer = options.pluginPreparer ?? new ContainerPluginPreparer(config.runtime, false, downloads, canDiscardArtifacts)
  const compatibility: PluginCompatibility = new PluginCompatibility(pluginStore, preparer, pluginCompatibilityTarget())
  const uploads = new FilePluginUpload(dataRoot, options.pluginArchiveInspector ?? new ContainerPluginArchiveInspector(config.runtime), canDiscardArtifacts)
  const plugins: PluginLibrary = new PluginLibrary(
    accounts,
    pluginStore,
    preparer,
    uploads,
    new PluginLibraryMembership(accounts, pluginGrants, selections),
    pluginCompatibilityTarget(),
    { access: accessStore, upstreams: upstreamStore },
    runtimeDependencies,
    pluginOperations,
    new PostgresUnitOfWork(database, {
      library: transaction => new PostgresPluginLibraryStore(transaction),
      expertReferences: transaction => new PostgresExpertReferences(transaction),
    }),
    expertStorage.references,
    new CatalogPluginArchives(new HttpGithubPluginSource(downloads), uploads),
  )
  const npmSource = new HttpNpmPluginSource(downloads)
  const githubArchives = new GithubPluginArchives(
    dataRoot,
    options.githubPluginSource ?? new HttpGithubPluginSource(downloads),
    options.pluginSourcePacker ?? new ContainerPluginSourcePacker(config.runtime),
    uploads,
  )
  const pluginUpdates = new PluginUpdates(plugins, npmSource, githubArchives)
  const pluginIntake = new PluginIntake(
    accounts,
    npmSource,
    preparer,
    plugins.admitInitial.bind(plugins),
    plugins.confirmInitial.bind(plugins),
    options.clock ?? systemClock,
    pluginIntakeToken,
    githubArchives,
  )
  const accessAdministration = new PluginAccessAdministration(accounts, pluginStore, accessStore, upstreamStore, new YamlPluginAccessSyntax())
  const memberPluginAccess = new MemberPluginAccess(
    managedPlugins,
    accessStore,
    { accounts, records: installations },
    { library: pluginStore, ready: names => runtimeDependencies.ready(names), runtimeRevision: declaredRuntimeRevision() },
  )
  const preinstallPolicy = new GroupPluginPreinstalls(
    accounts,
    pluginStore,
    pluginGrants,
    installations,
    declaredRuntimeRevision(),
    accessStore.installedServiceOwner.bind(accessStore),
  )
  return {
    runtimeDependencies,
    nativeServiceRevision: () =>
      JSON.stringify([
        pluginStore.authorizationRevision(),
        database.writeRevision(['dsh_phalanx.plugin_deliveries', 'dsh_phalanx.plugin_access_settings', 'dsh_phalanx.plugin_access_secrets']),
      ]),
    pluginOperations,
    pluginStore,
    accessStore,
    installations,
    selections,
    upstreamStore,
    pluginGrants,
    localCopies,
    managedPlugins,
    compatibility,
    plugins,
    pluginIntake,
    pluginUpdates,
    accessAdministration,
    memberPluginAccess,
    preinstallPolicy,
  }
}

/** Adds member delivery after the runtime owner and instance actions exist. */
export function createCommunityPluginMembers(input: {
  origin: () => URL
  gatewayOrigin: () => URL
  nativeInstallation?: NativePluginInstallTransport & NativeServiceSettingsTransport
  pluginLibrary: ReturnType<typeof createCommunityPlugins>
  config: CommunityConfig
  options: CommunityApplicationOptions
  accounts: PostgresCommunityAccountStore
  runtime: CommunityRuntimePort
  actions: CommunityInstanceActions
  sessionKey: PostgresSessionKey
  clock: Clock
  downloads: DownloadSources
}) {
  const { config, options, accounts, runtime, actions, sessionKey, clock } = input
  const {
    pluginStore,
    installations,
    selections,
    accessStore,
    upstreamStore,
    pluginGrants,
    localCopies,
    managedPlugins,
    accessAdministration,
    memberPluginAccess,
    preinstallPolicy,
    pluginOperations,
  } = input.pluginLibrary
  const { downloads } = input
  const cache = config.runtime.container
    ? new MemberNativePackageCache(config.runtime.container, pluginStore, input.pluginLibrary.runtimeDependencies)
    : undefined
  const native = new NativeMemberPluginManager(config.runtime, input.nativeInstallation, cache)
  const nativeManager = typeof options.pluginManager === 'function' ? options.pluginManager(native) : (options.pluginManager ?? native)
  const nativeDownloads = new NativePluginDownloads(accounts, pluginStore, new SignedPluginDownloadTokens(sessionKey), clock, declaredRuntimeRevision())
  const nativeServices = new NativePluginServiceAccess({
    accounts,
    library: pluginStore,
    grants: pluginGrants,
    installations,
    services: accessStore,
    runtime,
    manager: native,
    origin: input.origin,
    gatewayOrigin: input.gatewayOrigin,
    signingKey: sessionKey,
    revision: input.pluginLibrary.nativeServiceRevision,
    runtimeRevision: declaredRuntimeRevision(),
  })
  const nativeSettings = input.nativeInstallation
    ? new MemberNativeServiceSettings(installations, accessStore, nativeServices, input.nativeInstallation)
    : undefined
  const nativeJobs = new MemberNativePluginJobs(
    accounts,
    runtime,
    new MemberNativePlugins(accounts, nativeDownloads, nativeManager, downloads),
    installations,
    nativeServices,
    nativeSettings,
  )
  const preinstallDelivery = new MemberPluginPreinstalls(preinstallPolicy, nativeJobs, runtime, installations)
  const managedAdministration = new ManagedPluginAdministration(
    accounts,
    pluginStore,
    pluginGrants,
    managedPlugins,
    runtime,
    actions,
    declaredRuntimeRevision(),
    memberPluginAccess,
    upstreamStore,
    preinstallDelivery,
  )
  const market = new PluginMarket(
    accounts,
    pluginStore,
    nativeManager,
    runtime,
    selections,
    managedPlugins,
    declaredRuntimeRevision(),
    memberPluginAccess,
    upstreamStore,
    localCopies,
    nativeJobs,
    pluginOperations,
    nativeSettings,
    preinstallDelivery,
  )
  const upstreams = new PluginUpstreamAdministration(accounts, pluginStore, upstreamStore, accessAdministration)
  const upstreamTransport = new NodePluginUpstreamTransport()
  const upstreamTest = new PluginUpstreamTest(upstreams, upstreamStore, upstreamTransport, systemClock)
  return {
    nativeDownloads,
    nativeJobs,
    nativeServices,
    nativeSettings,
    preinstallDelivery,
    managedAdministration,
    market,
    upstreams,
    upstreamTransport,
    upstreamTest,
  }
}
