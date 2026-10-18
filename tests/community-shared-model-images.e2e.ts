// Validation: T2; real credentials: none; actual Linux rootless DSH. Missing inputs must fail the T2 report gate.
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

// 1x1 transparent PNG; the attachment service owns the decode, so the fixture only needs a real image file.
const PROBE_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

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

it('declares shared model image input and enforces it for prompts and image reads', async () => {
  assertPinnedDshRevision(runtimeSettings)
  root = await mkdtemp(join(tmpdir(), 'shared-model-image-')); model = await startCommunityModel()
  const fixture = model
  runtime = runtimeSection(root, fixture.origin, runtimeSettings)
  app = candidateApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'shared-model-image-fixture-32-bytes', runtime })
  const origin = await app.start(); browser = await chromium.launch({ headless: true })
  const admin = await browser.newContext({ locale: 'en' })
  const bootstrap = await admin.request.post(`${origin}/bootstrap`, { form: {
    credential: readBootstrapCredential(root)!.credential, username: 'admin', password: 'password',
  }, headers: { origin }, maxRedirects: 0 })
  expect(bootstrap.status()).toBe(303)
  const created = await admin.request.post(`${origin}/admin/api/accounts`, { headers: { origin }, data: { username: 'alice', email: 'alice@example.test', password: 'password' } })
  expect(created.status()).toBe(201)
  const provider = { name: 'Shared images', baseUrl: `${fixture.origin}/anthropic`, apiFormat: 'anthropic-messages',
    apiKey: 'community-provider-fixture-key', enabled: true, models: [{ name: 'deepseek-flash', enabled: true, input: 'text+image' }] }
  let providerId: string | undefined
  const save = async (revision: number, name: string, input: 'text' | 'text+image') => {
    const response = await admin.request.post(`${origin}/admin/api/models`, { headers: { origin }, data: {
      revision, action: 'save-provider', provider: { ...(providerId === undefined ? {} : { id: providerId }), ...provider, name,
        models: [{ ...provider.models[0], input }] } } })
    expect(response.status(), await response.text()).toBe(200)
    const saved = await response.json() as CommunityModelSettings
    providerId = saved.providers.find(row => row.name === name)!.id
    return saved
  }
  let settings = await save(0, 'Shared images', 'text+image')
  const context = await browser.newContext({ locale: 'en' }); const page = await context.newPage(); page.setDefaultTimeout(30_000)
  await signInCommunity(page, origin, 'alice', 'password')
  await selectCommunityWorkspace(context, page, origin, instanceWorkspacePath(defaultWorkspacePath(root, 'alice'), runtime.container !== undefined), runtime.container !== undefined)
  const rpc = createRealDshRpc(); const cookie = await cookieHeader(context, origin)
  await runCommunityTerminal(page, `printf '%s' '${PROBE_PNG}' | base64 -d > probe.png && printf 'PNG_%s' OK`, 'PNG_OK')
  const composer = page.locator('[data-composer-input]')
  const attach = async () => {
    await page.locator('input[type="file"]').setInputFiles([{ name: 'probe.png', mimeType: 'image/png', buffer: Buffer.from(PROBE_PNG, 'base64') }])
    await page.getByRole('group', { name: 'Pending attachments' }).waitFor({ timeout: 30_000 })
  }
  const send = async (prompt: string) => {
    await composer.fill(prompt)
    const button = page.getByRole('button', { name: 'Send message', exact: true })
    await expect.poll(() => button.isEnabled(), { timeout: 15_000 }).toBe(true)
    await button.click()
  }
  const imageBlocks = (body: Record<string, unknown>) => (Array.isArray(body.messages) ? body.messages : [])
    .flatMap(message => Array.isArray((message as { content?: unknown }).content) ? (message as { content: unknown[] }).content : [])
    .filter(block => typeof block === 'object' && block !== null && (block as { type?: string }).type === 'image').length
  const modelRequests = () => fixture.requests.filter(body => body.max_tokens !== 64)
  const reloaded = async (name: string) => await expect.poll(async () =>
    JSON.stringify(await rpc.remoteRpc(origin, cookie, 'session/modelCatalog', {})), { timeout: 20_000 }).toContain(`${name} / deepseek-flash`)
  await attach(); await send('Describe IMAGE_TASK')
  await page.locator('p').filter({ hasText: 'IMAGE_SEEN' }).last().waitFor({ timeout: 120_000 })
  const accepted = modelRequests().filter(body => JSON.stringify(body).includes('IMAGE_TASK')).at(-1)!
  expect(imageBlocks(accepted)).toBeGreaterThan(0)
  settings = await save(settings.revision, 'Shared text only', 'text'); await reloaded('Shared text only')
  const beforeRejection = fixture.requests.length
  await attach(); await send('Describe IMAGE_TASK')
  await page.getByText('The current model does not support images; switch to a model that does', { exact: true }).waitFor({ timeout: 30_000 })
  expect(fixture.requests.slice(beforeRejection).filter(body => body.max_tokens !== 64 && imageBlocks(body) > 0)).toHaveLength(0)
  await page.getByRole('button', { name: 'Remove image probe.png', exact: true }).click()
  // The same declaration gates browser-authored image delivery to a continuable subagent.
  const parentSessionId = (await page.locator('[data-conversation-content]:visible').first().getAttribute('data-conversation-session'))!
  const sessionIds = async () => (await rpc.remoteRpc<{ items: { sessionId: string }[] }>(origin, cookie, 'session/list', { _request: {} })).items.map(row => row.sessionId)
  const beforeSpawn = await sessionIds()
  await send('SPAWN_SUBAGENT_TASK')
  await page.locator('p').filter({ hasText: 'PARENT_DONE' }).last().waitFor({ timeout: 120_000 })
  await expect.poll(async () => await page.getByRole('button', { name: 'Stop generating', exact: true }).count(), { timeout: 120_000 }).toBe(0)
  const childSessionId = (await sessionIds()).find(id => !beforeSpawn.includes(id))!
  const childPrompt = async () => await rpc.remoteRpcResult(origin, cookie, 'subagents/prompt', { request: {
    requestId: `image-child-${Date.now()}`, parentSessionId, childSessionId, mode: 'continuable', delivery: 'queue',
    content: [{ type: 'text', text: 'CHILD_IMAGE_TASK' }, { type: 'image', mediaType: 'image/png', data: PROBE_PNG }],
  } })
  const refused = await childPrompt()
  expect(refused.ok).toBe(false)
  if (!refused.ok) expect(refused.error.message).toContain('does not support image input')
  await send('READ_IMAGE_TASK')
  await page.locator('p').filter({ hasText: 'IMAGE_READ_BLOCKED' }).last().waitFor({ timeout: 120_000 })
  // The refusal must come from the route's declared input, not from a missing read_image tool.
  expect(JSON.stringify(fixture.requests)).toContain('does not declare image input')
  await save(settings.revision, 'Shared images on', 'text+image'); await reloaded('Shared images on')
  await send('READ_IMAGE_TASK')
  await page.locator('p').filter({ hasText: 'IMAGE_READ_OK' }).last().waitFor({ timeout: 120_000 })
  expect(JSON.stringify(fixture.requests.at(-1))).toContain('"type":"image"')
  const acceptedChild = await childPrompt()
  expect(acceptedChild.ok).toBe(true)
  await expect.poll(() => JSON.stringify(fixture.requests.filter(body => JSON.stringify(body).includes('CHILD_IMAGE_TASK')).at(-1)),
    { timeout: 30_000 }).toContain('"type":"image"')
})
