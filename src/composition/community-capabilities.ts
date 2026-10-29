import { join } from 'node:path'
import { FileCommunityUserSpaces } from '../adapters/community-user-spaces.js'
import { RuntimeContributionCommands } from '../adapters/contribution-command-inventory.js'
import { FileExecutionArtifacts } from '../adapters/execution-artifacts.js'
import { ExecutionMaintenance } from '../adapters/execution-control-store.js'
import { FileExecutionInspection } from '../adapters/execution-inspection.js'
import { FileExecutionProjection } from '../adapters/execution-projection.js'
import { ContainerExecutionRunner } from '../adapters/execution-runner.js'
import { FileMcpProjection } from '../adapters/mcp-projection.js'
import { FileMemberSkillNames } from '../adapters/member-skill-names.js'
import { PlatformDatabase } from '../adapters/platform-database.js'
import { PostgresCommunityAccountStore } from '../adapters/postgres-community-accounts.js'
import { PostgresDownloadSources } from '../adapters/postgres-download-sources.js'
import type { PostgresPluginLibraryStore } from '../adapters/postgres-plugin-library.js'
import { PostgresSharedModelStore } from '../adapters/postgres-shared-model-store.js'
import { PostgresUsageRecords } from '../adapters/postgres-usage-records.js'
import { RuntimeDependencyPreparer } from '../adapters/runtime-dependency-preparer.js'
import { FileRuntimeDependencyProjection } from '../adapters/runtime-dependency-projection.js'
import { runtimeSkillNames } from '../adapters/runtime-skills.js'
import { FileSkillDistribution } from '../adapters/skill-distribution.js'
import { systemClock } from '../adapters/system-clock.js'
import { type CommunityConfig } from '../domain/community-config.js'
import { memberSkillsMount } from '../dsh/member-skills.js'
import type { Clock } from '../ports/clock.js'
import type { CommunityRuntimePort } from '../ports/community-runtime.js'
import type { MemberRuntimeDependenciesPort } from '../ports/member-runtime-dependencies.js'
import { DownloadSources } from '../use-cases/download-sources.js'
import { ExecutionAdministration } from '../use-cases/execution-administration.js'
import { ExecutionDependencies } from '../use-cases/execution-dependencies.js'
import { ExecutionOperations } from '../use-cases/execution-operations.js'
import { McpRuntimeDependencies } from '../use-cases/mcp-runtime-dependencies.js'
import { McpServices } from '../use-cases/mcp-services.js'
import { McpSharedRuntime } from '../use-cases/mcp-shared-runtime.js'
import { MemberEffectiveSkills } from '../use-cases/member-effective-skills.js'
import type { MemberPluginAccess } from '../use-cases/member-plugin-access.js'
import { MemberRuntimeDependencies } from '../use-cases/member-runtime-dependencies.js'
import { PlatformExecution } from '../use-cases/platform-execution.js'
import { RuntimeDependencies } from '../use-cases/runtime-dependencies.js'
import { SkillExecutionOwners } from '../use-cases/skill-execution-owners.js'
import { SkillLibrary } from '../use-cases/skill-library.js'
import { SkillMembership } from '../use-cases/skill-membership.js'
import { SkillPacks } from '../use-cases/skill-packs.js'
import { UsagePolicy } from '../use-cases/usage-policy.js'
import { createExecutionRuntime } from './execution-runtime.js'
import { createExpertLibrary } from './expert-library.js'
import { createMcpStorage } from './mcp-storage.js'
import { createRuntimeStorage } from './runtime-storage.js'
import { createSkillArtifacts, createSkillStorage } from './skill-storage.js'

import type { CommunityApplicationOptions } from './community-application-options.js'

