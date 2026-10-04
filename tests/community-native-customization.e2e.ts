import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { chromium, type Browser } from 'playwright'
import { afterEach, expect, it } from 'vitest'
import { parseDocument } from 'yaml'
import { candidateApplication } from './support/candidate-application.js'
import { FileCommunityModelAccess } from '../src/adapters/community-model-access.js'
import { CommunityAccountStore } from '../src/adapters/community-account-store.js'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import type { CommunityApplication } from '../src/ports/community-application.js'
import type { CommunityRuntimeConfig } from '../src/domain/community-config.js'
import { assertPinnedDshRevision, runtimeSection, defaultWorkspacePath, instanceWorkspacePath } from './support/real-dsh-runtime.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { newValidationContext, saveBrowserEvidence } from './fixtures/browser-evidence.js'
import { signInCommunity, selectCommunityWorkspace, runCommunityTerminal, sendCommunityTerminal } from './fixtures/community-native-browser.js'
import { dshHomePath, dshProfilesPath, dshWebProfilePath, DSH_PATCH_CONFIG, DSH_CONTAINER_HOME } from '../src/dsh/profile-layout.js'
import { startCommunityModel } from './fixtures/community-model.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import type { CommunityModelSettings } from '../src/domain/admin-contract.js'
import { cookieHeader, createRealDshRpc } from './support/real-dsh-rpc.js'
import { communityEntryUrl } from './support/community-space.js'

