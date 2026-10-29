import { randomUUID } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect } from 'vitest'
import { formalUpgradeScope } from '../../scripts/validation/formal-baseline.mjs'
import type { CommunitySkillView, CommunityUsageRecords } from '../../src/domain/admin-contract.js'
import { downloadSourcePresets } from '../../src/domain/download-source.js'
import {
  openCommunitySession,
  runCommunityTerminal,
  selectCommunityWorkspace,
  sendCommunityPrompt,
  signInCommunity,
  startCommunitySession,
} from '../fixtures/community-native-browser.js'
import { acceptanceProgress } from './acceptance-progress.js'
import { installedReleaseFixture } from './installed-release-fixture.js'
import { assertRetainedUpgradeAfter } from './installed-retained-after.js'
import { configureRetainedUpgrade } from './installed-retained-configure.js'
import {
  publishRetainedPlugins,
  retainedCatalogSha256,
  retainedContributionSnapshot,
  retainedFixtureIdentity,
  retainedOfficialCatalog,
  retainedPluginPackages,
  seedRetainedCatalog,
  seedRetainedPluginLibrary,
} from './installed-retained-contributions.js'
import { createRetainedUpgradeUpstream } from './installed-retained-upstream.js'
import { installedShellArgument, installedUserDataRoot } from './installed-storage-layout.js'
import { cookieHeader, createRealDshRpc } from './real-dsh-rpc.js'
import { instanceWorkspacePath } from './real-dsh-runtime.js'
import { installedInstanceAcceptance } from './upgrade-instance-combination.js'

export interface InstalledUpgradeHost {
  /** Administrator origin of the formally installed baseline. */
  readonly origin: string
  /** Address at which the installed service reaches this process's fixtures. */
  readonly address: string
  /** Runs a shell command on the installed host as a sudo-capable operator. */
  readonly remote: (command: string, timeout?: number, acceptedExitCodes?: number[]) => Promise<string>
  /** Verified candidate bundle and installer paths on the installed host; the release fixture reads releaseBundle locally. */
  readonly bundle: string
  readonly installer: string
  readonly releaseBundle: string
  readonly candidate: string
  readonly tag: string
  /** T4 adds a new-session reply from a real provider; T2 stops after the retained-data checks. */
  readonly realReply: boolean
}

