import type { APIResponse, Page } from 'playwright'
import { expect } from 'vitest'
import type {
  CommunityAccountsPageData,
  CommunityNativeFeatureGroup,
  CommunityRuntimeDependencyView,
  CommunitySkillView,
  CommunitySkillPackLibrary,
  CommunityUsageRecords,
} from '../../src/domain/admin-contract.js'
import type { UsageModelView } from '../../src/domain/usage-record.js'
import { runCommunityTerminal, signInCommunity } from '../fixtures/community-native-browser.js'
import { refreshAppCenter, setAppCenterVisibility } from './app-center-visibility.js'
import { installedReleaseFixture } from './installed-release-fixture.js'
import { retainedPluginSnapshot, retainedCatalogSnapshot, retainedContributionSnapshot, retainedOfficialCatalog } from './installed-retained-contributions.js'
import { installedMemberHome, installedShellArgument } from './installed-storage-layout.js'
import { assertPausedUpgradeState, type PausedUpgradeState } from './installed-retained-paused.js'
import { retainedExecutionTrial, withAdministratorSkill } from './installed-upgrade-trial.js'
import { installedInstanceAcceptance } from './upgrade-instance-combination.js'

// A different runtime image regenerates artifacts. Preserve the definition and
// usable output, rather than its preparation timestamp, transcript or random ID.
function retainedDependencyState(rows: readonly CommunityRuntimeDependencyView[]) {
  return rows.map(({ updatedAt, log, current, ...definition }) => {
    void updatedAt
    void log
    if (!current) return definition
    const { id, ...artifact } = current
    void id
    return { ...definition, current: artifact }
  })
}

/** Compare retained pack facts and check the current concurrency token at its own boundary. */
export function assertRetainedSkillPacks(before: CommunitySkillPackLibrary, after: CommunitySkillPackLibrary) {
  const { revision, packs } = after
  expect(revision).toMatch(/^[a-f0-9]{64}$/u)
  expect(packs.map(pack => pack.revision)).toEqual(before.packs.map(() => revision))
  expect(after).toEqual({
    ...before,
    revision,
    packs: before.packs.map(pack => ({ ...pack, revision, hasPlatformCredential: false })),
  })
}

