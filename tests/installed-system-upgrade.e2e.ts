// Validation: T4 isolated host; real credentials: SSH access to the owned validation VM; a provider key for the post-upgrade reply. Never run on a live deployment.
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { skillZip } from './fixtures/skills/archive.js'
import { installedReleaseFixture } from './support/installed-release-fixture.js'
import { acceptanceProgress } from './support/acceptance-progress.js'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { execFileText } from '../src/adapters/runtime-command.js'
import { createRealDshRpc, cookieHeader } from './support/real-dsh-rpc.js'
import { latestHumanText, streamText, streamToolCall, hasToolResult } from './support/real-dsh-model.js'
import { signInCommunity, selectCommunityWorkspace, openCommunitySession, startCommunitySession, sendCommunityPrompt } from './fixtures/community-native-browser.js'

it('upgrades the formal installed OS service while preserving manual MCP grants, selections and member data', async () => {
  const origin = process.env.DSH_PHALANX_OS_ORIGIN, address = process.env.DSH_PHALANX_OS_FIXTURE_ADDRESS
  const ssh = JSON.parse(process.env.DSH_PHALANX_OS_SSH_ARGS ?? 'null') as string[] | null
  const bundle = process.env.DSH_PHALANX_OS_BUNDLE, installer = process.env.DSH_PHALANX_OS_INSTALLER
  const releaseBundle = process.env.DSH_PHALANX_OS_RELEASE_BUNDLE
  const candidate = process.env.DSH_PHALANX_CANDIDATE_SHA, tag = process.env.DSH_PHALANX_CANDIDATE_TAG
  if (!origin || !address || !ssh?.length || !candidate || !tag || !/^run-[1-9]\d*$/u.test(tag) || !bundle || !installer || !releaseBundle || ![bundle, installer].every(path => /^\/[a-zA-Z0-9/_.-]+$/u.test(path))) throw Error('Requires an isolated formal baseline VM, exact candidate bundle and protected SSH configuration')
  const remote = async (command: string, timeout = 120000, acceptedExitCodes = [0]) => {
    try { return await execFileText('ssh', [...ssh, `cd / && ${command}`], { timeout, maxBuffer: 4 * 1024 * 1024, acceptedExitCodes }) }
    catch (error) {
      if (error instanceof Error && 'killed' in error && error.killed === true) throw new Error(`Acceptance SSH command exceeded its ${timeout}ms budget: ${String(error)}`)
      throw error
    }
  }
  const targetVersion = (JSON.parse(await readFile('package.json', 'utf8')) as { version: string }).version
  const baselineVersion = '0.1.18'
  const baseline = JSON.parse(await readFile(`releases/acceptance/${baselineVersion}.json`, 'utf8')) as { commit: string, platformSha256: string, imageDigest: string }
  const versions = JSON.parse(await readFile('runtime-versions.json', 'utf8')) as { dsh: { revision: string } }
  const progress = await acceptanceProgress(process.env.DSH_PHALANX_ACCEPTANCE_PROGRESS ??
    join(process.env.DSH_PHALANX_E2E_EVIDENCE_DIR ?? tmpdir(), 'installed-upgrade-progress.json'),
    { candidate, tag, host: (await remote('cat /etc/machine-id')).trim(), baseline: baseline.commit },
    ['release-source', 'fixture', 'baseline', 'configure', 'before', 'previous-updater-check', 'capacity', 'image-transition', 'upgrade', 'after', 'real-reply'], process.env.DSH_PHALANX_ACCEPTANCE_RESUME)
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
      expect(policy.compatibility.sourceDshRevisions).toContain(before.versions.dsh.revision)
      return before as { commit: string; versions: { dsh: { revision: string } } }
    })
    const { memberEntry, beforeAccounts, beforeLibrary, beforeGrants, beforeSelection, beforeDependencies, beforeSkills, beforeSkillGrants, groupId } = await progress.step('configure', async () => {
      credential = (await remote('sudo cat /var/lib/dsh-phalanx/data/bootstrap-credential')).trim().split(/\s/u)[0]!
      expect((await admin.request.post(origin + '/bootstrap', { headers: { origin }, form: { credential, username: 'admin', password: 'password' }, maxRedirects: 0 })).status()).toBe(303)
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
      const grantPath = `groups/${groupId}/skills`, grant = await get(grantPath)
      expect((await post(grantPath, { action: 'save', names: ['retained-skill'], revision: grant.revision, confirmed: true })).status()).toBe(200)
      const beforeDependencies = await get('runtime-dependencies'), beforeSkills = await get('skills'), beforeSkillGrants = await get(grantPath)
      const beforeAccounts = await get('accounts'), beforeLibrary = await get('mcp'), beforeGrants = await get(`groups/${groupId}/mcp`)
      const beforeSelection = await (await member.request.get(origin + '/market/api/mcp')).json()
      return { memberEntry, beforeAccounts, beforeLibrary, beforeGrants, beforeSelection, beforeDependencies, beforeSkills, beforeSkillGrants, groupId: groupId as string }
    })
    const rpc = createRealDshRpc(), call = async (marker: string) => {
      const cookie = await cookieHeader(member.context(), origin)
      const session = await rpc.remoteRpc<{ sessionId: string }>(origin, cookie, 'session/create', { request: { cwd: '/dsh-phalanx/workspace' } })
      await rpc.remoteRpc(origin, cookie, 'session/prompt', { request: { requestId: randomUUID(), sessionId: session.sessionId, mode: 'queue', content: [{ type: 'text', text: marker }] } })
      await expect.poll(() => calls[marker], { timeout: 300000 }).toEqual({ failed: false, valid: true, tools: ['mcp__p-managed__echo', 'mcp__p-selected__echo'] })
    }
    const { originalPid, beforeCalls, beforeExposed } = await progress.step('before', async () => {
      await signInCommunity(member, origin, 'member', 'password')
      await call('BEFORE_OS_UPGRADE')
      await remote("sudo -u dsh-phalanx sh -c 'printf MEMBER_DATA_PRESERVED > /var/lib/dsh-phalanx/data/users/member/home/upgrade-owned.txt'")
      const pidCommand = 'sudo -u dsh-phalanx env XDG_RUNTIME_DIR=/run/user/$(id -u dsh-phalanx) systemctl --user show dsh-phalanx.service -p MainPID --value'
      const originalPid = (await remote(pidCommand)).trim(); expect(Number(originalPid)).toBeGreaterThan(0)
      return { originalPid, beforeCalls: { ...calls }, beforeExposed: exposed }
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
    await progress.step('image-transition', async () => {
      expect(release.manifest.image.digest).not.toBe(baseline.imageDigest)
      expect((await remote(`sudo -u dsh-phalanx env XDG_RUNTIME_DIR=/run/user/$(id -u dsh-phalanx) podman image inspect ghcr.io/dake6767/dsh-phalanx@${baseline.imageDigest} --format '{{.Digest}}'`)).trim()).toBe(baseline.imageDigest)
      expect((await remote(pidCommand)).trim()).toBe(originalPid)
      return { sameDigest: false, sourceDigest: baseline.imageDigest, targetDigest: release.manifest.image.digest, imagePreloadedByHarness: false, executorBootstrappedByHarness: false }
    })
    upgrade = await progress.step('upgrade', async () => {
      expect((await admin.request.post(origin + '/login', { headers: { origin }, form: { username: 'admin', password: 'password' }, maxRedirects: 0 })).status()).toBe(303)
      await admin.goto(origin + '/admin/settings')
      const panel = admin.getByRole('region', { name: 'System update', exact: true })
      await admin.getByRole('button', { name: 'Check for updates', exact: true }).click()
      await panel.getByText('Formal update available: v' + targetVersion, { exact: true }).waitFor()
      await panel.getByRole('button', { name: 'Download update', exact: true }).click()
      await panel.getByText('Downloaded and verified; ready to apply.', { exact: true }).waitFor({ timeout: 1800000 })
      const prepared = (await get('system-update')).operation
      expect(prepared).toMatchObject({ phase: 'prepared', sourceVersion: baselineVersion, targetVersion, targetCommit: candidate })
      await panel.getByRole('button', { name: 'Apply update', exact: true }).click()
      await admin.getByRole('dialog', { name: 'Apply update: ' + targetVersion, exact: true }).getByRole('button', { name: 'Confirm and apply now', exact: true }).click()
      await panel.getByText('Update completed successfully.', { exact: true }).waitFor({ timeout: 1800000 })
      await expect.poll(async () => (await get('system-update?operation=' + prepared.id)).operation?.cleanup?.status, { timeout: 120000 }).toBe('succeeded')
      const operation = (await get('system-update?operation=' + prepared.id)).operation
      expect(operation).toMatchObject({ id: prepared.id, phase: 'succeeded', sourceVersion: baselineVersion, targetVersion, targetCommit: candidate, cleanup: { status: 'succeeded' } })
      return operation
    })
    await progress.step('after', async () => {
      const after = JSON.parse(await remote('sudo cat /opt/dsh-phalanx/current/build-info.json'))
      expect(after.commit).toBe(candidate); expect(after.versions.dsh.revision).toBe(versions.dsh.revision)
      await admin.context().clearCookies(); await member.context().clearCookies()
      expect((await admin.request.post(origin + '/login', { headers: { origin }, form: { username: 'admin', password: 'password' }, maxRedirects: 0 })).status()).toBe(303)
      await signInCommunity(member, origin, 'member', 'password'); expect(new URL(member.url()).pathname).toBe(memberEntry)
      expect(await get('runtime-dependencies')).toEqual(beforeDependencies)
      expect(await get('skills')).toEqual(beforeSkills)
      expect(await get(`groups/${groupId}/skills`)).toEqual(beforeSkillGrants)
      expect((await get('suites')).installations).toEqual([])
      expect(release.requests.some(url => url.endsWith('.oci.tar'))).toBe(true)
      expect((await remote(`sudo -u dsh-phalanx env XDG_RUNTIME_DIR=/run/user/$(id -u dsh-phalanx) podman image inspect ghcr.io/dake6767/dsh-phalanx@${release.manifest.image.digest} --format '{{.Digest}}'`)).trim()).toBe(release.manifest.image.digest)
      expect(await get('accounts')).toEqual(beforeAccounts)
      expect(await get('mcp')).toEqual(beforeLibrary)
      expect(await get(`groups/${groupId}/mcp`)).toEqual(beforeGrants)
      expect(await (await member.request.get(origin + '/market/api/mcp')).json()).toEqual(beforeSelection)
      expect(await remote('sudo cat /var/lib/dsh-phalanx/data/users/member/home/upgrade-owned.txt')).toBe('MEMBER_DATA_PRESERVED')
      await call('AFTER_OS_UPGRADE')
      expect(await member.getByRole('button', { name: 'Service preview', exact: true }).count()).toBe(0)
      expect(exposed).toBe(false)
      expect((await get('mcp/catalog')).map((row: { id: string }) => row.id).sort()).toEqual(['12306', 'amap'])
      return null
    })
    await progress.step('real-reply', async () => {
      expect((await admin.request.post(origin + '/login', { headers: { origin }, form: { username: 'admin', password: 'password' }, maxRedirects: 0 })).status()).toBe(303)
      await signInCommunity(member, origin, 'member', 'password')
      const privateInput = process.env.DSH_PHALANX_UPGRADE_REAL_INPUT
      if (!privateInput) throw Error('A protected provider input is required for the post-upgrade real DSH reply')
      realKey = (JSON.parse(await readFile(privateInput, 'utf8')) as { modelApiKey: string }).modelApiKey
      expect(realKey.length).toBeGreaterThan(0)
      const settings = await get('models'), provider = settings.providers[0], model = provider.models[0]
      expect((await post('models', { revision: settings.revision, action: 'save-provider', provider: { ...provider, name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/anthropic', apiKey: realKey, models: [{ ...model, name: 'deepseek-chat' }] } })).status()).toBe(200)
      await member.reload()
      await selectCommunityWorkspace(member.context(), member, origin, '/dsh-phalanx/home/Documents/deepseek-harness/default-workspace', true)
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
    await progress.finish()
    passed = true
  } catch (error) {
    throw new Error([credential, realKey].filter(Boolean).reduce((text, secret) => text.replaceAll(secret, '[redacted]'), String(error)))
  } finally {
    await browser.close(); await release.close(); fixture.closeAllConnections(); await new Promise<void>(resolve => fixture.close(() => resolve()))
    if (process.env.DSH_PHALANX_E2E_EVIDENCE_DIR) await writeFile(join(process.env.DSH_PHALANX_E2E_EVIDENCE_DIR, 'installed-system-upgrade-result.json'), JSON.stringify({ passed, candidate, baseline: baseline.commit, insufficient, upgrade, exposed, calls, releaseTransport: { kind: 'controlled-offline-formal-metadata', requests: release.requests }, previousUpdaterCheck: progress.saved('previous-updater-check'), imageTransition: progress.saved('image-transition'), realReply: progress.saved('real-reply'), resume: progress.report() }) + '\n')
  }
}, 5400000)