/** Formal previous release → candidate, retaining the same data assertions for both transports. */
export async function runInstalledUpgrade({ origin, address, remote, bundle, installer, releaseBundle, candidate, tag, realReply }: InstalledUpgradeHost) {
  const workspace = instanceWorkspacePath('', true)
  const transport = process.env.DSH_PHALANX_UPGRADE_TRANSPORT ?? 'offline'
  if (transport !== 'offline' && transport !== 'mainland-online') throw Error('Unknown upgrade acceptance transport')
  if (transport === 'mainland-online' && !realReply) throw Error('Mainland online acceptance requires the T4 real reply')
  // T4 stages run in an emulated VM and prove installation and upgrade; product combinations run once on real T2 hardware.
  const combination = !realReply
  const targetVersion = (JSON.parse(await readFile('package.json', 'utf8')) as { version: string }).version
  // The formal baseline is the previous formal release, which must be a declared upgrade source.
  const source = (JSON.parse(await readFile('release-policy.json', 'utf8')) as { compatibility: { source: { min: string; maxExclusive: string } } })
    .compatibility.source
  const scope = formalUpgradeScope(await readdir('releases/acceptance'), targetVersion, source)
  if (!scope.upgrade || scope.previous === undefined) throw Error(`Version ${targetVersion} has no formal previous release to upgrade from`)
  const baselineVersion = scope.previous
  const bootstrapRequired = baselineVersion === '0.1.23' && targetVersion === '0.1.24'
  const baseline = JSON.parse(await readFile(`releases/acceptance/${baselineVersion}.json`, 'utf8')) as {
    commit: string
    platformSha256: string
    imageDigest: string
  }
  const versions = JSON.parse(await readFile('runtime-versions.json', 'utf8')) as { dsh: { revision: string } }
  const retainedCatalog = await retainedOfficialCatalog(baselineVersion)
  const progress = await acceptanceProgress(
    process.env.DSH_PHALANX_ACCEPTANCE_PROGRESS ?? join(process.env.DSH_PHALANX_E2E_EVIDENCE_DIR ?? tmpdir(), 'installed-upgrade-progress.json'),
    {
      candidate,
      tag,
      host: (await remote('cat /etc/machine-id')).trim(),
      baseline: baseline.commit,
      transport,
      scenario: 'formal-upgrade-with-retained-contributions-v4',
      retainedFixtures: retainedFixtureIdentity,
      retainedCatalogSha256,
    },
    [
      'release-source',
      'fixture',
      'baseline',
      'deployment-inputs',
      'configure',
      'retained-catalog',
      'retained-plugin-library',
      'retained-plugin-access',
      'retained-state',
      'before',
      'original-download-sources',
      'previous-updater-check',
      ...(bootstrapRequired ? ['updater-bootstrap', 'updater-check'] : []),
      'capacity',
      'image-transition',
      'upgrade',
      'enter',
      'after',
      ...(realReply ? ['real-reply'] : []),
      ...(combination ? ['instance-combination'] : []),
    ],
    process.env.DSH_PHALANX_ACCEPTANCE_RESUME,
  )
  const release = await installedReleaseFixture(releaseBundle, candidate, tag, progress.saved<{ port: number }>('release-source')?.port)
  await progress.step('release-source', async () => ({ port: release.port }))
  const releasePrefix = `http://${address}:${release.port}/`
  let passed = false,
    credential = '',
    realKey = ''
  const redact = (text: string) => [credential, realKey].filter(Boolean).reduce((value, secret) => value.replaceAll(secret, '[redacted]'), text)
  const trialEvidence = process.env.DSH_PHALANX_E2E_EVIDENCE_DIR ? join(process.env.DSH_PHALANX_E2E_EVIDENCE_DIR, 'installed-retained-trials.jsonl') : undefined
  const {
    fixture,
    upstream,
    calls,
    pluginCalls,
    state: upstreamState,
  } = await createRetainedUpgradeUpstream({ address, catalogBytes: retainedCatalog.bytes, progress })
  const browser = await chromium.launch({ headless: true }),
    admin = await browser.newPage({ locale: 'en' }),
    member = await browser.newPage({ locale: 'en' })
  admin.setDefaultTimeout(120000)
  member.setDefaultTimeout(120000)
  const get = async (path: string) => {
    const response = await admin.request.get(origin + '/admin/api/' + path)
    expect(response.status()).toBe(200)
    return response.json()
  }
  const post = (path: string, data: object, timeout = 30000) => admin.request.post(origin + '/admin/api/' + path, { headers: { origin }, data, timeout })
  // API requests have their own deadline; an emulated execution container can cold-start beyond 30 seconds.
  const executionTrialTimeout = realReply ? 300000 : 30000
  const instances = installedInstanceAcceptance({ origin, remote, admin, member })
  let upgrade: unknown, insufficient: unknown
  try {
    await progress.step('baseline', async () => {
      const before = JSON.parse(await remote('sudo cat /opt/dsh-phalanx/current/build-info.json'))
      expect(before.commit).toBe(baseline.commit)
      const receipt = JSON.parse(await remote('sudo cat /etc/dsh-phalanx/install-state.json'))
      expect(receipt).toMatchObject({
        version: 'v' + baselineVersion,
        commit: baseline.commit,
        platformSha256: baseline.platformSha256,
        imageDigest: baseline.imageDigest,
      })
      const installedManifest = JSON.parse(await remote('sudo cat /etc/dsh-phalanx/installed-manifest.json'))
      expect(installedManifest).toMatchObject({
        commit: baseline.commit,
        targetVersion: baselineVersion,
        image: { digest: baseline.imageDigest },
        files: { 'dsh-phalanx-linux-amd64.tar.gz': baseline.platformSha256 },
      })
      expect((await remote('sudo cat /opt/dsh-phalanx/current/.artifact-sha256')).trim()).toBe(baseline.platformSha256)
      expect(baseline.imageDigest).toMatch(/^sha256:[a-f0-9]{64}$/u)
      expect(
        (
          await remote(
            `sudo -u dsh-phalanx env XDG_RUNTIME_DIR=/run/user/$(id -u dsh-phalanx) podman image inspect ghcr.io/dake6767/dsh-phalanx@${baseline.imageDigest} --format '{{.Digest}}'`,
          )
        ).trim(),
      ).toBe(baseline.imageDigest)
      expect(JSON.parse(await remote('sudo cat /opt/dsh-phalanx/current/package.json')).version).toBe(baselineVersion)
      const target = JSON.parse(await remote(`cat ${bundle}/manifest.json`))
      expect(target).toMatchObject({ schema: 2, tag, targetVersion, commit: candidate, runId: tag.slice(4), platform: 'linux/amd64' })
      expect(target).toEqual(release.manifest)
      const policy = JSON.parse(await readFile('release-policy.json', 'utf8')) as { compatibility: { sourceDshRevisions: string[] } }
      if (before.versions.dsh.revision !== versions.dsh.revision) expect(policy.compatibility.sourceDshRevisions).toContain(before.versions.dsh.revision)
      return before as { commit: string; versions: { dsh: { revision: string } } }
    })
    const deploymentInputs = await progress.step('deployment-inputs', async () => {
      credential = (await remote('sudo cat /var/lib/dsh-phalanx/data/bootstrap-credential')).trim().split(/\s/u)[0]!
      expect(
        (
          await admin.request.post(origin + '/bootstrap', {
            headers: { origin },
            form: { credential, username: 'admin', password: 'password' },
            maxRedirects: 0,
          })
        ).status(),
      ).toBe(303)
      return instances.prepareBaseline(transport === 'offline')
    })
    const { memberEntry, groupId } = await progress.step('configure', () =>
      configureRetainedUpgrade({ instances, upstream, admin, origin, get, post, member, executionTrialTimeout, trialEvidence, redact }),
    )
    const retainedApi = { get, post, origin, admin, member, groupId }
    await progress.step('retained-catalog', async () => {
      await seedRetainedCatalog(retainedApi)
      return { installed: true, catalogSha256: retainedCatalogSha256, contentHash: retainedCatalog.contentHash }
    })
    await progress.step('retained-plugin-library', async () => {
      await seedRetainedPluginLibrary(retainedApi)
      return { uploaded: true }
    })
    await progress.step('retained-plugin-access', async () => {
      await publishRetainedPlugins(retainedApi)
      return { managedAndNativeConfigured: true }
    })
    const {
      beforeAccounts,
      beforeLibrary,
      beforeGrants,
      beforeSelection,
      beforeDependencies,
      beforeSkills,
      beforeSkillGrants,
      beforePacks,
      beforePackSelections,
      beforeAdministratorSkills,
      beforeContributions,
    } = await progress.step('retained-state', async () => {
      const grantPath = `groups/${groupId}/skills`
      const beforePacks = await get('skill-packs'),
        beforePackSelections = await (await member.request.get(origin + '/market/api/skill-packs')).json()
      for (const source of ['managed', 'selected'])
        expect(beforePackSelections.find((row: { name: string }) => row.name === 'retained-pack-' + source)).toMatchObject({
          source,
          skills: ['retained-skill'],
          instructions: 'Keep the existing workflow.',
        })
      const beforeDependencies = await get('runtime-dependencies'),
        beforeSkills = (await get('skills')) as readonly CommunitySkillView[],
        beforeSkillGrants = await get(grantPath)
      const administratorGroup = (await get('groups')).find((row: { kind: string }) => row.kind === 'admin')
      const administratorSkills = await get(`groups/${administratorGroup.id}/skills`)
      const beforeAdministratorSkills = administratorSkills.skills
        .filter((row: { granted: boolean }) => row.granted)
        .map((row: { name: string }) => row.name) as string[]
      const beforeAccounts = await get('accounts'),
        beforeLibrary = await get('mcp'),
        beforeGrants = await get(`groups/${groupId}/mcp`)
      const beforeSelection = await (await member.request.get(origin + '/market/api/mcp')).json()
      const beforeContributions = await retainedContributionSnapshot(retainedApi, remote, retainedCatalog.contentHash)
      return {
        beforeAccounts,
        beforeLibrary,
        beforeGrants,
        beforeSelection,
        beforeDependencies,
        beforeSkills,
        beforeSkillGrants,
        beforePacks,
        beforePackSelections,
        beforeAdministratorSkills,
        beforeContributions,
      }
    })
    const call = async (marker: string) => {
      await selectCommunityWorkspace(member.context(), member, origin, workspace, true)
      // Native creation records workspace membership; RPC cwd alone leaves a session ungrouped.
      const sessionId = await startCommunitySession(member)
      await sendCommunityPrompt(member, marker)
      await expect
        .poll(() => calls[marker], { timeout: 300000 })
        .toEqual({ failed: false, valid: true, tools: ['mcp__p-managed__echo', 'mcp__p-selected__echo'] })
      await member
        .locator(`[data-conversation-content][data-conversation-session=${JSON.stringify(sessionId)}]:visible`)
        .getByText('UPGRADE_QUERY_DONE', { exact: true })
        .waitFor()
      return sessionId
    }
    const callPlugin = async (marker: string) => {
      await selectCommunityWorkspace(member.context(), member, origin, workspace, true)
      const sessionId = await startCommunitySession(member)
      await sendCommunityPrompt(member, marker)
      await expect.poll(() => pluginCalls[marker], { timeout: 300000 }).toEqual({ failed: false, valid: true })
      await member
        .locator(`[data-conversation-content][data-conversation-session=${JSON.stringify(sessionId)}]:visible`)
        .getByText('RETAINED_PLUGIN_DONE', { exact: true })
        .waitFor()
      const plugins = await createRealDshRpc().remoteRpc<{ moduleName: string; enabled: boolean; fiberPhase: string }[]>(
        origin,
        await cookieHeader(member.context(), origin),
        'pluginManager/listPlugins',
        {},
      )
      for (const packageName of retainedPluginPackages) {
        const entries = plugins.filter(row => row.moduleName.includes(packageName))
        expect(entries.length).toBeGreaterThan(0)
        for (const entry of entries) expect(entry).toMatchObject({ enabled: true, fiberPhase: 'active' })
      }
      return sessionId
    }
    const history = async () => ({
      execution: (await get('usage-records?username=admin&capability=skill%3Aretained-skill&operation=retained')) as CommunityUsageRecords,
      mcp: (await get('usage-records?username=member&capability=p-selected&operation=echo')) as CommunityUsageRecords,
    })
    const { originalPid, beforeCalls, beforeExposed, beforeUsage, beforeUsageSettings, beforeLimits } = await progress.step('before', async () => {
      await signInCommunity(member, origin, 'member', 'password')
      await call('BEFORE_OS_UPGRADE')
      await callPlugin('RETAINED_PLUGIN_BEFORE')
      await runCommunityTerminal(member, 'officecli --version', '1.0.157')
      await member.getByRole('button', { name: 'Platform App Center', exact: true }).waitFor()
      for (const label of ['Usage records', 'Self-reported usage', 'Usage record retention'])
        expect(await member.getByText(label, { exact: true }).count()).toBe(0)
      await expect.poll(async () => (await history()).execution.items.length).toBe(1)
      await expect.poll(async () => (await history()).mcp.items.length).toBeGreaterThan(0)
      const beforeUsage = await history(),
        beforeUsageSettings = await get('usage-settings')
      expect(beforeUsageSettings).toEqual({ retentionDays: 13 })
      expect(beforeUsage.execution.items[0]).toMatchObject({
        username: 'admin',
        outcome: 'succeeded',
        capability: { id: 'skill:retained-skill', operation: 'retained' },
      })
      if (deploymentInputs.persisted) await instances.assertImported(deploymentInputs)
      else {
        const absentResources = await admin.request.get(origin + '/admin/api/instance-resources')
        expect(absentResources.status()).toBe(404)
        expect(await absentResources.json()).toMatchObject({ code: 'not-found' })
      }
      const baselineKernel = await instances.kernel()
      instances.assertBaselineLimits(baselineKernel, deploymentInputs)
      const beforeLimits = (await get('execution/settings')).limits

      await remote(
        'sudo -u dsh-phalanx sh -c ' +
          installedShellArgument(
            'printf MEMBER_DATA_PRESERVED > ' + installedShellArgument((await installedUserDataRoot(remote)) + '/member/home/upgrade-owned.txt'),
          ),
      )
      const pidCommand = 'sudo -u dsh-phalanx env XDG_RUNTIME_DIR=/run/user/$(id -u dsh-phalanx) systemctl --user show dsh-phalanx.service -p MainPID --value'
      const originalPid = (await remote(pidCommand)).trim()
      expect(Number(originalPid)).toBeGreaterThan(0)
      return { originalPid, beforeCalls: { ...calls }, beforeExposed: upstreamState.exposed, beforeUsage, beforeUsageSettings, beforeLimits, baselineKernel }
    })
    Object.assign(calls, beforeCalls)
    upstreamState.exposed ||= beforeExposed
    const pidCommand = 'sudo -u dsh-phalanx env XDG_RUNTIME_DIR=/run/user/$(id -u dsh-phalanx) systemctl --user show dsh-phalanx.service -p MainPID --value'
    const originalDownloadSources = await progress.step('original-download-sources', async () => {
      const { preset, overrides } = await get('download-sources')
      return { preset, overrides }
    })
    await progress.step('previous-updater-check', async () => {
      expect(
        (await admin.request.post(origin + '/login', { headers: { origin }, form: { username: 'admin', password: 'password' }, maxRedirects: 0 })).status(),
      ).toBe(303)
      const sources = originalDownloadSources
      expect(
        (
          await post('download-sources', { preset: sources.preset, overrides: { ...sources.overrides, githubAssets: releasePrefix, githubApi: releasePrefix } })
        ).status(),
      ).toBe(200)
      // This request reaches the unmodified, formally installed executor over its Unix socket.
      const check = await post('system-update', { action: 'check' })
      expect(check.status()).toBe(200)
      const result = await check.json()
      if (bootstrapRequired) expect(result.check).toMatchObject({ status: 'failed', reason: 'Unsupported release compatibility protocol' })
      else expect(result.check).toMatchObject({ status: 'available', version: 'v' + targetVersion })
      expect((await remote(pidCommand)).trim()).toBe(originalPid)
      return { check: result.check, unmodifiedFormalExecutor: true, expectedPolicyTransitionRefusal: bootstrapRequired }
    })
    if (bootstrapRequired) {
      await progress.step('updater-bootstrap', async () => {
        const requestStart = release.requests.length
        const result = JSON.parse(await remote(`sudo bash ${installer} --version ${tag} --bundle-dir ${bundle} --upgrade bootstrap --output json`, 300000))
        expect(result).toMatchObject({ status: 'updater-ready', executor: { sourceCommit: candidate }, operation: null })
        expect((await remote(pidCommand)).trim()).toBe(originalPid)
        const requests = release.requests.slice(requestStart)
        expect(requests.length).toBeGreaterThan(0)
        expect(requests.every(url => url.endsWith('/updater.json'))).toBe(true)
        return { executor: result.executor, platformPidUnchanged: true, smallUpdaterOnly: true, requests }
      })
      await progress.step('updater-check', async () => {
        let result: { check: { status: string; version: string } } | undefined
        await expect
          .poll(
            async () => {
              try {
                const response = await post('system-update', { action: 'check' })
                if (response.status() !== 200) return 'unavailable'
                result = await response.json()
                return result?.check.status
              } catch {
                return 'unavailable'
              }
            },
            { timeout: 300000 },
          )
          .toBe('available')
        expect(result?.check).toMatchObject({ status: 'available', version: 'v' + targetVersion })
        expect((await remote(pidCommand)).trim()).toBe(originalPid)
        return { check: result!.check, releaseBoundExecutor: true, platformPidUnchanged: true }
      })
    }
    insufficient = await progress.step('capacity', async () => {
      await remote('sudo mkdir -p /var/lib/dsh-phalanx-updater && sudo mount -t tmpfs -o size=8m,mode=700 candidate-capacity /var/lib/dsh-phalanx-updater')
      try {
        insufficient = JSON.parse(await remote(`sudo bash ${installer} --version ${tag} --bundle-dir ${bundle} --upgrade prepare --output json`, 1800000, [1]))
        expect(insufficient).toMatchObject({ status: 'upgrade', operation: { phase: 'prepare-failed', space: { sufficient: false } } })
        expect((await remote(pidCommand)).trim()).toBe(originalPid)
        await remote('sudo test ! -e /etc/dsh-phalanx/maintenance')
      } finally {
        await remote('sudo umount /var/lib/dsh-phalanx-updater')
      }
      return insufficient
    })
    // An unchanged image upgrades in place; the image-change path is then not covered, and the receipt says so.
    const sameDigest = release.manifest.image.digest === baseline.imageDigest
    await progress.step('image-transition', async () => {
      expect(
        (
          await remote(
            `sudo -u dsh-phalanx env XDG_RUNTIME_DIR=/run/user/$(id -u dsh-phalanx) podman image inspect ghcr.io/dake6767/dsh-phalanx@${baseline.imageDigest} --format '{{.Digest}}'`,
          )
        ).trim(),
      ).toBe(baseline.imageDigest)
      expect((await remote(pidCommand)).trim()).toBe(originalPid)
      return {
        sameDigest,
        digestChangePathCovered: !sameDigest,
        uncovered: sameDigest ? ['target-image-absent-before-import', 'dependency-artifact-refresh'] : [],
        sourceDigest: baseline.imageDigest,
        targetDigest: release.manifest.image.digest,
        imagePreloadedByHarness: false,
        executorBootstrappedByHarness: bootstrapRequired,
      }
    })
    upgrade = await progress.step('upgrade', async () => {
      expect(
        (await admin.request.post(origin + '/login', { headers: { origin }, form: { username: 'admin', password: 'password' }, maxRedirects: 0 })).status(),
      ).toBe(303)
      if (transport === 'mainland-online') {
        expect(process.env.DSH_PHALANX_ACCEPTANCE_PREPARED_OPERATION).toBeUndefined()
        // The earlier formal-updater check uses controlled metadata only. Clear
        // its overrides before exercising the shipped mainland download preset.
        expect((await post('download-sources', { preset: 'mainland', overrides: {} })).status()).toBe(200)
        const sources = await get('download-sources')
        expect(sources.preset).toBe('mainland')
        expect(sources.overrides ?? {}).toEqual({})
        const imageUser = 'sudo -u dsh-phalanx env XDG_RUNTIME_DIR=/run/user/$(id -u dsh-phalanx)'
        if (!sameDigest) await remote(`${imageUser} podman image exists ${release.manifest.image.reference}; image_status=$?; test "$image_status" -eq 1`)
        const online = JSON.parse(
          await remote(
            `sudo bash ${installer} --version ${tag} --dev-release-base-url https://github.com/dake6767/dsh-phalanx-candidates/releases --download-source-preset mainland --github-proxy-prefix ${downloadSourcePresets.mainland.githubAssets} --yes --output json`,
            3600000,
          ),
        )
        expect(online).toMatchObject({
          status: 'upgrade',
          operation: { phase: 'succeeded', sourceVersion: baselineVersion, targetVersion, targetCommit: candidate, cleanup: { status: 'succeeded' } },
        })
        expect((await remote(pidCommand)).trim()).not.toBe(originalPid)
        expect(Number((await remote(pidCommand)).trim())).toBeGreaterThan(0)
        return {
          ...online.operation,
          transport,
          preset: 'mainland',
          githubAssets: downloadSourcePresets.mainland.githubAssets,
          bundleDirUsed: false,
          imageAbsenceCheckedInThisAttempt: !sameDigest,
          imageAbsenceSkippedReason: sameDigest ? 'same-digest' : null,
          imagePreloadedByHarness: false,
        }
      }
      // A resumed failed apply may already have restored the original sources.
      expect(
        (
          await post('download-sources', {
            preset: originalDownloadSources.preset,
            overrides: { ...originalDownloadSources.overrides, githubAssets: releasePrefix, githubApi: releasePrefix },
          })
        ).status(),
      ).toBe(200)
      await admin.goto(origin + '/admin/settings')
      const panel = admin.getByRole('region', { name: 'System update', exact: true })
      await admin.getByRole('button', { name: 'Check for updates', exact: true }).click()
      await panel.getByText('Formal update available: v' + targetVersion, { exact: true }).waitFor()
      // The Web download action pulls from the configured registry. Exercise
      // the public offline handoff instead, then apply that operation in Web.
      const imageUser = 'sudo -u dsh-phalanx env XDG_RUNTIME_DIR=/run/user/$(id -u dsh-phalanx)'
      const archive = 'dsh-phalanx-dsh-linux-amd64.oci.tar'
      expect((await remote(`sha256sum ${bundle}/${archive}`)).split(/\s/u)[0]).toBe(release.manifest.files[archive])
      const retainedPreparation = process.env.DSH_PHALANX_ACCEPTANCE_PREPARED_OPERATION
      let prepared: { id: string }
      if (retainedPreparation) {
        // A failed application attempt may retain its completed offline prepare.
        // The coordinator must retain that attempt's original assertions too.
        expect(progress.report().resumeFrom).toBe('upgrade')
        expect(retainedPreparation).toMatch(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u)
        prepared = (await get('system-update')).operation
        expect(prepared).toMatchObject({ id: retainedPreparation, phase: 'prepared', sourceVersion: baselineVersion, targetVersion, targetCommit: candidate })
      } else {
        if (!sameDigest) await remote(`${imageUser} podman image exists ${release.manifest.image.reference}; image_status=$?; test "$image_status" -eq 1`)
        const offline = JSON.parse(await remote(`sudo bash ${installer} --version ${tag} --bundle-dir ${bundle} --upgrade prepare --output json`, 3600000))
        expect(offline).toMatchObject({
          status: 'upgrade',
          operation: { phase: 'prepared', sourceVersion: baselineVersion, targetVersion, targetCommit: candidate },
        })
        prepared = offline.operation
      }
      expect((await remote(pidCommand)).trim()).toBe(originalPid)
      const offlinePreparationId = prepared.id
      // Web only applies formal versions. Select the same verified bytes via
      // the controlled formal metadata after the real CLI imported the archive.
      await panel.getByRole('button', { name: 'Download update', exact: true }).click()
      await expect
        .poll(
          async () => {
            const operation = (await get('system-update')).operation
            return operation?.id !== offlinePreparationId && operation?.phase === 'prepared'
          },
          { timeout: 1800000 },
        )
        .toBe(true)
      prepared = (await get('system-update')).operation
      expect(prepared).toMatchObject({
        phase: 'prepared',
        sourceVersion: baselineVersion,
        targetVersion,
        targetCommit: candidate,
        imageDigest: release.manifest.image.digest,
        platformSha256: release.manifest.files['dsh-phalanx-linux-amd64.tar.gz'],
      })
      expect((await remote(pidCommand)).trim()).toBe(originalPid)
      // A new administration window follows the formal Web preparation's latest operation,
      // rather than a previously followed Web operation in browser storage.
      const application = await browser.newPage({ locale: 'en' })
      application.setDefaultTimeout(120000)
      try {
        expect(
          (
            await application.request.post(origin + '/login', { headers: { origin }, form: { username: 'admin', password: 'password' }, maxRedirects: 0 })
          ).status(),
        ).toBe(303)
        await application.goto(origin + '/admin/settings')
        const applicationPanel = application.getByRole('region', { name: 'System update', exact: true })
        await applicationPanel.getByText('Downloaded and verified; ready to apply.', { exact: true }).waitFor({ timeout: 1800000 })
        expect((await get('system-update')).operation).toMatchObject({
          id: prepared.id,
          phase: 'prepared',
          sourceVersion: baselineVersion,
          targetVersion,
          targetCommit: candidate,
        })
        // Preparation already pins the verified operation; restore real upstreams for dependency refresh.
        expect((await post('download-sources', originalDownloadSources)).status()).toBe(200)
        const restoredSources = await get('download-sources')
        expect({ preset: restoredSources.preset, overrides: restoredSources.overrides }).toEqual(originalDownloadSources)
        expect((await get('system-update')).operation).toMatchObject({ id: prepared.id, phase: 'prepared' })
        await applicationPanel.getByRole('button', { name: 'Apply update', exact: true }).click()
        await application
          .getByRole('dialog', { name: 'Apply update: ' + targetVersion, exact: true })
          .getByRole('button', { name: 'Confirm and apply now', exact: true })
          .click()
        await applicationPanel.getByText('Update completed successfully.', { exact: true }).waitFor({ timeout: 1800000 })
        await expect.poll(async () => (await get('system-update?operation=' + prepared.id)).operation?.cleanup?.status, { timeout: 120000 }).toBe('succeeded')
        const operation = (await get('system-update?operation=' + prepared.id)).operation
        expect(operation).toMatchObject({
          id: prepared.id,
          phase: 'succeeded',
          sourceVersion: baselineVersion,
          targetVersion,
          targetCommit: candidate,
          cleanup: { status: 'succeeded' },
        })
        return {
          ...operation,
          transport: 'verified-offline-bundle',
          offlinePreparationId,
          formalWebPreparationId: prepared.id,
          imageAbsenceCheckedInThisAttempt: !retainedPreparation && !sameDigest,
          imageAbsenceSkippedReason: retainedPreparation ? 'retained-preparation' : sameDigest ? 'same-digest' : null,
          preparationReusedFromFailedAttempt: Boolean(retainedPreparation),
          archiveSha256: release.manifest.files[archive],
          webApplied: true,
        }
      } finally {
        await application.close()
      }
    })
    await progress.step('enter', async () => {
      expect(JSON.parse(await remote('sudo cat /opt/dsh-phalanx/current/build-info.json')).commit).toBe(candidate)
      await member.context().clearCookies()
      await member.goto(origin + '/login')
      await member.getByLabel('Username', { exact: true }).fill('member')
      await member.getByLabel('Password', { exact: true }).fill('password')
      const submitted = member.waitForResponse(response => new URL(response.url()).pathname === '/login' && response.request().method() === 'POST', {
        timeout: 300000,
      })
      await member.getByRole('button', { name: 'Sign in', exact: true }).click({ noWaitAfter: true })
      expect((await submitted).status()).toBe(303)
      await member.waitForURL(url => url.origin === origin && url.pathname === memberEntry, { timeout: 300000 })
      await member.locator('#root').waitFor({ state: 'attached', timeout: 600000 })
      expect(await remote('sudo cat ' + installedShellArgument((await installedUserDataRoot(remote)) + '/member/home/upgrade-owned.txt'))).toBe(
        'MEMBER_DATA_PRESERVED',
      )
      return { loginStatus: 303, memberEntry, rootAttached: true, memberFilePreserved: true, coldEntryAfterUpgrade: true }
    })
    await progress.step('after', () =>
      assertRetainedUpgradeAfter({
        remote,
        candidate,
        versions,
        release,
        admin,
        member,
        origin,
        memberEntry,
        instances,
        deploymentInputs,
        get,
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
        post,
        executionTrialTimeout,
        trialEvidence,
        redact,
        call,
        callPlugin,
        upstreamState,
      }),
    )
    if (realReply)
      await progress.step('real-reply', async () => {
        expect(
          (await admin.request.post(origin + '/login', { headers: { origin }, form: { username: 'admin', password: 'password' }, maxRedirects: 0 })).status(),
        ).toBe(303)
        await signInCommunity(member, origin, 'member', 'password')
        const privateInput = process.env.DSH_PHALANX_UPGRADE_REAL_INPUT
        if (!privateInput) throw Error('A protected provider input is required for the post-upgrade real DSH reply')
        realKey = (JSON.parse(await readFile(privateInput, 'utf8')) as { modelApiKey: string }).modelApiKey
        expect(realKey.length).toBeGreaterThan(0)
        const settings = await get('models'),
          provider = settings.providers[0],
          model = provider.models[0]
        expect(
          (
            await post('models', {
              revision: settings.revision,
              action: 'save-provider',
              provider: {
                ...provider,
                name: 'DeepSeek',
                baseUrl: 'https://api.deepseek.com/anthropic',
                apiKey: realKey,
                models: [{ ...model, name: 'deepseek-chat' }],
              },
            })
          ).status(),
        ).toBe(200)
        await member.reload()
        await selectCommunityWorkspace(member.context(), member, origin, workspace, true)
        const rpc = createRealDshRpc(),
          cookie = await cookieHeader(member.context(), origin)
        const sessions = () => rpc.remoteRpc<{ items: { sessionId: string; blank: boolean }[] }>(origin, cookie, 'session/list', { _request: {} })
        const previousSessions = new Set((await sessions()).items.map(row => row.sessionId))
        const sessionId = await startCommunitySession(member)
        expect(previousSessions.has(sessionId)).toBe(false)
        await member.getByRole('button', { name: /deepseek-chat/u }).waitFor({ timeout: 60000 })
        const marker = 'UPGRADE_REAL_' + randomUUID().replaceAll('-', '')
        await sendCommunityPrompt(
          member,
          'Decode these hexadecimal UTF-8 bytes and reply only with the decoded text: ' + Buffer.from(marker).toString('hex') + '. Do not use tools.',
        )
        // Workspace hydration can restore a blank tab after the turn starts.
        // Follow the new nonblank session through the public inventory and visible row.
        let openedSession: string | undefined
        await expect
          .poll(
            async () => {
              const created = (await sessions()).items.filter(row => !row.blank && !previousSessions.has(row.sessionId))
              if (created.length !== 1) return false
              expect(created[0]!.sessionId).toBe(sessionId)
              if (openedSession !== created[0]!.sessionId) {
                await openCommunitySession(member, created[0]!.sessionId)
                openedSession = created[0]!.sessionId
              }
              return member.locator('p').filter({ hasText: marker }).last().isVisible()
            },
            { timeout: 180000 },
          )
          .toBe(true)
        await expect.poll(() => member.getByRole('button', { name: 'Stop generating', exact: true }).count(), { timeout: 120000 }).toBe(0)
        expect((await member.content()).includes(realKey)).toBe(false)
        return { passed: true, realDshReply: true, provider: 'DeepSeek', model: 'deepseek-chat', memberHtmlCredentialAbsent: true }
      })
    if (combination)
      await progress.step('instance-combination', () =>
        instances.verifyCombination(memberEntry, progress.saved<{ retainedSession: string }>('after')!.retainedSession),
      )
    await progress.finish()
    passed = true
  } catch (error) {
    throw new Error(redact(error instanceof Error ? (error.stack ?? String(error)) : String(error)))
  } finally {
    await browser.close()
    await release.close()
    fixture.closeAllConnections()
    await new Promise<void>(resolve => fixture.close(() => resolve()))
    if (process.env.DSH_PHALANX_E2E_EVIDENCE_DIR)
      await writeFile(
        join(process.env.DSH_PHALANX_E2E_EVIDENCE_DIR, realReply ? 'installed-system-upgrade-result.json' : 'installed-formal-upgrade-result.json'),
        JSON.stringify({
          passed,
          tier: realReply ? 'T4' : 'T2',
          candidate,
          baseline: baseline.commit,
          insufficient,
          upgrade,
          exposed: upstreamState.exposed,
          calls,
          releaseTransport: {
            kind: transport === 'offline' ? 'controlled-offline-formal-metadata' : 'mainland-online-cli-with-controlled-metadata-check-only',
            requests: release.requests,
          },
          previousUpdaterCheck: progress.saved('previous-updater-check'),
          updaterBootstrap: progress.saved('updater-bootstrap') ?? null,
          updaterCheck: progress.saved('updater-check') ?? null,
          imageTransition: progress.saved('image-transition'),
          enter: progress.saved('enter'),
          retainedData: progress.saved('after'),
          deploymentInputs: progress.saved('deployment-inputs'),
          instanceCombination: combination ? progress.saved('instance-combination') : 'T2 formal upgrade only',
          realReply: realReply ? progress.saved('real-reply') : 'T4 only',
          resume: progress.report(),
        }) + '\n',
      )
  }
}
