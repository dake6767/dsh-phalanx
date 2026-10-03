import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { chromium, type Browser } from 'playwright'
import { afterEach, expect, it } from 'vitest'
import { createCommunityApplication } from '../src/composition/community-application.js'
import { FileCommunityModelAccess } from '../src/adapters/community-model-access.js'
import { CommunityAccountStore } from '../src/adapters/community-account-store.js'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import type { CommunityApplication } from '../src/ports/community-application.js'
import type { CommunityRuntimeConfig } from '../src/domain/community-config.js'
import { assertPinnedDshRevision, runtimeSection, defaultWorkspacePath, instanceWorkspacePath } from './support/real-dsh-runtime.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { newValidationContext, saveBrowserEvidence } from './fixtures/browser-evidence.js'
import { signInCommunity, selectCommunityWorkspace, runCommunityTerminal } from './fixtures/community-native-browser.js'
import { dshHomePath, dshProfilesPath, dshWebProfilePath, DSH_PATCH_CONFIG, DSH_CONTAINER_HOME } from '../src/dsh/profile-layout.js'
import { startCommunityModel } from './fixtures/community-model.js'

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
it('keeps native model choices and an installed network plugin private and usable across restart', async () => {
  const personal = process.env.DSH_PHALANX_E2E_PERSONAL_UPSTREAM
  if (personal === undefined) throw new Error('A controlled public personal upstream is required')
  assertPinnedDshRevision(runtimeSettings)
  root = await mkdtemp(join(tmpdir(), 'community-native-customization-'))
  model = await startCommunityModel(); runtime = runtimeSection(root, model.origin, runtimeSettings)
  const config = { listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'community-native-settings-session-secret-32-bytes', runtime,
    network: { hostPublicAddresses: process.env.DSH_PHALANX_E2E_HOST_PUBLIC_ADDRESSES?.split(',') ?? [] },
    modelGateway: { upstreamApiKey: 'community-provider-fixture-key' } }
  application = createCommunityApplication(config)
  const accounts = new CommunityAccountStore(join(root, 'community-accounts.db'))
  try { for (const username of ['alice', 'bob']) await accounts.create({ username, email: `${username}@example.test`, password: 'password' }) } finally { accounts.close() }
  const origin = await application.start(); browser = await chromium.launch({ headless: true })
  const enter = async (username: string, entryOrigin: string) => {
    const context = await newValidationContext(browser!); const page = await context.newPage()
    await signInCommunity(page, entryOrigin, username, 'password')
    await selectCommunityWorkspace(context, page, entryOrigin, instanceWorkspacePath(defaultWorkspacePath(root!, username), runtime!.container !== undefined), runtime!.container !== undefined)
    return { context, page }
  }
  const newSession = async (world: Awaited<ReturnType<typeof enter>>) => {
    await world.page.getByRole('button', { name: 'New session', exact: true }).first().click()
    await world.page.getByText('Into the Unknown', { exact: true }).waitFor()
  }
  const alice = await enter('alice', origin); const bob = await enter('bob', origin)
  const { page } = bob
  await page.getByRole('button', { name: 'Settings', exact: true }).click({ timeout: 10_000 })
  await page.getByRole('button', { name: 'Models', exact: true }).click()
  await page.getByRole('button', { name: 'Add model provider', exact: true }).click()
  await page.getByText('Custom model API', { exact: true }).click()
  await page.getByLabel('Provider ID', { exact: true }).fill('personal')
  await page.getByLabel('Base URL', { exact: true }).last().fill(personal)
  await page.getByLabel('API protocol', { exact: true }).selectOption('anthropic-messages')
  await page.getByLabel('API key', { exact: true }).last().fill('personal-fixture-key')
  await page.getByRole('button', { name: 'Add model', exact: true }).click()
  await page.getByLabel('Model ID 1', { exact: true }).fill('personal-model')
  await page.getByRole('button', { name: 'Create provider', exact: true }).click()
  await page.getByText('personal', { exact: true }).first().waitFor()
  expect(await page.content()).not.toContain('personal-fixture-key')
  await page.keyboard.press('Escape')
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
  await page.getByLabel('Package name or address', { exact: true }).fill('@aiwayds/dsh-web-search-tavily@0.6.0')
  await page.getByRole('button', { name: 'Install', exact: true }).click()
  const installed = page.getByRole('dialog', { name: 'Installed', exact: true })
  await installed.waitFor({ timeout: 180_000 })
  await installed.getByRole('button', { name: 'Enable now', exact: true }).click()
  await installed.waitFor({ state: 'hidden', timeout: 30_000 })
  await newSession(bob)
  await chat(bob, 'PERSONAL_CONFIG_TASK: Reply with your fixture marker.', 'PERSONAL_MODEL_READY')
  const profile = join(dshWebProfilePath(runtime.container === undefined ? join(root, 'users', 'bob', 'home') : DSH_CONTAINER_HOME), DSH_PATCH_CONFIG)
  const patch = Buffer.from(`\n- id: web\n  config:\n    searchProvider: tavily\n- id: web-search-tavily\n  config:\n    baseURL: ${JSON.stringify(personal)}\n    apiKey: tvly-fixture-key\n`).toString('base64')
  // This fictional fixture credential and configuration are supplied by the user through the native terminal.
  await runCommunityTerminal(page, `node -e 'require("node:fs").appendFileSync(${JSON.stringify(profile)},Buffer.from("${patch}","base64"));process.stdout.write(Buffer.from("Q09ORklHX1NBVkVE","base64"))'`, 'CONFIG_SAVED')
  // The published plugin documents a runtime restart after profile configuration.
  await application.stop(); application = createCommunityApplication(config)
  const restartedOrigin = await application.start()
  const afterAlice = await enter('alice', restartedOrigin); const afterBob = await enter('bob', restartedOrigin)
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
    const token = new FileCommunityModelAccess(join(root, 'model-access.json')).forUser('bob')
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
  await application.stop(); application = createCommunityApplication(config)
  const secondOrigin = await application.start()
  const secondAlice = await enter('alice', secondOrigin); const secondBob = await enter('bob', secondOrigin)
  for (const world of [secondAlice, secondBob]) await newSession(world)
  await chat(secondAlice, 'DEFAULT_SECOND_RESTART_TASK: Reply with your fixture marker.', 'COMMUNITY_MODEL_READY', true)
  await chat(secondBob, 'PLUGIN_NETWORK_TASK: Use web_search after another restart.', 'PLUGIN_NETWORK_CONFIRMED')
  expect(await secondAlice.page.content()).not.toContain('personal-model')
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
  application = createCommunityApplication(config)
  const accounts = new CommunityAccountStore(join(root, 'community-accounts.db'))
  try { for (const username of ['alice', 'bob']) await accounts.create({ username, email: `${username}@example.test`, password: 'password' }) } finally { accounts.close() }
  const origin = await application.start(); browser = await chromium.launch({ headless: true })
  const context = await newValidationContext(browser); const page = await context.newPage()
  await signInCommunity(page, origin, 'bob', 'password')
  await selectCommunityWorkspace(context, page, origin, instanceWorkspacePath(defaultWorkspacePath(root, 'bob'), runtime.container !== undefined), runtime.container !== undefined)
  await page.locator('[data-composer-input]').fill('PRIVATE_PROFILE_TASK: Reply with your fixture marker.')
  await page.locator('[data-composer-input]').press('Enter')
  await page.getByText('COMMUNITY_', { exact: true }).waitFor({ timeout: 90_000 }); model.release()
  await page.getByText('COMMUNITY_MODEL_READY', { exact: true }).waitFor()
  // Arrange a valid private patch outside Bob's mount; only Bob's native terminal creates the attack.
  const home = runtime.container === undefined ? join(root, 'users', 'bob', 'home') : DSH_CONTAINER_HOME
  const profile = join(dshWebProfilePath(home), DSH_PATCH_CONFIG)
  const linkPath = { patch: profile, web: dshWebProfilePath(home), profiles: dshProfilesPath(home), 'dsh-home': dshHomePath(home) }[kind]
  const privatePath = join(root, 'users', 'alice', 'private-profile')
  const privatePatch = join(privatePath, relative(linkPath, profile))
  await mkdir(dirname(privatePatch), { recursive: true, mode: 0o700 })
  await writeFile(privatePatch, '# OTHER_MEMBER_PRIVATE_CREDENTIAL\n[]\n', { mode: 0o600, flag: 'wx' })
  await runCommunityTerminal(page, `node -e 'const fs=require("node:fs");fs.rmSync(${JSON.stringify(linkPath)},{recursive:true,force:true});fs.symlinkSync(${JSON.stringify(privatePath)},${JSON.stringify(linkPath)});process.stdout.write(Buffer.from("TElOS19DUkVBVEVE","base64"))'`, 'LINK_CREATED')
  await application.stop(); application = createCommunityApplication(config)
  const restartedOrigin = await application.start()
  const response = await context.request.post(`${restartedOrigin}/login`, { form: { username: 'bob', password: 'password' }, headers: { origin: restartedOrigin }, maxRedirects: 0, timeout: 300_000 })
  expect(response.status()).toBe(503)
  expect(await response.text()).not.toContain('OTHER_MEMBER_PRIVATE_CREDENTIAL')
}, 600_000)
