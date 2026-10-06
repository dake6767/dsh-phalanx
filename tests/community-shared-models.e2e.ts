import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser } from 'playwright'
import { afterEach, expect, it } from 'vitest'
import { candidateApplication } from './support/candidate-application.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import type { CommunityApplication } from '../src/ports/community-application.js'
import type { CommunityModelSettings } from '../src/domain/admin-contract.js'
import { startCommunityModel } from './fixtures/community-model.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { assertPinnedDshRevision, runtimeSection, defaultWorkspacePath, instanceWorkspacePath } from './support/real-dsh-runtime.js'
import { signInCommunity, selectCommunityWorkspace, runCommunityTerminal } from './fixtures/community-native-browser.js'
import { cookieHeader, createRealDshRpc } from './support/real-dsh-rpc.js'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import type { CommunityRuntimeConfig } from '../src/domain/community-config.js'

let app: CommunityApplication | undefined
let browser: Browser | undefined
let root: string | undefined
let model: Awaited<ReturnType<typeof startCommunityModel>> | undefined
let runtime: CommunityRuntimeConfig | undefined
afterEach(async () => {
  model?.release(); await browser?.close(); await app?.stop()
  if (runtime) await new CommunityRuntimeDriver(runtime).rebuild()
  await model?.close(); if (root) await rm(root, { recursive: true, force: true })
  root = undefined; app = undefined; browser = undefined; model = undefined; runtime = undefined
})

it('administers shared providers and a replacement default through the management browser', async () => {
  root = await mkdtemp(join(tmpdir(), 'shared-model-browser-'))
  app = candidateApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'shared-model-browser-fixture-32-bytes',
    runtime: { command: '/unavailable-dsh', args: [], dataRoot: root, defaultModel: {
      provider: 'deepseek-official', model: 'deepseek-chat', upstream: { baseUrl: 'https://api.deepseek.com' } } } })
  const origin = await app.start()
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext(); const page = await context.newPage(); page.setDefaultTimeout(10_000)
  await page.goto(`${origin}/bootstrap#credential=${readBootstrapCredential(root)!.credential}`)
  await page.getByLabel('Username', { exact: true }).fill('admin')
  await page.getByLabel('Password', { exact: true }).fill('password')
  await page.getByRole('button', { name: 'Create administrator' }).click()
  await page.waitForURL(`${origin}/admin`)
  await page.getByRole('link', { name: 'Model management', exact: true }).click()
  await page.getByRole('button', { name: 'Add provider', exact: true }).click()
  await page.getByLabel('Provider name', { exact: true }).fill('Custom Messages')
  await page.getByLabel('Messages Base URL', { exact: true }).fill('https://models.example.test/custom')
  await page.getByLabel('API key', { exact: true }).fill('private-browser-fixture-key')
  await page.getByLabel('Model identifiers', { exact: true }).fill('chat-one\nchat-two')
  await page.getByRole('button', { name: 'Save provider', exact: true }).click()
  await page.getByRole('status').filter({ hasText: 'Provider saved' }).waitFor()
  expect(await page.content()).not.toContain('private-browser-fixture-key')
  await page.getByLabel('Default shared model').selectOption({ label: 'Custom Messages / chat-two' })
  await page.getByRole('status').filter({ hasText: 'Default model saved' }).waitFor()
  await page.reload()
  expect(await page.getByLabel('Default shared model').inputValue()).not.toBe('')
  await page.getByRole('button', { name: 'Edit Custom Messages', exact: true }).click()
  expect(await page.getByLabel('API key', { exact: true }).inputValue()).toBe('')
  await page.getByLabel('Model identifiers', { exact: true }).fill('chat-one')
  await page.getByRole('button', { name: 'Save provider', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: 'replacement default' }).waitFor()
})

