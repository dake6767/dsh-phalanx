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
  await page.getByLabel('Model identifier 1', { exact: true }).fill('chat-one')
  await page.getByRole('button', { name: 'Add model', exact: true }).click()
  await page.getByLabel('Model identifier 2', { exact: true }).fill('chat-two')
  await page.getByRole('button', { name: 'Save provider', exact: true }).click()
  await page.getByRole('status').filter({ hasText: 'Provider saved' }).waitFor()
  expect(await page.content()).not.toContain('private-browser-fixture-key')
  await page.getByRole('button', { name: /Default shared model/ }).click(); await page.getByRole('option', { name: 'Custom Messages / chat-two', exact: true }).click()
  await page.getByRole('status').filter({ hasText: 'Default model saved' }).waitFor()
  await page.reload()
  await expect.poll(() => page.getByRole('button', { name: /Default shared model/ }).textContent()).toContain('Custom Messages / chat-two')
  await page.getByRole('button', { name: 'Select provider Custom Messages', exact: true }).click()
  expect(await page.getByLabel('API key', { exact: true }).inputValue()).toBe('')
  const providerSwitch = page.getByRole('switch', { name: 'Provider enabled', exact: true })
  await page.locator('.provider-form > .switch .switch__control').click()
  expect(await providerSwitch.isChecked()).toBe(false)
  await page.getByText('Unsaved changes', { exact: true }).waitFor()
  await page.getByText('Provider enabled', { exact: true }).click()
  expect(await providerSwitch.isChecked()).toBe(true)
  await providerSwitch.focus(); await page.keyboard.press('Space')
  expect(await providerSwitch.isChecked()).toBe(false)
  await page.locator('.provider-form > .switch .switch__control').click()
  expect(await providerSwitch.isChecked()).toBe(true)
  const modelSwitch = page.getByRole('switch', { name: 'Model 1 enabled', exact: true })
  await page.locator('.model-draft-row').first().getByText('Enabled', { exact: true }).click()
  expect(await modelSwitch.isChecked()).toBe(false)
  await modelSwitch.focus(); await page.keyboard.press('Space')
  expect(await modelSwitch.isChecked()).toBe(true)
  await page.getByRole('button', { name: 'Remove model 2', exact: true }).click()
  await page.getByRole('button', { name: 'Save provider', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: 'replacement default' }).waitFor()
  const read = async () => await (await context.request.get(`${origin}/admin/api/models`)).json() as CommunityModelSettings
  const guard = page.getByRole('dialog', { name: 'Unsaved changes', exact: true })
  await page.getByRole('button', { name: 'Discard draft', exact: true }).click()
  await guard.getByRole('button', { name: 'Discard changes', exact: true }).click()
  await page.getByRole('button', { name: 'Select provider Custom Messages', exact: true }).click()
  await page.getByLabel('Model identifier 2', { exact: true }).waitFor()
  const before = await read(); const original = before.providers[0]!
  await page.getByLabel('Model identifier 1', { exact: true }).fill('chat-renamed')
  await page.locator('.model-draft-row').first().locator('.switch__control').click()
  expect(await page.getByRole('switch', { name: 'Model 1 enabled', exact: true }).isChecked()).toBe(false)
  expect((await read()).revision).toBe(before.revision)
  await page.getByRole('button', { name: 'Add provider', exact: true }).click()
  await guard.getByRole('button', { name: 'Continue editing', exact: true }).click()
  expect(await page.getByLabel('Model identifier 1', { exact: true }).inputValue()).toBe('chat-renamed')
  await page.getByRole('button', { name: 'Add provider', exact: true }).click()
  await guard.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect.poll(() => page.getByLabel('Provider name', { exact: true }).evaluate(element => element === document.activeElement)).toBe(true)
  await page.getByLabel('Provider name', { exact: true }).fill('Second provider')
  const renamed = (await read()).providers.find(row => row.id === original.id)!
  expect(renamed.models[0]).toMatchObject({ id: original.models[0]!.id, name: 'chat-renamed', enabled: false })
  expect(renamed.hasApiKey).toBe(true)
  await page.getByLabel('Messages Base URL', { exact: true }).fill('https://second.example.test/anthropic')
  await page.getByLabel('API key', { exact: true }).fill('second-fixture-key')
  await page.getByLabel('Model identifier 1', { exact: true }).fill('second-chat')
  await page.getByRole('button', { name: 'Save provider', exact: true }).click()
  await page.getByRole('status').filter({ hasText: 'Provider saved' }).waitFor()
  await page.getByRole('button', { name: 'Select provider Custom Messages', exact: true }).click()
  await page.getByLabel('Provider name', { exact: true }).fill('Draft kept on conflict')
  const concurrent = await read()
  expect((await context.request.post(`${origin}/admin/api/models`, { headers: { origin }, data: { revision: concurrent.revision, action: 'save-provider', provider: { ...renamed, name: 'Concurrent administrator edit' } } })).status()).toBe(200)
  await page.getByRole('button', { name: 'Save provider', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: 'changed' }).waitFor()
  expect(await page.getByLabel('Provider name', { exact: true }).inputValue()).toBe('Draft kept on conflict')
  await page.getByRole('button', { name: 'Reload settings', exact: true }).click()
  await guard.getByRole('button', { name: 'Discard changes', exact: true }).click()
  await expect.poll(() => page.getByLabel('Provider name', { exact: true }).inputValue()).toBe('Concurrent administrator edit')
  await page.getByRole('button', { name: 'Delete provider', exact: true }).click()
  const deletion = page.getByRole('dialog', { name: 'Delete provider: Concurrent administrator edit', exact: true })
  await deletion.getByRole('button', { name: 'Confirm deletion', exact: true }).click(); await deletion.waitFor({ state: 'detached' })
  await page.getByRole('alert').filter({ hasText: 'replacement default' }).waitFor()
  await page.getByLabel('Provider name', { exact: true }).fill('Unsaved navigation')
  await page.getByRole('link', { name: 'Account management', exact: true }).click()
  await guard.getByRole('button', { name: 'Continue editing', exact: true }).click()
  expect(new URL(page.url()).pathname).toBe('/admin/models')
  await page.getByRole('button', { name: 'Select provider Second provider', exact: true }).click()
  await guard.getByRole('button', { name: 'Discard changes', exact: true }).click()
  await page.getByRole('button', { name: /Default shared model/ }).click(); await page.getByRole('option', { name: 'Second provider / second-chat', exact: true }).click()
  await page.getByRole('status').filter({ hasText: 'Default model saved' }).waitFor()
  await page.getByRole('button', { name: 'Select provider Concurrent administrator edit', exact: true }).click()
  await page.getByRole('button', { name: 'Delete provider', exact: true }).click()
  await deletion.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect((await read()).providers).toHaveLength(2)
  await page.getByRole('button', { name: 'Delete provider', exact: true }).click()
  const newer = await read()
  expect((await context.request.post(`${origin}/admin/api/models`, { headers: { origin }, data: { revision: newer.revision, action: 'set-default', defaultModelId: newer.defaultModelId } })).status()).toBe(200)
  await deletion.getByRole('button', { name: 'Confirm deletion', exact: true }).click(); await deletion.waitFor({ state: 'detached' })
  await page.getByRole('alert').filter({ hasText: 'changed' }).waitFor()
  await page.getByRole('button', { name: 'Reload settings', exact: true }).click()
  await expect.poll(() => page.getByLabel('Provider name', { exact: true }).inputValue()).toBe('Concurrent administrator edit')
  await page.getByRole('button', { name: 'Delete provider', exact: true }).click()
  await deletion.getByRole('button', { name: 'Confirm deletion', exact: true }).click(); await deletion.waitFor({ state: 'detached' })
  expect((await read()).providers).toHaveLength(1)
  await page.getByLabel('Provider name', { exact: true }).fill('P'.repeat(128))
  await page.getByLabel('Model identifier 1', { exact: true }).fill('M'.repeat(256))
  await page.getByRole('button', { name: 'Save provider', exact: true }).click()
  await page.getByRole('status').filter({ hasText: 'Provider saved' }).waitFor()
  for (const width of [390, 800, 1280]) {
    await page.setViewportSize({ width, height: 844 })
    const overflow = await page.evaluate(() => [...document.querySelectorAll('main *')].filter(element => element.getBoundingClientRect().right > innerWidth + 1).slice(0, 8).map(element => ({ tag: element.tagName, cls: element.className, width: element.getBoundingClientRect().width, css: getComputedStyle(element).minWidth })))
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), JSON.stringify({ width, overflow })).toBe(true)
  }
  for (const width of [1280, 800, 390]) {
    await page.setViewportSize({ width, height: 844 })
    await page.getByRole('button', { name: /^Select provider / }).first().click()
    const add = page.getByRole('button', { name: 'Add provider', exact: true })
    const name = page.getByLabel('Provider name', { exact: true })
    await add.click()
    await expect.poll(() => name.evaluate(element => element === document.activeElement)).toBe(true)
    expect(await name.evaluate(element => { const bounds = element.getBoundingClientRect(); return bounds.top >= 0 && bounds.bottom <= innerHeight })).toBe(true)
    expect(await add.getAttribute('aria-pressed')).toBe('true')
    await name.fill('Retained new draft')
    await add.click()
    expect(await guard.count()).toBe(0)
    expect(await name.inputValue()).toBe('Retained new draft')
    await expect.poll(() => name.evaluate(element => element === document.activeElement)).toBe(true)
    await page.getByRole('button', { name: /^Select provider / }).first().click()
    await guard.getByRole('button', { name: 'Discard changes', exact: true }).click()
  }
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: '/tmp/phalanx-models-mobile.png', fullPage: true })
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