let root: string | undefined
let application: CommunityApplication | undefined
let runtime: CommunityRuntimeConfig | undefined
let browser: Browser | undefined
let model: Awaited<ReturnType<typeof startCommunityModel>> | undefined
afterEach(async test => {
  await saveBrowserEvidence(test); model?.release(); await browser?.close(); await application?.stop()
  if (runtime !== undefined) await new CommunityRuntimeDriver(runtime).rebuild()
  await model?.close(); if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined; application = undefined; runtime = undefined; browser = undefined; model = undefined
})
it('keeps shared model selections and an installed network plugin usable across restart', async () => {
  const personal = process.env.DSH_PHALANX_E2E_PERSONAL_UPSTREAM
  if (personal === undefined) throw new Error('A controlled public personal upstream is required')
  assertPinnedDshRevision(runtimeSettings)
  root = await mkdtemp(join(tmpdir(), 'community-native-customization-'))
  model = await startCommunityModel(); runtime = runtimeSection(root, model.origin, runtimeSettings)
  const config = { listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'community-native-settings-session-secret-32-bytes', runtime,
    network: { hostPublicAddresses: process.env.DSH_PHALANX_E2E_HOST_PUBLIC_ADDRESSES?.split(',') ?? [] },
    modelGateway: { upstreamApiKey: 'community-provider-fixture-key' } }
  application = candidateApplication(config)
  const accounts = new CommunityAccountStore(join(root, 'community-accounts.db'))
  try { for (const username of ['alice', 'bob']) await accounts.create({ username, email: `${username}@example.test`, password: 'password' }) } finally { accounts.close() }
  const origin = await application.start(); browser = await chromium.launch({ headless: true })
  const enter = async (username: string, entryOrigin: string) => {
    const context = await newValidationContext(browser!); const page = await context.newPage()
    const closedSockets: string[] = []
    page.on('websocket', socket => { socket.on('close', () => { closedSockets.push(socket.url()) }) })
    await signInCommunity(page, entryOrigin, username, 'password')
    await selectCommunityWorkspace(context, page, entryOrigin, instanceWorkspacePath(defaultWorkspacePath(root!, username), runtime!.container !== undefined), runtime!.container !== undefined)
    return { context, page, username, closedSockets }
  }
  const newSession = async (world: Awaited<ReturnType<typeof enter>>) => {
    await world.page.getByRole('button', { name: 'New session', exact: true }).first().click()
    await world.page.getByText('Into the Unknown', { exact: true }).waitFor()
    if (world.username === 'bob') {
      await world.page.getByRole('button', { name: /deepseek-chat/u }).click()
      await world.page.getByRole('menuitem', { name: /^Model/u }).click()
      await world.page.getByRole('menuitemradio', { name: /personal-model/u }).click()
    }
  }
  const alice = await enter('alice', origin); const bob = await enter('bob', origin)
  const { page } = bob
  const bootstrap = await fetch(`${origin}/bootstrap`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ credential: readBootstrapCredential(root)!.credential, username: 'admin', password: 'password' }) })
  const cookie = bootstrap.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  const saved = await fetch(`${origin}/admin/api/models`, { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify({
    revision: 0, action: 'save-provider', provider: { name: 'Shared personal fixture', baseUrl: personal, apiFormat: 'anthropic-messages', apiKey: 'personal-fixture-key', enabled: true,
      models: [{ name: 'personal-model', enabled: true }] },
  }) })
  expect(saved.status).toBe(200)
  const settings = await saved.json() as CommunityModelSettings
  const sharedId = settings.providers.find(provider => provider.name === 'Shared personal fixture')!.models[0]!.id
  const bobCookie = await cookieHeader(bob.context, origin)
  const rpc = createRealDshRpc()
  const plugins = await rpc.remoteRpc<{ entryId: string, localId: string, moduleName: string, fiberPhase: string, readOnlyReason?: string }[]>(origin, bobCookie, 'pluginManager/listPlugins', {})
  const platform = plugins.find(row => row.moduleName.endsWith('/platform-plugin/plugin.mjs'))!
  expect(platform?.fiberPhase).toBe('active'); expect(platform.readOnlyReason).toBe('unaddressable')
  const disabled = await rpc.remoteRpc<{ changed: boolean, application: string }>(origin, bobCookie, 'pluginManager/setPluginEnabled', { id: platform.entryId, enabled: false })
  expect(disabled.changed).toBe(false); expect(disabled.application).toBe('failed')
  const removed = await rpc.remoteRpc<{ application: string }>(origin, bobCookie, 'pluginManager/removeBundle', { name: platform.moduleName })
  expect(removed.application).toBe('failed')
  const parent = plugins.find(row => row.entryId === 'include:phalanx-platform-layer')!
  const parentDisabled = await rpc.remoteRpc<{ changed: boolean, application: string }>(origin, bobCookie, 'pluginManager/setPluginEnabled', { id: parent.entryId, enabled: false })
  expect(parentDisabled.changed).toBe(false); expect(parentDisabled.application).toBe('failed')
  await expect.poll(async () => JSON.stringify(await createRealDshRpc().remoteRpc(origin, await cookieHeader(bob.context, origin), 'session/modelCatalog', {})), { timeout: 20_000 }).toContain(sharedId)
  expect(await page.content()).not.toContain('personal-fixture-key')
  await page.getByRole('button', { name: /deepseek-chat/u }).click()
  await page.getByRole('menuitem', { name: /^Model/u }).click()
  await page.getByRole('menuitemradio', { name: /personal-model/u }).click()
  const chat = async (world: typeof alice, text: string, marker: string, defaults = false) => {
    const composer = world.page.locator('[data-composer-input]')
    await composer.fill(text); await composer.press('Enter')
    if (defaults) { await world.page.getByText('COMMUNITY_', { exact: true }).waitFor({ timeout: 90_000 }); model!.release() }
    const reply = world.page.locator('p').filter({ hasText: marker }).last()
    await reply.or(world.page.getByText(/^(This turn failed|PLUGIN_NETWORK_FAILED)$/u)).first().waitFor({ timeout: 90_000 })
    expect(await reply.isVisible(), 'Native model turn failed before its fixture reply').toBe(true)
  }
  await chat(alice, 'DEFAULT_CHOICE_TASK: Reply with your fixture marker.', 'COMMUNITY_MODEL_READY', true)
  await chat(bob, 'PERSONAL_CHOICE_TASK: Reply with your fixture marker.', 'PERSONAL_MODEL_READY')
  await page.getByRole('button', { name: 'Plugins', exact: true }).click()
  await page.getByRole('button', { name: 'Add plugin', exact: true }).click()
  if (process.env.DSH_PHALANX_E2E_NPM_MIRROR === '1') {
    await page.getByRole('button', { name: /^Registry /u }).click()
    await page.getByRole('radio', { name: /registry\.npmmirror\.com/u }).check()
    await page.getByRole('button', { name: /^Registry /u }).click()
  }
  await page.getByLabel('Package name or address', { exact: true }).fill('@aiwayds/dsh-web-search-tavily@0.6.0')
  await page.getByRole('button', { name: 'Install', exact: true }).click()
  const installed = page.getByRole('dialog', { name: 'Installed', exact: true })
  await installed.waitFor({ timeout: 180_000 })
  await installed.getByRole('button', { name: 'Enable now', exact: true }).click()
  await installed.waitFor({ state: 'hidden', timeout: 30_000 })
  await newSession(bob)
  await chat(bob, 'PERSONAL_CONFIG_TASK: Reply with your fixture marker.', 'PERSONAL_MODEL_READY')
  const profile = join(dshWebProfilePath(runtime.container === undefined ? join(root, 'users', 'bob', 'home') : DSH_CONTAINER_HOME), DSH_PATCH_CONFIG)
  // Read this member's fictional profile through the public native terminal.
  // Parse with the harness dependency, without relying on DSH's transitive modules.
  await runCommunityTerminal(page, `node -e 'const fs=require("node:fs");process.stdout.write(Buffer.from("Q09ORklHX1JFQURfQkVHSU4=","base64").toString()+fs.readFileSync(${JSON.stringify(profile)}).toString("base64")+Buffer.from("Q09ORklHX1JFQURfRU5E","base64").toString())'`, 'CONFIG_READ_END')
  const visibleProfile = (await page.locator('.xterm-screen').allTextContents()).join('')
    .split('CONFIG_READ_BEGIN')[1]!.split('CONFIG_READ_END')[0]!.replace(/\s/gu, '')
  const options = { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] }
  const document = parseDocument(Buffer.from(visibleProfile, 'base64').toString(), options)
  expect(document.errors.length).toBe(0)
  const patch = parseDocument(`\n- id: web\n  config:\n    searchProvider: tavily\n- id: web-search-tavily\n  config:\n    baseURL: ${JSON.stringify(personal)}\n    apiKey: tvly-fixture-key\n`, options)
  for (const row of (patch.contents as import('yaml').YAMLSeq).items) (document.contents as import('yaml').YAMLSeq).add(row)
  const configured = Buffer.from(document.toString()).toString('base64')
  await sendCommunityTerminal(page, `node -e 'require("node:fs").writeFileSync(${JSON.stringify(profile)},Buffer.from("${configured}","base64"),{mode:0o600});process.stdout.write(Buffer.from("Q09ORklHX1NBVkVE","base64"))'`, 'CONFIG_SAVED')
  if (runtime.container !== undefined) {
    await sendCommunityTerminal(page, "if printf corrupt >> /dsh-phalanx/platform-plugin/plugin.mjs 2>/dev/null; then printf 'PLATFORM_%s' WRITABLE; else printf 'PLATFORM_%s' READONLY; fi", 'PLATFORM_READONLY')
  }
  // The published plugin documents a runtime restart after profile configuration.
  const aliceClosed = alice.closedSockets.length
  await page.getByRole('link', { name: 'Restart instance', exact: true }).click()
  await page.getByRole('checkbox').check()
  await page.getByRole('button', { name: 'Restart instance', exact: true }).click()
  await page.getByRole('status').filter({ hasText: 'Instance restarted.' }).waitFor({ timeout: 300_000 })
  await page.getByRole('link', { name: 'Return to DSH', exact: true }).click()
  await page.locator('[data-composer-input]').waitFor()
  const restartedOrigin = origin
  const afterAlice = alice; const afterBob = bob
  expect(alice.closedSockets.length).toBe(aliceClosed)
  for (const world of [afterAlice, afterBob]) await newSession(world)
  await chat(afterAlice, 'DEFAULT_RESTART_TASK: Reply with your fixture marker.', 'COMMUNITY_MODEL_READY', true)
  await chat(afterBob, 'PERSONAL_RESTART_TASK: Reply with your fixture marker.', 'PERSONAL_MODEL_READY')
  await afterBob.page.getByRole('button', { name: 'Plugins', exact: true }).click()
  await afterBob.page.getByText(/dsh-web-search-tavily/u).first().waitFor()
  await newSession(afterBob)
  await chat(afterBob, 'PLUGIN_NETWORK_TASK: Use web_search after restart.', 'PLUGIN_NETWORK_CONFIRMED')
  if (runtime.container !== undefined) {
    const ownership = createHash('sha256').update(root).digest('hex')
    const names = execFileSync(runtimeSettings.containerRuntimeCli, ['ps', '--filter', `label=dsh-phalanx.community-root=${ownership}`, '--filter', 'label=dsh-phalanx.user=alice', '--format', '{{.Names}}'], { encoding: 'utf8' }).trim()
    const peer = JSON.parse(execFileSync(runtimeSettings.containerRuntimeCli, ['inspect', names], { encoding: 'utf8' })) as { NetworkSettings: { Ports: Record<string, { HostIp: string, HostPort: string }[]> } }[]
    const binding = peer[0]!.NetworkSettings.Ports[`${runtime.container.internalPort}/tcp`]![0]!
    const destinations = [restartedOrigin, `http://${binding.HostIp}:${binding.HostPort}`]
    for (const target of destinations) {
      const response = await fetch(`${target}/login`, { redirect: 'manual', signal: AbortSignal.timeout(10_000) })
      expect(response.status).toBeLessThan(500); await response.body?.cancel()
    }
    // Arrange a private probe file with this member's own fixture credential, then execute it through native Terminal.
    const storedAccounts = new CommunityAccountStore(join(root, 'community-accounts.db'))
    const spaceId = storedAccounts.getState('bob')!.spaceId
    storedAccounts.close()
    const token = new FileCommunityModelAccess(join(root, 'model-access.json')).forUser('bob', spaceId)
    const workspace = defaultWorkspacePath(root, 'bob')
    await writeFile(join(workspace, 'network-probe.cjs'), `
const http = require('node:http'), net = require('node:net');
const targets = ${JSON.stringify(destinations)};
const proxy = target => new Promise((resolve,reject) => {
  const req = http.request({hostname:'127.0.0.1',port:${runtime.container.gatewayPort},path:target,headers:{'proxy-authorization':'Basic '+Buffer.from(${JSON.stringify('dsh:')}+${JSON.stringify(token)}).toString('base64')}},res=>{res.resume();res.once('end',()=>res.statusCode===403?resolve():reject(new Error('Private proxy target was not denied')))});
  req.on('error',reject);req.setTimeout(5000,()=>req.destroy(new Error('Proxy probe deadline')));req.end();
});
const direct = target => new Promise((resolve,reject) => {
  const url = new URL(target), socket=net.connect({host:url.hostname,port:Number(url.port)});
  socket.once('connect',()=>{socket.destroy();reject(new Error('Direct host/private listener reachable'))});
  socket.once('error',error=>['ECONNREFUSED','EHOSTUNREACH','ENETUNREACH'].includes(error.code)?resolve():reject(error));
  socket.setTimeout(5000,()=>{socket.destroy();reject(new Error('Direct probe deadline'))});
});
(async()=>{for(const target of [...targets,...${JSON.stringify(config.network.hostPublicAddresses.map(address => `http://${address}:22/`))},'http://169.254.169.254/','http://10.0.0.1/'])await proxy(target);for(const target of targets)await direct(target);process.stdout.write('NETWORK_ISOLATED')})().catch(()=>{process.stderr.write('NETWORK_PROBE_FAILED');process.exitCode=1});
`, { mode: 0o600 })
    await runCommunityTerminal(afterBob.page, 'node network-probe.cjs', 'NETWORK_ISOLATED')
  }
  await application.stop(); application = candidateApplication(config)
  const secondOrigin = await application.start()
  const secondAlice = await enter('alice', secondOrigin); const secondBob = await enter('bob', secondOrigin)
  for (const world of [secondAlice, secondBob]) await newSession(world)
  await chat(secondAlice, 'DEFAULT_SECOND_RESTART_TASK: Reply with your fixture marker.', 'COMMUNITY_MODEL_READY', true)
  await chat(secondBob, 'PLUGIN_NETWORK_TASK: Use web_search after another restart.', 'PLUGIN_NETWORK_CONFIRMED')
  expect(await secondAlice.page.getByRole('button', { name: /DeepSeek \/ deepseek-chat/u }).count()).toBe(1)
  await secondAlice.page.getByRole('button', { name: 'Plugins', exact: true }).click()
  await secondAlice.page.getByText('Web search', { exact: true }).first().waitFor()
  expect(await secondAlice.page.getByText(/dsh-web-search-tavily/u).count()).toBe(0)
}, 600_000)


it.each(['patch', 'web', 'profiles', 'dsh-home'] as const)('refuses a member %s symlink to another member’s private configuration on restart', async kind => {
  assertPinnedDshRevision(runtimeSettings)
  root = await mkdtemp(join(tmpdir(), 'community-native-profile-isolation-'))
  model = await startCommunityModel(); runtime = runtimeSection(root, model.origin, runtimeSettings)
  const config = { listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'community-native-profile-session-secret-32-bytes', runtime,
    modelGateway: { upstreamApiKey: 'community-provider-fixture-key' } }
  application = candidateApplication(config)
  const accounts = new CommunityAccountStore(join(root, 'community-accounts.db'))
  try { for (const username of ['alice', 'bob']) await accounts.create({ username, email: `${username}@example.test`, password: 'password' }) } finally { accounts.close() }
  const origin = await application.start(); browser = await chromium.launch({ headless: true })
  const context = await newValidationContext(browser); const page = await context.newPage()
  await signInCommunity(page, origin, 'bob', 'password')
  await selectCommunityWorkspace(context, page, origin, instanceWorkspacePath(defaultWorkspacePath(root, 'bob'), runtime.container !== undefined), runtime.container !== undefined)
  await page.locator('[data-composer-input]').fill('PRIVATE_PROFILE_TASK: Reply with your fixture marker.')
  await page.locator('[data-composer-input]').press('Enter')
  await page.getByText('COMMUNITY_', { exact: true }).waitFor({ timeout: 90_000 }); model.release()
  // First-use title/catalog streams can leave DSH's new draft active. Select
  // the fixture's actual session before asserting its completed model reply.
  await page.getByRole('treeitem').filter({ has: page.getByText('COMMUNITY_TITLE', { exact: true }) }).last().click()
  await page.locator('p').filter({ hasText: 'COMMUNITY_MODEL_READY' }).last().waitFor()
  // Arrange a valid private patch outside Bob's mount; only Bob's native terminal creates the attack.
  const home = runtime.container === undefined ? join(root, 'users', 'bob', 'home') : DSH_CONTAINER_HOME
  const profile = join(dshWebProfilePath(home), DSH_PATCH_CONFIG)
  const linkPath = { patch: profile, web: dshWebProfilePath(home), profiles: dshProfilesPath(home), 'dsh-home': dshHomePath(home) }[kind]
  const privatePath = join(root, 'users', 'alice', 'private-profile')
  const privatePatch = join(privatePath, relative(linkPath, profile))
  await mkdir(dirname(privatePatch), { recursive: true, mode: 0o700 })
  await writeFile(privatePatch, '# OTHER_MEMBER_PRIVATE_CREDENTIAL\n[]\n', { mode: 0o600, flag: 'wx' })
  await runCommunityTerminal(page, `node -e 'const fs=require("node:fs");fs.rmSync(${JSON.stringify(linkPath)},{recursive:true,force:true});fs.symlinkSync(${JSON.stringify(privatePath)},${JSON.stringify(linkPath)});process.stdout.write(Buffer.from("TElOS19DUkVBVEVE","base64"))'`, 'LINK_CREATED')
  await application.stop(); application = candidateApplication(config)
  const restartedOrigin = await application.start()
  const response = await context.request.post(`${restartedOrigin}/login`, { form: { username: 'bob', password: 'password' }, headers: { origin: restartedOrigin }, maxRedirects: 0, timeout: 300_000 })
  expect(response.status()).toBe(303)
  expect(response.headers().location).toBe('/recovery')
  const native = await context.request.get(communityEntryUrl(restartedOrigin, await cookieHeader(context, restartedOrigin)), { maxRedirects: 0 })
  expect(native.status()).toBe(503)
  expect(await native.text()).not.toContain('OTHER_MEMBER_PRIVATE_CREDENTIAL')
  expect(await response.text()).not.toContain('OTHER_MEMBER_PRIVATE_CREDENTIAL')
}, 600_000)