/** Owns current skill, expert, MCP and delegated-execution capability wiring. */
export function createCommunityCapabilities(input: {
  database: PlatformDatabase
  config: CommunityConfig
  options: CommunityApplicationOptions
  accounts: PostgresCommunityAccountStore
  userSpaces: FileCommunityUserSpaces
  usageStore: PostgresUsageRecords
  modelStore: PostgresSharedModelStore
  mcpStore: ReturnType<typeof createMcpStorage>
  clock: Clock
  runtime: () => CommunityRuntimePort
  pluginStore: () => PostgresPluginLibraryStore
  memberPluginAccess: () => MemberPluginAccess
  recordsReady: () => boolean
}) {
  const { database, config, options, accounts, userSpaces, usageStore, modelStore, mcpStore, clock, runtime, pluginStore, memberPluginAccess, recordsReady } =
    input
  const dataRoot = config.runtime.dataRoot
  const skillRoot = join(dataRoot, 'skills'),
    bundledSkillNames = runtimeSkillNames()
  const skillStorage = createSkillStorage(database)
  const { library: skillStore, grants: skillGrants, selections: skillSelections, packs: packState } = skillStorage
  const artifacts = createSkillArtifacts(skillRoot, bundledSkillNames)
  const downloadSourceStore = new PostgresDownloadSources(database, config.downloadSources ?? { preset: 'official' })
  const downloads: DownloadSources = new DownloadSources(accounts, downloadSourceStore)
  const { experts, storage: expertStorage } = createExpertLibrary(database, {
    accounts,
    skills: skillStore,
    packs: packState.store,
    changed: () => mcp.recover(),
    globalSkills: async username => (await effectiveSkills.effective(username)).map(row => row.skill.name),
    status: username => runtime().status(username),
    plugins: () => pluginStore().list(),
    mcp: mcpStore,
    models: modelStore,
  })
  const effectiveSkills = new MemberEffectiveSkills(
    accounts,
    skillStore.view,
    skillGrants.view,
    skillSelections.view,
    { store: packState.store.view, grants: packState.grants.view, selections: packState.selections.view },
    experts,
  )
  const usage: UsagePolicy = new UsagePolicy(usageStore, clock, accounts, options.testOnlyUsageDecision, new ExecutionMaintenance(), effectiveSkills)
  const memberDependencies = new MemberRuntimeDependencies(
    accounts,
    effectiveSkills,
    { ready: names => runtimeDependencies.ready(names) },
    { status: username => runtime().status(username) },
    recordsReady,
    async username => await mcp.memberDependencies(username),
    async (username, installed) => await memberPluginAccess().dependencyNames(username, installed),
  )
  const dependencyProjection = new FileRuntimeDependencyProjection(
    join(skillRoot, 'members'),
    memberDependencies.versions.bind(memberDependencies),
    memberDependencies.inUse.bind(memberDependencies),
    config.runtime.container ? memberSkillsMount : undefined,
    memberDependencies.maySynchronize.bind(memberDependencies),
  )
  const memberDependencyPreparation: MemberRuntimeDependenciesPort = {
    plan: memberDependencies.plan.bind(memberDependencies),
    prepare: (spaceId, plan, prepareMember) =>
      runtimeDependencies.withVersions(plan.versions, async () => {
        await prepareMember?.()
        await dependencyProjection.prepare(spaceId, plan.versions)
      }),
  }
  const runtimeStorage = createRuntimeStorage(database),
    executionStore = runtimeStorage.execution
  const executionOwners = new SkillExecutionOwners(skillStore.view, effectiveSkills, accounts, executionStore)
  const projection = new FileExecutionProjection(
    join(skillRoot, 'members'),
    config.runtime.container ? memberSkillsMount : undefined,
    executionOwners.commands.bind(executionOwners),
  )
  const expertSkillProjection: Pick<FileExecutionProjection, 'apply' | 'identity'> = projection
  const {
    control: executionControl,
    process: executionProcess,
    shared: sharedProcess,
  } = createExecutionRuntime(config.runtime, database, options.executionDeadlines)
  const contributionCommands: RuntimeContributionCommands = new RuntimeContributionCommands(executionProcess)
  const runtimeDependencies: RuntimeDependencies = new RuntimeDependencies(
    accounts,
    runtimeStorage.store,
    new RuntimeDependencyPreparer(executionProcess, new FileExecutionArtifacts(join(dataRoot, 'runtime-dependencies', '.trees')), downloads),
    clock,
    {
      list: runtimeStorage.references.list.bind(runtimeStorage.references),
      retained: async () => [...(await dependencyProjection.retained()), ...sharedProcess.retainedArtifacts()],
    },
    () => mcp.recover(),
  )
  const sharedMcp: McpSharedRuntime = new McpSharedRuntime(
    sharedProcess,
    executionControl,
    clock,
    new ExecutionMaintenance(5000),
    async (...args) => await mcp.runtimeService(...args),
  )
  const mcpPreparation: McpRuntimeDependencies = new McpRuntimeDependencies(mcpStore, runtimeDependencies, {
    running: sharedMcp,
    isolated: () => sharedProcess.isolated,
  })
  const mcp: McpServices = new McpServices(
    accounts,
    mcpStore,
    new FileMcpProjection(config.runtime),
    mcpPreparation,
    options.mcpPresets,
    () => skills.recover(),
    experts,
  )
  const executionPreparation = new ExecutionDependencies(executionOwners, executionStore, runtimeDependencies)
  const executionRunner = new ContainerExecutionRunner(config.runtime, userSpaces, artifacts, executionProcess)
  const executionInspection = new FileExecutionInspection(artifacts)
  const execution: PlatformExecution = new PlatformExecution(
    executionOwners,
    executionStore,
    executionRunner,
    executionPreparation,
    executionInspection,
    executionControl,
    usage,
  )
  const executionOperations: ExecutionOperations = new ExecutionOperations(
    accounts,
    executionControl,
    execution,
    userSpaces,
    config.runtime.container !== undefined,
    () => executionProcess.isolated,
  )
  const executionAdministration: ExecutionAdministration = new ExecutionAdministration(
    accounts,
    executionOwners,
    executionStore,
    async () => {
      await skills.recover()
    },
    executionPreparation,
    executionInspection,
    runtimeDependencies,
    runtimeStorage.work,
  )
  const skills: SkillLibrary = new SkillLibrary(
    accounts,
    skillStore,
    artifacts,
    systemClock,
    new SkillMembership(
      accounts,
      skillStore,
      skillGrants,
      skillSelections,
      effectiveSkills,
      new FileSkillDistribution(join(skillRoot, 'members'), artifacts, [projection, dependencyProjection]),
      () => executionPreparation.changed(),
      packState,
      operation => skills.transaction(operation),
    ),
    new FileMemberSkillNames(config.runtime, accounts),
    bundledSkillNames,
    packState,
    skillStorage.work,
    runtimeDependencies,
    executionPreparation,
    expertStorage.references,
  )
  const skillPacks: SkillPacks = new SkillPacks(
    accounts,
    skillStore,
    packState,
    skillGrants,
    skills,
    artifacts,
    systemClock,
    bundledSkillNames,
    skillSelections,
    expertStorage.references,
  )

  return {
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
  }
}