it('updates two open DSH catalogs without interrupting a turn and rejects normal personal model configuration', async () => {
  assertPinnedDshRevision(runtimeSettings)
  root = await mkdtemp(join(tmpdir(), 'shared-model-native-')); model = await startCommunityModel()
  runtime = runtimeSection(root, model.origin, runtimeSettings)
  app = candidateApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'shared-model-native-fixture-32-bytes', runtime })
  const origin = await app.start(); browser = await chromium.launch({ headless: true })
  const admin = await browser.newContext()
  const bootstrap = await admin.request.post(`${origin}/bootstrap`, { form: {
    credential: readBootstrapCredential(root)!.credential, username: 'admin', password: 'password',
  }, headers: { origin }, maxRedirects: 0 })
  expect(bootstrap.status()).toBe(303)
  const provider = { name: 'First', baseUrl: `${model.origin}/anthropic`, apiFormat: 'anthropic-messages',
    apiKey: 'community-provider-fixture-key', enabled: true, models: [{ name: 'deepseek-chat', enabled: true }] }
  const save = async (body: object) => {
    const response = await admin.request.post(`${origin}/admin/api/models`, { headers: { origin }, data: body })
    expect(response.status(), await response.text()).toBe(200)
    return await response.json() as CommunityModelSettings
  }
  let settings = await save({ revision: 0, action: 'save-provider', provider })
  for (const username of ['alice', 'bob']) {
    const created = await admin.request.post(`${origin}/admin/api/accounts`, { headers: { origin }, data: { username, email: `${username}@example.test`, password: 'password' } })
    expect(created.status()).toBe(201)
  }
  const enter = async (username: string) => {
    const context = await browser!.newContext(); const page = await context.newPage(); page.setDefaultTimeout(20_000)
    await signInCommunity(page, origin, username, 'password')
    await selectCommunityWorkspace(context, page, origin, instanceWorkspacePath(defaultWorkspacePath(root!, username), runtime!.container !== undefined), runtime!.container !== undefined)
    return { context, page, cookie: await cookieHeader(context, origin) }
  }
  const alice = await enter('alice'); const bob = await enter('bob'); const rpc = createRealDshRpc()
  for (const world of [alice, bob]) {
    const result = await rpc.remoteRpcResult(origin, world.cookie, 'settings/update', { ns: 'phalanx-shared-models', patch: { providers: {} } })
    expect(result.ok).toBe(false)
    await world.page.getByRole('button', { name: 'Settings', exact: true }).click()
    expect(await world.page.getByRole('button', { name: 'Models', exact: true }).count()).toBe(0)
    await world.page.keyboard.press('Escape')
    expect((await world.context.request.get(`${origin}/admin/api/models`)).status()).toBe(403)
  }
  const composer = alice.page.locator('[data-composer-input]')
  await composer.fill('STREAM_MODEL_TASK'); await composer.press('Enter')
  await alice.page.getByText('COMMUNITY_', { exact: true }).waitFor()
  settings = await save({ revision: settings.revision, action: 'save-provider', provider: { ...provider, name: 'Second' } })
  const secondId = settings.providers.find(row => row.name === 'Second')!.models[0]!.id
  for (const world of [alice, bob]) {
    await expect.poll(async () => JSON.stringify(await rpc.remoteRpc(origin, world.cookie, 'session/modelCatalog', {})), { timeout: 20_000 }).toContain(secondId)
  }
  await bob.page.getByRole('button', { name: /First \/ deepseek-chat/u }).click()
  await bob.page.getByRole('menuitem', { name: /^Model/u }).click()
  await bob.page.getByRole('menuitemradio', { name: /Second \/ deepseek-chat/u }).click()
  model.release(); await alice.page.locator('p').filter({ hasText: 'COMMUNITY_MODEL_READY' }).last().waitFor()
  await bob.page.locator('[data-composer-input]').fill('STREAM_MODEL_TASK'); await bob.page.locator('[data-composer-input]').press('Enter')
  await bob.page.getByText('COMMUNITY_', { exact: true }).waitFor(); model.release()
  await bob.page.locator('p').filter({ hasText: 'COMMUNITY_MODEL_READY' }).last().waitFor()
  settings = await save({ revision: settings.revision, action: 'set-default', defaultModelId: secondId })
  const catalog = await rpc.remoteRpc<{ default: { model: string } }>(origin, alice.cookie, 'session/modelCatalog', {})
  expect(catalog.default.model).toBe(secondId)
  const firstProvider = settings.providers.find(row => row.name === 'First')!
  settings = await save({ revision: settings.revision, action: 'delete-provider', providerId: firstProvider.id })
  await expect.poll(async () => JSON.stringify(await rpc.remoteRpc(origin, alice.cookie, 'session/modelCatalog', {})), { timeout: 20_000 }).not.toContain(firstProvider.models[0]!.id)
  await composer.fill('Use the previously selected model again'); await composer.press('Enter')
  await alice.page.getByText('Select an enabled shared model', { exact: false }).last().waitFor()
  await runCommunityTerminal(alice.page, "printf 'SHARED_TERMINAL_%s' OK", 'SHARED_TERMINAL_OK')
  if (runtime.container) await runCommunityTerminal(bob.page, "test -r /dsh-phalanx/managed-models/watch.mjs && if printf 'changed' >> /dsh-phalanx/managed-models/watch.mjs 2>/dev/null; then printf 'READONLY_%s' FAILED; else printf 'READONLY_%s' OK; fi", 'READONLY_OK')
})
