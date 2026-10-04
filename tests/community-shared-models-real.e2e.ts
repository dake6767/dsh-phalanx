import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { chromium, type Browser } from 'playwright'
import { afterEach, expect, it } from 'vitest'
import { candidateApplication } from './support/candidate-application.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import type { CommunityApplication } from '../src/ports/community-application.js'
import type { CommunityRuntimeConfig } from '../src/domain/community-config.js'
import type { CommunityModelSettings } from '../src/domain/admin-contract.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { assertPinnedDshRevision, runtimeSection, defaultWorkspacePath, instanceWorkspacePath } from './support/real-dsh-runtime.js'
import { signInCommunity, selectCommunityWorkspace } from './fixtures/community-native-browser.js'

let app: CommunityApplication | undefined
let runtime: CommunityRuntimeConfig | undefined
let root: string | undefined
let browser: Browser | undefined
afterEach(async () => {
  await browser?.close(); await app?.stop(); if (runtime) await new CommunityRuntimeDriver(runtime).rebuild()
  if (root) await rm(root, { recursive: true, force: true })
})
const credential = async (file: string, name: string) => {
  const source = await readFile(file, 'utf8')
  let value = source.split('\n').find(line => line.startsWith(`${name}=`))?.slice(name.length + 1).trim() ?? ''
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
  if (value === '') throw new Error('A protected real-provider credential is required')
  return value
}

it.skipIf(!process.env.DSH_PHALANX_REAL_DEEPSEEK_KEY_FILE || !process.env.DSH_PHALANX_REAL_VOLCENGINE_KEY_FILE)(
  'uses the specified real DeepSeek and Coding Plan models through administrator configuration and two member browsers', async () => {
    assertPinnedDshRevision(runtimeSettings)
    const keys = [await credential(process.env.DSH_PHALANX_REAL_DEEPSEEK_KEY_FILE!, 'DEEPSEEK_API_KEY'),
      await credential(process.env.DSH_PHALANX_REAL_VOLCENGINE_KEY_FILE!, 'VOLCENGINE_API_KEY')]
    root = await mkdtemp(join(tmpdir(), 'shared-real-browser-')); runtime = runtimeSection(root, 'https://api.deepseek.com', runtimeSettings)
    app = candidateApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'shared-real-browser-acceptance-32-bytes', runtime })
    const origin = await app.start(); browser = await chromium.launch({ headless: true }); const admin = await browser.newContext()
    const first = await admin.request.post(`${origin}/bootstrap`, { headers: { origin }, maxRedirects: 0, form: {
      credential: readBootstrapCredential(root)!.credential, username: 'admin', password: 'password',
    } })
    expect(first.status()).toBe(303)
    const save = async (revision: number, provider: object) => {
      const response = await admin.request.post(`${origin}/admin/api/models`, { headers: { origin }, data: { revision, action: 'save-provider', provider } })
      expect(response.status()).toBe(200)
      const text = await response.text(); expect(keys.some(key => text.includes(key)), 'Stored provider keys must not appear in management responses').toBe(false)
      return JSON.parse(text) as CommunityModelSettings
    }
    let settings = await save(0, { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/anthropic', apiFormat: 'anthropic-messages', apiKey: keys[0], enabled: true,
      models: [{ name: 'deepseek-chat', enabled: true }] })
    settings = await save(settings.revision, { name: 'Volcengine Coding Plan', baseUrl: 'https://ark.cn-beijing.volces.com/api/coding', apiFormat: 'anthropic-messages', apiKey: keys[1], enabled: true,
      models: ['glm-5.3', 'glm-5.3-flash', 'deepseek-v4.1-flash'].map(name => ({ name, enabled: true })) })
    const worlds = []
    for (const username of ['alice', 'bob']) {
      const created = await admin.request.post(`${origin}/admin/api/accounts`, { headers: { origin }, data: { username, email: `${username}@example.test`, password: 'password' } })
      expect(created.status()).toBe(201)
      const context = await browser.newContext(); const page = await context.newPage(); page.setDefaultTimeout(30_000)
      const frames: string[] = []; page.on('websocket', socket => socket.on('framereceived', event => { frames.push(String(event.payload)) }))
      await signInCommunity(page, origin, username, 'password')
      await selectCommunityWorkspace(context, page, origin, instanceWorkspacePath(defaultWorkspacePath(root, username), runtime.container !== undefined), runtime.container !== undefined)
      worlds.push({ page, frames })
    }
    const results = []
    let index = 0
    for (const provider of settings.providers) for (const model of provider.models) {
      const world = worlds[index++ % worlds.length]!
      await world.page.getByRole('button', { name: /DeepSeek \/ deepseek-chat|Volcengine Coding Plan \/ /u }).click()
      await world.page.getByRole('menuitem', { name: /^Model/u }).click()
      await world.page.getByRole('menuitemradio', { name: new RegExp(`${model.name.replace(/\./gu, '\\.')}(?:$|\\s)`, 'u') }).click()
      const marker = `MODEL_OK_${randomBytes(6).toString('hex').toUpperCase()}`
      const composer = world.page.locator('[data-composer-input]'); await composer.fill(`Decode these hexadecimal UTF-8 bytes and reply only with the decoded text: ${Buffer.from(marker).toString('hex')}. Do not use tools.`); await composer.press('Enter')
      const reply = world.page.locator('p').filter({ hasText: marker }).last()
      await reply.waitFor({ timeout: 120_000 })
      await expect.poll(async () => await world.page.getByRole('button', { name: 'Stop generating', exact: true }).count(), { timeout: 120_000 }).toBe(0)
      const html = await world.page.content()
      expect(keys.some(key => world.frames.join('\n').includes(key) || html.includes(key)), 'Provider key absent from member transport').toBe(false)
      expect(keys.some(key => settings.providers.some(row => JSON.stringify(row).includes(key))), 'Provider key absent from public catalog').toBe(false)
      results.push({ provider: provider.name, model: model.name, status: 'passed', nativeReply: true, credentialAbsent: true })
    }
    if (process.env.DSH_PHALANX_REAL_MODELS_RESULT_PATH) await writeFile(process.env.DSH_PHALANX_REAL_MODELS_RESULT_PATH, JSON.stringify({ results }, null, 2), { mode: 0o600 })
  }, 600_000)
