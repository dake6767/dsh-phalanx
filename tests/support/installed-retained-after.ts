import type { APIResponse, Page } from 'playwright'
import { expect } from 'vitest'
import type { CommunityAccountsPageData, CommunityRuntimeDependencyView, CommunitySkillView, CommunityUsageRecords } from '../../src/domain/admin-contract.js'
import { runCommunityTerminal, signInCommunity } from '../fixtures/community-native-browser.js'
import { installedReleaseFixture } from './installed-release-fixture.js'
import { retainedContributionSnapshot, retainedOfficialCatalog } from './installed-retained-contributions.js'
import { installedShellArgument, installedUserDataRoot } from './installed-storage-layout.js'
import { retainedExecutionTrial } from './installed-upgrade-trial.js'
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
  deploymentInputs: Parameters<ReturnType<typeof installedInstanceAcceptance>['assertImported']>[0]
  beforeDependencies: readonly CommunityRuntimeDependencyView[]
  beforeSkills: readonly CommunitySkillView[]
  beforeAdministratorSkills: string[]
  groupId: string
  beforeSkillGrants: unknown
  beforePacks: unknown
  beforePackSelections: unknown
  retainedApi: Parameters<typeof retainedContributionSnapshot>[0]
  retainedCatalog: Awaited<ReturnType<typeof retainedOfficialCatalog>>
  beforeContributions: Awaited<ReturnType<typeof retainedContributionSnapshot>>
  beforeAccounts: unknown
  beforeLibrary: unknown
  beforeSelection: unknown
  beforeGrants: { implicit?: boolean } & Record<string, unknown>
  history: () => Promise<{ execution: CommunityUsageRecords; mcp: CommunityUsageRecords }>
  beforeUsage: { execution: CommunityUsageRecords; mcp: CommunityUsageRecords }
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
  const importedKernel = await instances.assertImported(deploymentInputs)
  await expect
    .poll(async () => retainedDependencyState(await get('runtime-dependencies')), { timeout: 300000 })
    .toEqual(retainedDependencyState(beforeDependencies))
  const dependencies: CommunityRuntimeDependencyView[] = await get('runtime-dependencies')
  // The previous release implicitly counted the administrator as a managed
  // skill user. Library contents and ordinary-member access remain intact;
  // this version deliberately starts the administrator group without grants.
  const administratorGroup = (await get('groups')).find((row: { kind: string }) => row.kind === 'admin')
  const administratorSkills = await get(`groups/${administratorGroup.id}/skills`)
  expect(administratorSkills.skills.filter((row: { granted: boolean }) => row.granted)).toEqual([])
  expect(administratorSkills.packs.filter((row: { granted: boolean }) => row.granted)).toEqual([])
  expect(await get('skills')).toEqual(
    beforeSkills.map(skill => ({ ...skill, managedMembers: skill.managedMembers - (beforeAdministratorSkills.includes(skill.name) ? 1 : 0) })),
  )
  expect(await get(`groups/${groupId}/skills`)).toEqual(beforeSkillGrants)
  expect(await get('skill-packs')).toEqual(beforePacks)
  expect(await (await member.request.get(origin + '/market/api/skill-packs')).json()).toEqual(beforePackSelections)
  expect(await retainedContributionSnapshot(retainedApi, remote, retainedCatalog.contentHash)).toEqual(beforeContributions)
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
  const { implicit: previousImplicitGrant, ...retainedMcpGrants } = beforeGrants
  expect([false, undefined]).toContain(previousImplicitGrant)
  expect(await get(`groups/${groupId}/mcp`)).toEqual(retainedMcpGrants)
  expect(await (await member.request.get(origin + '/market/api/mcp')).json()).toEqual(beforeSelection)
  expect(await remote('sudo cat ' + installedShellArgument((await installedUserDataRoot(remote)) + '/member/home/upgrade-owned.txt'))).toBe(
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
  expect((await admin.request.get(origin + '/admin/api/execution/records')).status()).toBe(404)
  expect((await admin.request.get(origin + '/admin/execution-records')).status()).toBe(404)
  await admin.goto(origin + '/admin/usage-records')
  const usageGrid = admin.getByRole('grid', { name: 'Tool usage records', exact: true })
  await usageGrid.getByText('skill:retained-skill', { exact: true }).waitFor()
  await usageGrid.getByText('p-selected', { exact: true }).first().waitFor()
  // The upgraded administrator must explicitly acquire skills before running as themselves.
  const adminGroup = (await get('groups')).find((row: { kind: string }) => row.kind === 'admin')
  const adminGrantPath = `groups/${adminGroup.id}/skills`,
    adminGrant = await get(adminGrantPath)
  expect((await post(adminGrantPath, { action: 'save', names: ['retained-skill'], revision: adminGrant.revision, confirmed: true })).status()).toBe(200)
  const trial = () => retainedExecutionTrial({ get, post: (path, input) => post(path, input, executionTrialTimeout) }, 'after', trialEvidence, redact)
  await trial()
  await call('AFTER_OS_UPGRADE')
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
  await trial()
  const retainedSession = await call('AFTER_RECORDS_RESTART')
  await member.getByRole('button', { name: 'Platform App Center', exact: true }).waitFor()
  for (const label of ['Usage records', 'Self-reported usage', 'Usage record retention']) expect(await member.getByText(label, { exact: true }).count()).toBe(0)

  expect(await member.getByRole('button', { name: 'Service preview', exact: true }).count()).toBe(0)
  expect(upstreamState.exposed).toBe(false)
  expect((await get('mcp/catalog')).map((row: { id: string }) => row.id).sort()).toEqual(['12306', 'amap'])
  return {
    retainedSession,
    importedKernel,
    usageExecutionRecordsPreserved: beforeUsage.execution.items.length,
    usageMcpRecordsPreserved: beforeUsage.mcp.items.length,
    usageRecordIdsAndFieldsPreserved: true,
    originalRetentionDays: beforeUsageSettings.retentionDays,
    restartRetentionDays: 7,
    historyStableAcrossRestart: true,
    executionLimitsPreserved: true,
    executionTrialsPassed: true,
    memberUiUnchanged: true,
    manualDependenciesPreserved: true,
    nonemptyCatalogInstallationsPreserved: true,
    managedAndNativePluginsPreserved: true,
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