/** Retained after assertions shared by formal and optional online transports. */
export async function assertRetainedUpgradeAfter(input: {
  admin: Page
  member: Page
  origin: string
  get: (path: string) => ReturnType<APIResponse['json']>
  post: (path: string, data: object, timeout?: number) => Promise<APIResponse>
  instances: ReturnType<typeof installedInstanceAcceptance>
  executionTrialTimeout: number
  trialEvidence: string | undefined
  redact: (text: string) => string
  remote: (command: string, timeout?: number, acceptedExitCodes?: number[]) => Promise<string>
  candidate: string
  versions: { dsh: { revision: string } }
  release: Awaited<ReturnType<typeof installedReleaseFixture>>
  memberEntry: string
  memberStorageKey: string
  appCenterOptIn: boolean
  deploymentInputs: Parameters<ReturnType<typeof installedInstanceAcceptance>['assertImported']>[0]
  beforeDependencies: readonly CommunityRuntimeDependencyView[]
  beforeSkills: readonly CommunitySkillView[]
  beforeAdministratorSkills: unknown
  groupId: string
  beforeSkillGrants: unknown
  beforePacks: CommunitySkillPackLibrary
  beforePackSelections: unknown
  retainedApi: Parameters<typeof retainedContributionSnapshot>[0]
  retainedCatalog: Awaited<ReturnType<typeof retainedOfficialCatalog>>
  beforeContributions: Awaited<ReturnType<typeof retainedContributionSnapshot>>
  beforePaused: PausedUpgradeState
  expertReplies: Record<string, boolean>
  beforeAccounts: unknown
  beforeLibrary: unknown
  beforeSelection: unknown
  beforeGrants: { implicit?: boolean } & Record<string, unknown>
  history: () => Promise<{ execution: CommunityUsageRecords; mcp: CommunityUsageRecords; models: UsageModelView }>
  beforeUsage: { execution: CommunityUsageRecords; mcp: CommunityUsageRecords; models: UsageModelView }
  beforeLimits: unknown
  beforeUsageSettings: { retentionDays: number }
  call: (marker: string) => Promise<string>
  callPlugin: (marker: string) => Promise<string>
  upstreamState: { exposed: boolean }
}) {
  const {
    admin,
    member,
    origin,
    get,
    post,
    instances,
    executionTrialTimeout,
    trialEvidence,
    redact,
    remote,
    candidate,
    versions,
    release,
    memberEntry,
    memberStorageKey,
    appCenterOptIn,
    deploymentInputs,
    beforeDependencies,
    beforeSkills,
    beforeAdministratorSkills,
    groupId,
    beforeSkillGrants,
    beforePacks,
    beforePackSelections,
    retainedApi,
    retainedCatalog,
    beforeContributions,
    beforePaused,
    expertReplies,
    beforeAccounts,
    beforeLibrary,
    beforeSelection,
    beforeGrants,
    history,
    beforeUsage,
    beforeLimits,
    beforeUsageSettings,
    call,
    callPlugin,
    upstreamState,
  } = input

  const after = JSON.parse(await remote('sudo cat /opt/dsh-phalanx/current/build-info.json'))
  expect(after.commit).toBe(candidate)
  expect(after.versions.dsh.revision).toBe(versions.dsh.revision)
  expect((await remote('sudo cat /opt/dsh-phalanx/current/.artifact-sha256')).trim()).toBe(release.manifest.files['dsh-phalanx-linux-amd64.tar.gz'])
  await admin.context().clearCookies()
  await member.context().clearCookies()
  expect(
    (await admin.request.post(origin + '/login', { headers: { origin }, form: { username: 'admin', password: 'password' }, maxRedirects: 0 })).status(),
  ).toBe(303)
  await signInCommunity(member, origin, 'member', 'password')
  expect(new URL(member.url()).pathname).toBe(memberEntry)
  await refreshAppCenter(member, appCenterOptIn)
  const importedKernel = await instances.assertImported(deploymentInputs)
  await expect
    .poll(async () => retainedDependencyState(await get('runtime-dependencies')), { timeout: 300000 })
    .toEqual(retainedDependencyState(beforeDependencies))
  const dependencies: CommunityRuntimeDependencyView[] = await get('runtime-dependencies')
  const groups: { id: string; kind: string }[] = await get('groups')
  expect(groups.some(group => group.id === groupId)).toBe(true)
  for (const group of groups) {
    const native: CommunityNativeFeatureGroup = await get(`groups/${group.id}/native-features`)
    expect(native.showAppCenter, group.id).toBe(appCenterOptIn && group.id === groupId)
    expect(native.features.map(({ id }) => id).sort()).toEqual([
      'plugin-install',
      'preset-cordis',
      'preset-minimal',
      'preset-ptc',
      'preset-standard',
      'terminal',
    ])
    for (const feature of native.features) {
      expect(feature.enabled, `${group.id}: ${feature.id}`).toBe(true)
      expect(feature.availability.available, `${group.id}: ${feature.id}`).toBe(true)
    }
  }
  const administratorGroup = groups.find(row => row.kind === 'admin')!
  const administratorSkills = await get(`groups/${administratorGroup.id}/skills`)
  expect(administratorSkills).toEqual(beforeAdministratorSkills)
  // These fixtures configure no skill execution secrets. The new display flag
  // is false; every previously returned field must still match exactly.
  expect(await get('skills')).toEqual(beforeSkills.map(skill => ({ ...skill, hasPlatformCredential: false })))
  expect(await get(`groups/${groupId}/skills`)).toEqual(beforeSkillGrants)
  assertRetainedSkillPacks(beforePacks, await get('skill-packs'))
  expect(await (await member.request.get(origin + '/market/api/skill-packs')).json()).toEqual(beforePackSelections)
  const { plugins, access, grants, selections, ...beforeCatalog } = beforeContributions
  const retainedCatalogState = await retainedCatalogSnapshot(retainedApi, remote, retainedCatalog.contentHash)
  expect(retainedCatalogState).toEqual(beforeCatalog)
  expect(release.requests.some(url => url.endsWith('.oci.tar'))).toBe(false)
  expect(
    (
      await remote(
        `sudo -u dsh-phalanx env XDG_RUNTIME_DIR=/run/user/$(id -u dsh-phalanx) podman image inspect ghcr.io/dake6767/dsh-phalanx@${release.manifest.image.digest} --format '{{.Digest}}'`,
      )
    ).trim(),
  ).toBe(release.manifest.image.digest)
  const upgradedAccounts = (await get('accounts')) as CommunityAccountsPageData
  const retainedAccounts = {
    ...upgradedAccounts,
    items: upgradedAccounts.items.map(({ instance, ...account }) => {
      expect(instance.resourcePending).toBe(false)
      if (deploymentInputs.persisted) return { ...account, instance }
      const { resourcePending, ...originalInstance } = instance
      void resourcePending
      return { ...account, instance: originalInstance }
    }),
  }
  expect(retainedAccounts).toEqual(beforeAccounts)
  expect(await get('mcp')).toEqual(beforeLibrary)
  expect(await get(`groups/${groupId}/mcp`)).toEqual(beforeGrants)
  expect(await (await member.request.get(origin + '/market/api/mcp')).json()).toEqual(beforeSelection)
  expect(await remote('sudo cat ' + installedShellArgument((await installedMemberHome(remote, memberStorageKey)) + '/upgrade-owned.txt'))).toBe(
    'MEMBER_DATA_PRESERVED',
  )
  const assertHistory = async () => {
    const rows = await history()
    for (const kind of ['execution', 'mcp'] as const) {
      for (const original of beforeUsage[kind].items) expect(rows[kind].items.find(row => row.id === original.id)).toEqual(original)
    }
    expect((await get('execution/settings')).limits).toEqual(beforeLimits)
  }
  expect(await get('usage-settings')).toEqual(beforeUsageSettings)
  await assertHistory()
  const normalizeModels = (view: UsageModelView) => ({
    ...view,
    items: view.items.map(row => ({ ...row, tokens: { ...row.tokens, reasoning: row.tokens.reasoning ?? null } })),
  })
  expect(beforeUsage.models.items.length).toBeGreaterThan(0)
  expect(beforeUsage.models.items.some(row => row.requests > 0 && (row.tokens.output ?? 0) > 0)).toBe(true)
  expect(normalizeModels((await history()).models)).toEqual(normalizeModels(beforeUsage.models))
  expect((await admin.request.get(origin + '/admin/api/execution/records')).status()).toBe(404)
  expect((await admin.request.get(origin + '/admin/execution-records')).status()).toBe(404)
  expect((await admin.request.get(origin + '/admin/usage-records', { maxRedirects: 0 })).status()).toBe(302)
  const trialApi = { get, post: (path: string, input: object) => post(path, input, executionTrialTimeout) }
  const trial = () => withAdministratorSkill(trialApi, 'retained-skill', () => retainedExecutionTrial(trialApi, 'after', trialEvidence, redact))
  await trial()
  await call('AFTER_OS_UPGRADE')
  const pluginState = { plugins, access, grants, selections }
  expect(await retainedPluginSnapshot(retainedApi)).toEqual(pluginState)
  const assertPaused = (phase: string) => assertPausedUpgradeState({ ...retainedApi, before: beforePaused, phase, expertReplies })
  await assertPaused('after-upgrade')
  await callPlugin('RETAINED_PLUGIN_AFTER')
  await runCommunityTerminal(member, 'officecli --version', '1.0.157')
  expect((await post('usage-settings', { retentionDays: 7 })).status()).toBe(200)
  await remote('sudo -u dsh-phalanx env XDG_RUNTIME_DIR=/run/user/$(id -u dsh-phalanx) systemctl --user restart dsh-phalanx.service', 300000)
  await expect
    .poll(
      async () => {
        try {
          return (await fetch(origin + '/login')).status
        } catch {
          return 0
        }
      },
      { timeout: 300000 },
    )
    .toBe(200)
  await admin.context().clearCookies()
  await member.context().clearCookies()
  expect(
    (await admin.request.post(origin + '/login', { headers: { origin }, form: { username: 'admin', password: 'password' }, maxRedirects: 0 })).status(),
  ).toBe(303)
  await signInCommunity(member, origin, 'member', 'password')
  expect(await get('usage-settings')).toEqual({ retentionDays: 7 })
  await assertHistory()
  const restartedModels = (await history()).models
  for (const original of beforeUsage.models.items) {
    const retained = restartedModels.items.find(row => row.username === original.username && row.modelId === original.modelId)
    expect(retained).toBeDefined()
    for (const field of ['requests', 'unknownRequests', 'deniedRequests'] as const) expect(retained![field]).toBeGreaterThanOrEqual(original[field])
    for (const field of ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'] as const) {
      const count = original.tokens[field]
      if (count != null) expect(retained!.tokens[field]).toBeGreaterThanOrEqual(count)
    }
  }
  expect(await retainedPluginSnapshot(retainedApi)).toEqual(pluginState)
  await assertPaused('after-restart')
  await trial()
  const retainedSession = await call('AFTER_RECORDS_RESTART')
  await refreshAppCenter(member, appCenterOptIn)
  if (!appCenterOptIn) {
    await setAppCenterVisibility(admin.request, origin, groupId)
    await refreshAppCenter(member, true)
  }
  for (const label of ['Usage records', 'Self-reported usage', 'Usage record retention']) expect(await member.getByText(label, { exact: true }).count()).toBe(0)

  expect(await member.getByRole('button', { name: 'Service preview', exact: true }).count()).toBe(0)
  expect(upstreamState.exposed).toBe(false)
  expect((await get('mcp/catalog')).map((row: { id: string }) => row.id).sort()).toEqual(['12306', 'amap'])
  return {
    retainedSession,
    appCenterGroupVisibilityPreserved: true,
    importedKernel,
    usageExecutionRecordsPreserved: beforeUsage.execution.items.length,
    usageMcpRecordsPreserved: beforeUsage.mcp.items.length,
    usageRecordIdsAndFieldsPreserved: true,
    modelUsagePreservedBeforeNewRequests: true,
    modelUsageCountersNondecreasingAcrossRestart: true,
    originalRetentionDays: beforeUsageSettings.retentionDays,
    restartRetentionDays: 7,
    historyStableAcrossRestart: true,
    executionLimitsPreserved: true,
    executionTrialsPassed: true,
    memberUiUnchanged: true,
    manualDependenciesPreserved: true,
    nonemptyCatalogInstallationsPreserved: true,
    pluginsAndSelectionsPreserved: true,
    expertsAndSelectionsPreserved: true,
    summonedExpertsExecutable: true,
    memberContributionsPreserved: true,
    retainedPluginToolPassed: true,
    retainedOfficeCliPassed: true,
    dependencyImageRefreshObserved: dependencies.some(
      (row, index) => row.current?.id !== (beforeDependencies as CommunityRuntimeDependencyView[])[index]?.current?.id,
    ),
    skillsAndGrantsPreserved: true,
    skillPacksPreserved: true,
    accountsAndMcpPreserved: true,
    memberFilePreserved: true,
  }
}
