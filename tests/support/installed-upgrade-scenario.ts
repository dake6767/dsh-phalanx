import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { chromium } from 'playwright'
import { expect } from 'vitest'
import { skillZip } from '../fixtures/skills/archive.js'
import { signInCommunity, selectCommunityWorkspace, openCommunitySession, startCommunitySession, sendCommunityPrompt } from '../fixtures/community-native-browser.js'
import { installedReleaseFixture } from './installed-release-fixture.js'
import { acceptanceProgress } from './acceptance-progress.js'
import { createRealDshRpc, cookieHeader } from './real-dsh-rpc.js'
import { latestHumanText, streamText, streamToolCall, hasToolResult } from './real-dsh-model.js'
import type { CommunityRuntimeDependencyView, CommunityUsageRecords, CommunityAccountsPageData, CommunitySkillView } from '../../src/domain/admin-contract.js'
import { formalUpgradeScope } from '../../scripts/validation/formal-baseline.mjs'
import { downloadSourcePresets } from '../../src/domain/download-source.js'
import { installedInstanceAcceptance } from './upgrade-instance-combination.js'
import { instanceWorkspacePath } from './real-dsh-runtime.js'

// A different runtime image regenerates artifacts. Preserve the definition and
// usable output, rather than its preparation timestamp, transcript or random ID.
function retainedDependencyState(rows: readonly CommunityRuntimeDependencyView[]) {
  return rows.map(({ updatedAt, log, current, ...definition }) => {
    void updatedAt; void log
    if (!current) return definition
    const { id, ...artifact } = current; void id
    return { ...definition, current: artifact }
  })
}

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
  const source = (JSON.parse(await readFile('release-policy.json', 'utf8')) as { compatibility: { source: { min: string, maxExclusive: string } } }).compatibility.source
  const scope = formalUpgradeScope(await readdir('releases/acceptance'), targetVersion, source)
  if (!scope.upgrade || scope.previous === undefined) throw Error(`Version ${targetVersion} has no formal previous release to upgrade from`)
  const baselineVersion = scope.previous
  const baseline = JSON.parse(await readFile(`releases/acceptance/${baselineVersion}.json`, 'utf8')) as { commit: string, platformSha256: string, imageDigest: string }
  const versions = JSON.parse(await readFile('runtime-versions.json', 'utf8')) as { dsh: { revision: string } }
  const progress = await acceptanceProgress(process.env.DSH_PHALANX_ACCEPTANCE_PROGRESS ??
    join(process.env.DSH_PHALANX_E2E_EVIDENCE_DIR ?? tmpdir(), 'installed-upgrade-progress.json'),
    { candidate, tag, host: (await remote('cat /etc/machine-id')).trim(), baseline: baseline.commit, transport, scenario: '023-native-plugins-and-saved-instance-controls-v1' },
    ['release-source', 'fixture', 'baseline', 'deployment-inputs', 'configure', 'before', 'previous-updater-check', 'capacity', 'image-transition', 'upgrade', 'after', ...(realReply ? ['real-reply'] : []), ...(combination ? ['instance-combination'] : [])], process.env.DSH_PHALANX_ACCEPTANCE_RESUME)
  const release = await installedReleaseFixture(releaseBundle, candidate, tag, progress.saved<{ port: number }>('release-source')?.port)
  await progress.step('release-source', async () => ({ port: release.port }))
  const releasePrefix = `http://${address}:${release.port}/`
  const calls: Record<string, { failed: boolean, valid: boolean, tools: string[] }> = {}
  let exposed = false, passed = false, credential = '', realKey = ''
  const fixture = createServer(async (request, response) => {
    if (request.method !== 'POST') { response.writeHead(405); response.end(); return }
    let text = ''; for await (const chunk of request) text += chunk
    const body = JSON.parse(text)
    if (request.url === '/mcp') {
      if (request.headers.authorization !== 'Bearer fictional-upgrade-mcp-key') { response.writeHead(401); response.end(); return }
      response.setHeader('content-type', 'application/json')
      if (body.id === undefined) { response.writeHead(202); response.end(); return }
      const result = body.method === 'initialize' ? { protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'upgrade-fixture', version: '1' } }
        : body.method === 'tools/list' ? { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] }
          : { content: [{ type: 'text', text: 'MANUAL_MCP_PRESERVED' }] }
      response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result })); return
    }
    const marker = latestHumanText(body); exposed ||= text.includes('fictional-upgrade-mcp-key')
    response.setHeader('content-type', 'text/event-stream')
    if (hasToolResult(body, marker, false) || hasToolResult(body, marker, true)) {
      calls[marker] = { failed: hasToolResult(body, marker, true), valid: text.includes('MANUAL_MCP_PRESERVED'), tools: (body.tools ?? []).map((tool: { name: string }) => tool.name).filter((name: string) => name.startsWith('mcp__')).sort() }
      streamText(response, 'UPGRADE_QUERY_DONE')
    } else streamToolCall(response, marker, 'mcp__p-selected__echo', {})
  })
  fixture.listen(progress.saved<{ port: number }>('fixture')?.port ?? 0, '0.0.0.0'); await once(fixture, 'listening')
  await progress.step('fixture', async () => ({ port: (fixture.address() as { port: number }).port }))
  const upstream = `http://${address}:${(fixture.address() as { port: number }).port}`
  const browser = await chromium.launch({ headless: true }), admin = await browser.newPage({ locale: 'en' }), member = await browser.newPage({ locale: 'en' })
  admin.setDefaultTimeout(120000); member.setDefaultTimeout(120000)
  const get = async (path: string) => { const response = await admin.request.get(origin + '/admin/api/' + path); expect(response.status()).toBe(200); return response.json() }
  const post = (path: string, data: object) => admin.request.post(origin + '/admin/api/' + path, { headers: { origin }, data })
  const instances = installedInstanceAcceptance({ origin, remote, admin, member })
  let upgrade: unknown, insufficient: unknown
  try {
    await progress.step('baseline', async () => {
      const before = JSON.parse(await remote('sudo cat /opt/dsh-phalanx/current/build-info.json'))
      expect(before.commit).toBe(baseline.commit)
      const receipt = JSON.parse(await remote('sudo cat /etc/dsh-phalanx/install-state.json'))
      expect(receipt).toMatchObject({ version: 'v' + baselineVersion, commit: baseline.commit, platformSha256: baseline.platformSha256, imageDigest: baseline.imageDigest })
      const installedManifest = JSON.parse(await remote('sudo cat /etc/dsh-phalanx/installed-manifest.json'))
      expect(installedManifest).toMatchObject({ commit: baseline.commit, targetVersion: baselineVersion, image: { digest: baseline.imageDigest }, files: { 'dsh-phalanx-linux-amd64.tar.gz': baseline.platformSha256 } })
      expect((await remote('sudo cat /opt/dsh-phalanx/current/.artifact-sha256')).trim()).toBe(baseline.platformSha256)
      expect(baseline.imageDigest).toMatch(/^sha256:[a-f0-9]{64}$/u)
      expect((await remote(`sudo -u dsh-phalanx env XDG_RUNTIME_DIR=/run/user/$(id -u dsh-phalanx) podman image inspect ghcr.io/dake6767/dsh-phalanx@${baseline.imageDigest} --format '{{.Digest}}'`)).trim()).toBe(baseline.imageDigest)
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
      expect((await admin.request.post(origin + '/bootstrap', { headers: { origin }, form: { credential, username: 'admin', password: 'password' }, maxRedirects: 0 })).status()).toBe(303)
      return instances.prepareBaseline(transport === 'offline')
    })
    const { memberEntry, beforeAccounts, beforeLibrary, beforeGrants, beforeSelection, beforeDependencies, beforeSkills, beforeSkillGrants, beforePacks, beforePackSelections, beforeAdministratorSkills, groupId } = await progress.step('configure', async () => {
      expect((await admin.request.post(origin + '/login', { headers: { origin }, form: { username: 'admin', password: 'password' }, maxRedirects: 0 })).status()).toBe(303)
      const settings = await get('models')
      expect((await post('models', { revision: settings.revision, action: 'save-provider', provider: { name: 'Upgrade fixture', baseUrl: upstream + '/anthropic', apiFormat: 'anthropic-messages', apiKey: 'fictional-model-key', enabled: true, models: [{ name: 'fixture-model', enabled: true }] } })).status()).toBe(200)
      const account = await post('accounts', { username: 'member', password: 'password', email: '' }); expect(account.status()).toBe(201)
      const { groupId } = await account.json()
      for (const name of ['p-managed', 'p-selected']) {
        expect((await post('mcp', { action: 'save', service: { name, description: 'Manual retained service', url: upstream + '/mcp', credential: 'fictional-upgrade-mcp-key', headers: [{ name: 'Authorization', value: 'Bearer {credential}' }], disabledTools: [] } })).status()).toBe(200)
        expect((await (await post('mcp/test', { name })).json()).testStatus).toBe('passed')
        expect((await post('mcp', { action: 'publish', name, published: true })).status()).toBe(200)
      }
      expect((await post(`groups/${groupId}/mcp`, { names: ['p-managed'] })).status()).toBe(200)
      await signInCommunity(member, origin, 'member', 'password')
      expect((await member.request.post(origin + '/market/api/mcp', { headers: { origin }, data: { name: 'p-selected', action: 'enable' } })).status()).toBe(200)
      const memberEntry = new URL(member.url()).pathname
      expect((await post('runtime-dependencies', { action: 'create', input: { name: 'retained-tools', prepareCommand: 'mkdir bin; printf "#!/bin/sh\\necho retained\\n" > bin/retained; chmod +x bin/retained', pathDirectories: ['bin'], checkCommand: 'retained' } })).status()).toBe(202)
      await expect.poll(async () => (await get('runtime-dependencies?name=retained-tools')).stage, { timeout: 300000 }).toBe('ready')
      const upload = await admin.request.post(origin + '/admin/api/skills/upload', { headers: { origin, 'content-type': 'application/zip' }, data: skillZip([{ path: 'SKILL.md', content: '---\nname: retained-skill\ndescription: Existing manual skill\n---\nKeep this manual skill.' }]) })
      expect(upload.status()).toBe(200)
      const preview = await upload.json()
      expect((await post('skills/change', { action: 'confirm', token: preview.token, revision: preview.revision })).status()).toBe(200)
      const detail = await get('skills/detail?name=retained-skill')
      expect((await post('skills/change', { action: 'runtime-dependencies', name: detail.name, names: ['retained-tools'], revision: detail.revision })).status()).toBe(200)
      expect((await post('skills/execution?name=retained-skill', { enabled: true, commands: [{ command: 'retained', blocked: [] }], variables: [], runtimeDependencies: ['retained-tools'] })).status()).toBe(200)
      await expect.poll(async () => (await get('skills/execution?name=retained-skill')).preparation?.stage, { timeout: 300000 }).toBe('ready')
      expect((await post('usage-settings', { retentionDays: 13 })).status()).toBe(200)
      const trial = await post('execution/trial', { owner: 'skill:retained-skill', line: 'retained' })
      expect(trial.status()).toBe(200); expect(await trial.json()).toMatchObject({ exitCode: 0, stdout: 'retained\n' })
      for (const kind of ['managed', 'selected']) {
        const packs = await get('skill-packs')
        expect((await post('skill-packs', { action: 'save', revision: packs.revision, pack: { name: 'retained-pack-' + kind, description: 'Retained workflow', skills: ['retained-skill'], instructions: 'Keep the existing workflow.', published: kind === 'selected' } })).status()).toBe(200)
      }
      const grantPath = `groups/${groupId}/skills`, grant = await get(grantPath)
      expect((await post(grantPath, { action: 'save', names: ['retained-skill'], packs: ['retained-pack-managed'], revision: grant.revision, confirmed: true })).status()).toBe(200)
      expect((await member.request.post(origin + '/market/api/skill-packs', { headers: { origin }, data: { name: 'retained-pack-selected', action: 'install' } })).status()).toBe(200)
      const beforePacks = await get('skill-packs'), beforePackSelections = await (await member.request.get(origin + '/market/api/skill-packs')).json()
      for (const source of ['managed', 'selected']) expect(beforePackSelections.find((row: { name: string }) => row.name === 'retained-pack-' + source)).toMatchObject({ source, skills: ['retained-skill'], instructions: 'Keep the existing workflow.' })
      const beforeDependencies = await get('runtime-dependencies'), beforeSkills = await get('skills') as readonly CommunitySkillView[], beforeSkillGrants = await get(grantPath)
      const administratorGroup = (await get('groups')).find((row: { kind: string }) => row.kind === 'admin')
      const administratorSkills = await get(`groups/${administratorGroup.id}/skills`)
      const beforeAdministratorSkills = administratorSkills.skills.filter((row: { granted: boolean }) => row.granted).map((row: { name: string }) => row.name) as string[]
      const beforeAccounts = await get('accounts'), beforeLibrary = await get('mcp'), beforeGrants = await get(`groups/${groupId}/mcp`)
      const beforeSelection = await (await member.request.get(origin + '/market/api/mcp')).json()
      return { memberEntry, beforeAccounts, beforeLibrary, beforeGrants, beforeSelection, beforeDependencies, beforeSkills, beforeSkillGrants, beforePacks, beforePackSelections, beforeAdministratorSkills, groupId: groupId as string }
    })
    const call = async (marker: string) => {
      await selectCommunityWorkspace(member.context(), member, origin, workspace, true)
      // Native creation records workspace membership; RPC cwd alone leaves a session ungrouped.
      const sessionId = await startCommunitySession(member)
      await sendCommunityPrompt(member, marker)
      await expect.poll(() => calls[marker], { timeout: 300000 }).toEqual({ failed: false, valid: true, tools: ['mcp__p-managed__echo', 'mcp__p-selected__echo'] })
      await member.locator(`[data-conversation-content][data-conversation-session=${JSON.stringify(sessionId)}]:visible`).getByText('UPGRADE_QUERY_DONE', { exact: true }).waitFor()
      return sessionId
    }
    const history = async () => ({ execution: await get('usage-records?username=admin&capability=skill%3Aretained-skill&operation=retained') as CommunityUsageRecords,
      mcp: await get('usage-records?username=member&capability=p-selected&operation=echo') as CommunityUsageRecords })
    const { originalPid, beforeCalls, beforeExposed, beforeUsage, beforeUsageSettings, beforeLimits } = await progress.step('before', async () => {
      await signInCommunity(member, origin, 'member', 'password')
      await call('BEFORE_OS_UPGRADE')
      await member.getByRole('button', { name: 'Platform App Center', exact: true }).waitFor()
      for (const label of ['Usage records', 'Self-reported usage', 'Usage record retention']) expect(await member.getByText(label, { exact: true }).count()).toBe(0)
      await expect.poll(async () => (await history()).execution.items.length).toBe(1)
      await expect.poll(async () => (await history()).mcp.items.length).toBeGreaterThan(0)
      const beforeUsage = await history(), beforeUsageSettings = await get('usage-settings')
      expect(beforeUsageSettings).toEqual({ retentionDays: 13 })
      expect(beforeUsage.execution.items[0]).toMatchObject({ username: 'admin', outcome: 'succeeded', capability: { id: 'skill:retained-skill', operation: 'retained' } })
      if (deploymentInputs.persisted) await instances.assertImported(deploymentInputs)
      else {
        const absentResources = await admin.request.get(origin + '/admin/api/instance-resources')
        expect(absentResources.status()).toBe(404); expect(await absentResources.json()).toMatchObject({ code: 'not-found' })
      }
      const baselineKernel = await instances.kernel()
      instances.assertBaselineLimits(baselineKernel, deploymentInputs)
      const beforeLimits = (await get('execution/settings')).limits

      await remote("sudo -u dsh-phalanx sh -c 'printf MEMBER_DATA_PRESERVED > /var/lib/dsh-phalanx/data/users/member/home/upgrade-owned.txt'")
      const pidCommand = 'sudo -u dsh-phalanx env XDG_RUNTIME_DIR=/run/user/$(id -u dsh-phalanx) systemctl --user show dsh-phalanx.service -p MainPID --value'
      const originalPid = (await remote(pidCommand)).trim(); expect(Number(originalPid)).toBeGreaterThan(0)
      return { originalPid, beforeCalls: { ...calls }, beforeExposed: exposed, beforeUsage, beforeUsageSettings, beforeLimits, baselineKernel }
    })
    Object.assign(calls, beforeCalls); exposed ||= beforeExposed
    const pidCommand = 'sudo -u dsh-phalanx env XDG_RUNTIME_DIR=/run/user/$(id -u dsh-phalanx) systemctl --user show dsh-phalanx.service -p MainPID --value'
    await progress.step('previous-updater-check', async () => {
      expect((await admin.request.post(origin + '/login', { headers: { origin }, form: { username: 'admin', password: 'password' }, maxRedirects: 0 })).status()).toBe(303)
      const sources = await get('download-sources')
      expect((await post('download-sources', { preset: sources.preset, overrides: { ...sources.overrides, githubAssets: releasePrefix, githubApi: releasePrefix } })).status()).toBe(200)
      // This request reaches the unmodified, formally installed executor over its Unix socket.
      const check = await post('system-update', { action: 'check' }); expect(check.status()).toBe(200)
      const result = await check.json()
      expect(result.check).toMatchObject({ status: 'available', version: 'v' + targetVersion })
      expect((await remote(pidCommand)).trim()).toBe(originalPid)
      return { check: result.check, unmodifiedFormalExecutor: true }
    })
    insufficient = await progress.step('capacity', async () => {
      await remote('sudo mkdir -p /var/lib/dsh-phalanx-updater && sudo mount -t tmpfs -o size=8m,mode=700 candidate-capacity /var/lib/dsh-phalanx-updater')
      try {
        insufficient = JSON.parse(await remote(`sudo bash ${installer} --version ${tag} --bundle-dir ${bundle} --upgrade prepare --output json`, 1800000, [1]))
        expect(insufficient).toMatchObject({ status: 'upgrade', operation: { phase: 'prepare-failed', space: { sufficient: false } } })
        expect((await remote(pidCommand)).trim()).toBe(originalPid)
        await remote('sudo test ! -e /etc/dsh-phalanx/maintenance')
      } finally { await remote('sudo umount /var/lib/dsh-phalanx-updater') }
      return insufficient
    })
    // An unchanged image upgrades in place; the image-change path is then not covered, and the receipt says so.
    const sameDigest = release.manifest.image.digest === baseline.imageDigest
    await progress.step('image-transition', async () => {
      expect((await remote(`sudo -u dsh-phalanx env XDG_RUNTIME_DIR=/run/user/$(id -u dsh-phalanx) podman image inspect ghcr.io/dake6767/dsh-phalanx@${baseline.imageDigest} --format '{{.Digest}}'`)).trim()).toBe(baseline.imageDigest)
      expect((await remote(pidCommand)).trim()).toBe(originalPid)
      return { sameDigest, digestChangePathCovered: !sameDigest, uncovered: sameDigest ? ['target-image-absent-before-import', 'dependency-artifact-refresh'] : [], sourceDigest: baseline.imageDigest, targetDigest: release.manifest.image.digest, imagePreloadedByHarness: false, executorBootstrappedByHarness: false }
    })
    upgrade = await progress.step('upgrade', async () => {
      expect((await admin.request.post(origin + '/login', { headers: { origin }, form: { username: 'admin', password: 'password' }, maxRedirects: 0 })).status()).toBe(303)
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
        const online = JSON.parse(await remote(`sudo bash ${installer} --version ${tag} --dev-release-base-url https://github.com/dake6767/dsh-phalanx-candidates/releases --download-source-preset mainland --github-proxy-prefix ${downloadSourcePresets.mainland.githubAssets} --yes --output json`, 3600000))
        expect(online).toMatchObject({ status: 'upgrade', operation: { phase: 'succeeded', sourceVersion: baselineVersion, targetVersion, targetCommit: candidate, cleanup: { status: 'succeeded' } } })
        expect((await remote(pidCommand)).trim()).not.toBe(originalPid)
        expect(Number((await remote(pidCommand)).trim())).toBeGreaterThan(0)
        return { ...online.operation, transport, preset: 'mainland', githubAssets: downloadSourcePresets.mainland.githubAssets, bundleDirUsed: false, imageAbsenceCheckedInThisAttempt: !sameDigest, imageAbsenceSkippedReason: sameDigest ? 'same-digest' : null, imagePreloadedByHarness: false }
      }
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
        expect(offline).toMatchObject({ status: 'upgrade', operation: { phase: 'prepared', sourceVersion: baselineVersion, targetVersion, targetCommit: candidate } })
        prepared = offline.operation
      }
      expect((await remote(pidCommand)).trim()).toBe(originalPid)
      const offlinePreparationId = prepared.id
      // Web only applies formal versions. Select the same verified bytes via
      // the controlled formal metadata after the real CLI imported the archive.
      await panel.getByRole('button', { name: 'Download update', exact: true }).click()
      await expect.poll(async () => {
        const operation = (await get('system-update')).operation
        return operation?.id !== offlinePreparationId && operation?.phase === 'prepared'
      }, { timeout: 1800000 }).toBe(true)
      prepared = (await get('system-update')).operation
      expect(prepared).toMatchObject({ phase: 'prepared', sourceVersion: baselineVersion, targetVersion, targetCommit: candidate, imageDigest: release.manifest.image.digest, platformSha256: release.manifest.files['dsh-phalanx-linux-amd64.tar.gz'] })
      expect((await remote(pidCommand)).trim()).toBe(originalPid)
      // A new administration window follows the formal Web preparation's latest operation,
      // rather than a previously followed Web operation in browser storage.
      const application = await browser.newPage({ locale: 'en' })
      application.setDefaultTimeout(120000)
      try {
        expect((await application.request.post(origin + '/login', { headers: { origin }, form: { username: 'admin', password: 'password' }, maxRedirects: 0 })).status()).toBe(303)
        await application.goto(origin + '/admin/settings')
        const applicationPanel = application.getByRole('region', { name: 'System update', exact: true })
        await applicationPanel.getByText('Downloaded and verified; ready to apply.', { exact: true }).waitFor({ timeout: 1800000 })
        expect((await get('system-update')).operation).toMatchObject({ id: prepared.id, phase: 'prepared', sourceVersion: baselineVersion, targetVersion, targetCommit: candidate })
        await applicationPanel.getByRole('button', { name: 'Apply update', exact: true }).click()
        await application.getByRole('dialog', { name: 'Apply update: ' + targetVersion, exact: true }).getByRole('button', { name: 'Confirm and apply now', exact: true }).click()
        await applicationPanel.getByText('Update completed successfully.', { exact: true }).waitFor({ timeout: 1800000 })
        await expect.poll(async () => (await get('system-update?operation=' + prepared.id)).operation?.cleanup?.status, { timeout: 120000 }).toBe('succeeded')
        const operation = (await get('system-update?operation=' + prepared.id)).operation
        expect(operation).toMatchObject({ id: prepared.id, phase: 'succeeded', sourceVersion: baselineVersion, targetVersion, targetCommit: candidate, cleanup: { status: 'succeeded' } })
        return { ...operation, transport: 'verified-offline-bundle', offlinePreparationId, formalWebPreparationId: prepared.id, imageAbsenceCheckedInThisAttempt: !retainedPreparation && !sameDigest, imageAbsenceSkippedReason: retainedPreparation ? 'retained-preparation' : sameDigest ? 'same-digest' : null, preparationReusedFromFailedAttempt: Boolean(retainedPreparation), archiveSha256: release.manifest.files[archive], webApplied: true }
      } finally { await application.close() }
    })
    await progress.step('after', async () => {
      const after = JSON.parse(await remote('sudo cat /opt/dsh-phalanx/current/build-info.json'))
      expect(after.commit).toBe(candidate); expect(after.versions.dsh.revision).toBe(versions.dsh.revision)
      expect((await remote('sudo cat /opt/dsh-phalanx/current/.artifact-sha256')).trim()).toBe(release.manifest.files['dsh-phalanx-linux-amd64.tar.gz'])
      await admin.context().clearCookies(); await member.context().clearCookies()
      expect((await admin.request.post(origin + '/login', { headers: { origin }, form: { username: 'admin', password: 'password' }, maxRedirects: 0 })).status()).toBe(303)
      await signInCommunity(member, origin, 'member', 'password'); expect(new URL(member.url()).pathname).toBe(memberEntry)
      const importedKernel = await instances.assertImported(deploymentInputs)
      await expect.poll(async () => retainedDependencyState(await get('runtime-dependencies')), { timeout: 300000 }).toEqual(retainedDependencyState(beforeDependencies))
      const dependencies: CommunityRuntimeDependencyView[] = await get('runtime-dependencies')
      // The previous release implicitly counted the administrator as a managed
      // skill user. Library contents and ordinary-member access remain intact;
      // this version deliberately starts the administrator group without grants.
      const administratorGroup = (await get('groups')).find((row: { kind: string }) => row.kind === 'admin')
      const administratorSkills = await get(`groups/${administratorGroup.id}/skills`)
      expect(administratorSkills.skills.filter((row: { granted: boolean }) => row.granted)).toEqual([])
      expect(administratorSkills.packs.filter((row: { granted: boolean }) => row.granted)).toEqual([])
      expect(await get('skills')).toEqual(beforeSkills.map(skill => ({ ...skill,
        managedMembers: skill.managedMembers - (beforeAdministratorSkills.includes(skill.name) ? 1 : 0),
      })))
      expect(await get(`groups/${groupId}/skills`)).toEqual(beforeSkillGrants)
      expect(await get('skill-packs')).toEqual(beforePacks)
      expect(await (await member.request.get(origin + '/market/api/skill-packs')).json()).toEqual(beforePackSelections)
      expect((await get('suites')).installations).toEqual([])
      expect(release.requests.some(url => url.endsWith('.oci.tar'))).toBe(false)
      expect((await remote(`sudo -u dsh-phalanx env XDG_RUNTIME_DIR=/run/user/$(id -u dsh-phalanx) podman image inspect ghcr.io/dake6767/dsh-phalanx@${release.manifest.image.digest} --format '{{.Digest}}'`)).trim()).toBe(release.manifest.image.digest)
      const upgradedAccounts = await get('accounts') as CommunityAccountsPageData
      const retainedAccounts = { ...upgradedAccounts, items: upgradedAccounts.items.map(({ instance, ...account }) => {
        expect(instance.resourcePending).toBe(false)
        if (deploymentInputs.persisted) return { ...account, instance }
        const { resourcePending, ...originalInstance } = instance; void resourcePending
        return { ...account, instance: originalInstance }
      }) }
      expect(retainedAccounts).toEqual(beforeAccounts)
      expect(await get('mcp')).toEqual(beforeLibrary)
      expect(await get(`groups/${groupId}/mcp`)).toEqual(beforeGrants)
      expect(await (await member.request.get(origin + '/market/api/mcp')).json()).toEqual(beforeSelection)
      expect(await remote('sudo cat /var/lib/dsh-phalanx/data/users/member/home/upgrade-owned.txt')).toBe('MEMBER_DATA_PRESERVED')
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
      const adminGrantPath = `groups/${adminGroup.id}/skills`, adminGrant = await get(adminGrantPath)
      expect((await post(adminGrantPath, { action: 'save', names: ['retained-skill'], revision: adminGrant.revision, confirmed: true })).status()).toBe(200)
      const trial = async () => { const response = await post('execution/trial', { owner: 'skill:retained-skill', line: 'retained' }); expect(response.status()).toBe(200); expect(await response.json()).toMatchObject({ exitCode: 0, stdout: 'retained\n' }) }
      await trial()
      await call('AFTER_OS_UPGRADE')
      expect((await post('usage-settings', { retentionDays: 7 })).status()).toBe(200)
      await remote('sudo -u dsh-phalanx env XDG_RUNTIME_DIR=/run/user/$(id -u dsh-phalanx) systemctl --user restart dsh-phalanx.service', 300000)
      await expect.poll(async () => { try { return (await fetch(origin + '/login')).status } catch { return 0 } }, { timeout: 300000 }).toBe(200)
      await admin.context().clearCookies(); await member.context().clearCookies()
      expect((await admin.request.post(origin + '/login', { headers: { origin }, form: { username: 'admin', password: 'password' }, maxRedirects: 0 })).status()).toBe(303)
      await signInCommunity(member, origin, 'member', 'password')
      expect(await get('usage-settings')).toEqual({ retentionDays: 7 })
      await assertHistory(); await trial(); const retainedSession = await call('AFTER_RECORDS_RESTART')
      await member.getByRole('button', { name: 'Platform App Center', exact: true }).waitFor()
      for (const label of ['Usage records', 'Self-reported usage', 'Usage record retention']) expect(await member.getByText(label, { exact: true }).count()).toBe(0)

      expect(await member.getByRole('button', { name: 'Service preview', exact: true }).count()).toBe(0)
      expect(exposed).toBe(false)
      expect((await get('mcp/catalog')).map((row: { id: string }) => row.id).sort()).toEqual(['12306', 'amap'])
      return { retainedSession, importedKernel, usageExecutionRecordsPreserved: beforeUsage.execution.items.length, usageMcpRecordsPreserved: beforeUsage.mcp.items.length, usageRecordIdsAndFieldsPreserved: true, originalRetentionDays: beforeUsageSettings.retentionDays, restartRetentionDays: 7, historyStableAcrossRestart: true, executionLimitsPreserved: true, executionTrialsPassed: true, memberUiUnchanged: true, manualDependenciesPreserved: true, dependencyImageRefreshObserved: dependencies.some((row, index) => row.current?.id !== (beforeDependencies as CommunityRuntimeDependencyView[])[index]?.current?.id), skillsAndGrantsPreserved: true, skillPacksPreserved: true, accountsAndMcpPreserved: true, memberFilePreserved: true }
    })
    if (realReply) await progress.step('real-reply', async () => {
      expect((await admin.request.post(origin + '/login', { headers: { origin }, form: { username: 'admin', password: 'password' }, maxRedirects: 0 })).status()).toBe(303)
      await signInCommunity(member, origin, 'member', 'password')
      const privateInput = process.env.DSH_PHALANX_UPGRADE_REAL_INPUT
      if (!privateInput) throw Error('A protected provider input is required for the post-upgrade real DSH reply')
      realKey = (JSON.parse(await readFile(privateInput, 'utf8')) as { modelApiKey: string }).modelApiKey
      expect(realKey.length).toBeGreaterThan(0)
      const settings = await get('models'), provider = settings.providers[0], model = provider.models[0]
      expect((await post('models', { revision: settings.revision, action: 'save-provider', provider: { ...provider, name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/anthropic', apiKey: realKey, models: [{ ...model, name: 'deepseek-chat' }] } })).status()).toBe(200)
      await member.reload()
      await selectCommunityWorkspace(member.context(), member, origin, workspace, true)
      const rpc = createRealDshRpc(), cookie = await cookieHeader(member.context(), origin)
      const sessions = () => rpc.remoteRpc<{ items: { sessionId: string; blank: boolean }[] }>(origin, cookie, 'session/list', { _request: {} })
      const previousSessions = new Set((await sessions()).items.map(row => row.sessionId))
      const sessionId = await startCommunitySession(member)
      expect(previousSessions.has(sessionId)).toBe(false)
      await member.getByRole('button', { name: /deepseek-chat/u }).waitFor({ timeout: 60000 })
      const marker = 'UPGRADE_REAL_' + randomUUID().replaceAll('-', '')
      await sendCommunityPrompt(member, 'Decode these hexadecimal UTF-8 bytes and reply only with the decoded text: ' + Buffer.from(marker).toString('hex') + '. Do not use tools.')
      // Workspace hydration can restore a blank tab after the turn starts.
      // Follow the new nonblank session through the public inventory and visible row.
      let openedSession: string | undefined
      await expect.poll(async () => {
        const created = (await sessions()).items.filter(row => !row.blank && !previousSessions.has(row.sessionId))
        if (created.length !== 1) return false
        expect(created[0]!.sessionId).toBe(sessionId)
        if (openedSession !== created[0]!.sessionId) {
          await openCommunitySession(member, created[0]!.sessionId)
          openedSession = created[0]!.sessionId
        }
        return member.locator('p').filter({ hasText: marker }).last().isVisible()
      }, { timeout: 180000 }).toBe(true)
      await expect.poll(() => member.getByRole('button', { name: 'Stop generating', exact: true }).count(), { timeout: 120000 }).toBe(0)
      expect((await member.content()).includes(realKey)).toBe(false)
      return { passed: true, realDshReply: true, provider: 'DeepSeek', model: 'deepseek-chat', memberHtmlCredentialAbsent: true }
    })
    if (combination) await progress.step('instance-combination', () => instances.verifyCombination(memberEntry, progress.saved<{ retainedSession: string }>('after')!.retainedSession))
    await progress.finish()
    passed = true
  } catch (error) {
    throw new Error([credential, realKey].filter(Boolean).reduce((text, secret) => text.replaceAll(secret, '[redacted]'), error instanceof Error ? error.stack ?? String(error) : String(error)))
  } finally {
    await browser.close(); await release.close(); fixture.closeAllConnections(); await new Promise<void>(resolve => fixture.close(() => resolve()))
    if (process.env.DSH_PHALANX_E2E_EVIDENCE_DIR) await writeFile(join(process.env.DSH_PHALANX_E2E_EVIDENCE_DIR, realReply ? 'installed-system-upgrade-result.json' : 'installed-formal-upgrade-result.json'), JSON.stringify({ passed, tier: realReply ? 'T4' : 'T2', candidate, baseline: baseline.commit, insufficient, upgrade, exposed, calls, releaseTransport: { kind: transport === 'offline' ? 'controlled-offline-formal-metadata' : 'mainland-online-cli-with-controlled-metadata-check-only', requests: release.requests }, previousUpdaterCheck: progress.saved('previous-updater-check'), imageTransition: progress.saved('image-transition'), retainedData: progress.saved('after'), deploymentInputs: progress.saved('deployment-inputs'), instanceCombination: combination ? progress.saved('instance-combination') : 'T2 formal upgrade only', realReply: realReply ? progress.saved('real-reply') : 'T4 only', resume: progress.report() }) + '\n')
  }
}
