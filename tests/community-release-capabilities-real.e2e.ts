// Validation: T4 only; real credentials: required protected DeepSeek model and Search/Fetch inputs; installed rootless Linux candidate.
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { afterEach, expect, it } from 'vitest'
import type { CommunityApplication } from '../src/ports/community-application.js'
import type { CommunityRuntimeConfig } from '../src/domain/community-config.js'
import type { CommunityModelSettings } from '../src/domain/admin-contract.js'
import { candidateApplication } from './support/candidate-application.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { assertPinnedDshRevision, runtimeSection, instanceWorkspacePath, defaultWorkspacePath } from './support/real-dsh-runtime.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import { signInCommunity, selectCommunityWorkspace, sendCommunityPrompt } from './fixtures/community-native-browser.js'
import { hasToolResult, streamText, streamToolCall } from './support/real-dsh-model.js'

interface Inputs { modelApiKey: string; deepseekSearchApiKey: string }
const required = (name: string) => { const value = process.env[name]; if (!value) throw Error(`Missing private validation input: ${name}`); return value }
let app: CommunityApplication | undefined, browser: Browser | undefined, runtime: CommunityRuntimeConfig | undefined, root: string | undefined
let model: Awaited<ReturnType<typeof retrievalModel>> | undefined
let receipt: { name: string, result: Record<string, unknown> } | undefined

afterEach(async () => {
  const stopped = await Promise.allSettled([browser?.close(), app?.stop()])
  const containers = await Promise.allSettled([runtime ? new CommunityRuntimeDriver(runtime).rebuild() : Promise.resolve()])
  const fixture = await Promise.allSettled([model?.close()])
  const cleanupPassed = [...stopped, ...containers, ...fixture].every(result => result.status === 'fulfilled')
  if (cleanupPassed && root) await rm(root, { recursive: true, force: true })
  if (receipt) {
    const directory = required('DSH_PHALANX_E2E_EVIDENCE_DIR'); await mkdir(directory, { recursive: true, mode: 0o700 })
    await writeFile(join(directory, receipt.name + '.json'), JSON.stringify({ ...receipt.result, cleanupPassed, candidate: required('DSH_PHALANX_CANDIDATE_SHA') }) + '\n', { mode: 0o600 })
  }
  app = undefined; browser = undefined; runtime = undefined; root = undefined; model = undefined; receipt = undefined
  if (!cleanupPassed) throw Error('Capability validation cleanup did not complete')
})

function toolResultText(body: Record<string, unknown>, id: string): string {
  const messages = (body.messages ?? []) as { content?: { type?: string, tool_use_id?: string, content?: unknown }[] }[]
  return JSON.stringify(messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
    .filter(block => block.type === 'tool_result' && block.tool_use_id === id).map(block => block.content))
}

/** Deterministic model tool requests; only the retrieval service is real in this case. */
async function retrievalModel() {
  const observations = { search: false, fetch: false, failed: false }
  const requests: string[] = []
  const server = createServer((request, response) => { void (async () => {
    let text = ''; for await (const chunk of request) text += chunk
    const body = JSON.parse(text) as Record<string, unknown>; requests.push(text)
    response.setHeader('content-type', 'text/event-stream')
    if (body.max_tokens === 64) { streamText(response, 'RETRIEVAL_TITLE'); return }
    observations.failed ||= hasToolResult(body, 'live-search', true) || hasToolResult(body, 'live-fetch', true)
    if (observations.failed) { streamText(response, 'RETRIEVAL_REAL_FAILED'); return }
    observations.search ||= hasToolResult(body, 'live-search', false) && /https?:/u.test(toolResultText(body, 'live-search'))
    observations.fetch ||= hasToolResult(body, 'live-fetch', false) && /Example Domain/u.test(toolResultText(body, 'live-fetch'))
    if (!hasToolResult(body, 'live-search', false)) streamToolCall(response, 'live-search', 'web_search', { queries: ['DeepSeek official documentation'] })
    else if (!hasToolResult(body, 'live-fetch', false)) streamToolCall(response, 'live-fetch', 'web_fetch', { url: 'https://example.com' })
    else streamText(response, 'RETRIEVAL_REAL_DONE')
  })().catch(() => response.destroy()) })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing retrieval model listener')
  return { origin: `http://127.0.0.1:${address.port}`, observations, requests,
    close: async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())) } }
}

async function setup(mode: 'image' | 'retrieval'): Promise<{ page: Page, inputs: Inputs }> {
  expect(process.platform).toBe('linux'); expect(runtimeSettings.containerImage).toBeTruthy(); assertPinnedDshRevision(runtimeSettings)
  const privatePath = required('DSH_PHALANX_RELEASE_CAPABILITIES_INPUT')
  expect((await stat(privatePath)).mode & 0o077).toBe(0)
  const inputs = JSON.parse(await readFile(privatePath, 'utf8')) as Inputs
  if (!inputs.modelApiKey || !inputs.deepseekSearchApiKey) throw Error('Missing protected capability credential')
  const owned = resolve(required('DSH_PHALANX_ACCEPTANCE_OWNED_ROOT'))
  expect(owned.startsWith('/var/tmp/dsh-019-11/')).toBe(true)
  await mkdir(owned, { recursive: true, mode: 0o700 }); root = await mkdtemp(join(owned, 'capability-'))
  if (mode === 'retrieval') model = await retrievalModel()
  runtime = runtimeSection(root, model?.origin ?? 'https://api.deepseek.com', runtimeSettings)
  if (mode === 'retrieval') runtime = { ...runtime, environment: { ...runtime.environment, DSH_WEB_SEARCH_PROVIDER: 'deepseek-search-api', DSH_WEB_FETCH_PROVIDER: 'deepseek-fetch-api' } }
  app = candidateApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'real-capabilities-session-secret-32-bytes', runtime })
  const origin = await app.start(); browser = await chromium.launch({ headless: true })
  const admin = await browser.newContext({ locale: 'en' })
  expect((await admin.request.post(origin + '/bootstrap', { headers: { origin }, form: { credential: readBootstrapCredential(root)!.credential, username: 'admin', password: 'password' }, maxRedirects: 0 })).status()).toBe(303)
  const save = async (revision: number, provider: object): Promise<CommunityModelSettings> => {
    const response = await admin.request.post(origin + '/admin/api/models', { headers: { origin }, data: { revision, action: 'save-provider', provider } })
    expect(response.status()).toBe(200)
    const text = await response.text(); expect(text.includes(inputs.modelApiKey) || text.includes(inputs.deepseekSearchApiKey)).toBe(false)
    return JSON.parse(text) as CommunityModelSettings
  }
  const settings = await save(0, { name: mode === 'image' ? 'DeepSeek Flash' : 'Tool-driving fixture', baseUrl: `${model?.origin ?? 'https://api.deepseek.com'}/anthropic`, apiFormat: 'anthropic-messages', apiKey: mode === 'image' ? inputs.modelApiKey : 'fictional-tool-driving-key', enabled: true,
    models: [{ name: mode === 'image' ? 'deepseek-flash' : 'deepseek-chat', enabled: true }] })
  if (mode === 'image') expect(settings.providers[0]!.models[0]!.input).toBe('text+image')
  else await save(settings.revision, { name: 'Real retrieval provider', baseUrl: 'https://api.deepseek.com/anthropic', apiFormat: 'anthropic-messages', apiKey: inputs.deepseekSearchApiKey, enabled: true, models: [{ name: 'deepseek-chat', enabled: true }] })
  expect((await admin.request.post(origin + '/admin/api/accounts', { headers: { origin }, data: { username: 'member', email: '', password: 'password' } })).status()).toBe(201)
  const context = await browser.newContext({ locale: 'en' }), page = await context.newPage(); page.setDefaultTimeout(60000)
  await signInCommunity(page, origin, 'member', 'password')
  await selectCommunityWorkspace(context, page, origin, instanceWorkspacePath(defaultWorkspacePath(root, 'member'), true), true)
  return { page, inputs }
}

it('recognizes a real attached image with the installed shared Flash model', async () => {
  receipt = { name: 'flash-image', result: { passed: false } }
  const { page, inputs } = await setup('image')
  const drawing = await browser!.newPage({ viewport: { width: 128, height: 128 } })
  await drawing.setContent('<body style="margin:0;background:white"><svg width="128" height="128"><circle cx="64" cy="64" r="40" fill="red"/></svg></body>')
  const png = await drawing.screenshot({ type: 'png' }); await drawing.close()
  await page.locator('input[type="file"]').setInputFiles([{ name: 'shape.png', mimeType: 'image/png', buffer: png }])
  await page.getByRole('group', { name: 'Pending attachments' }).waitFor()
  await sendCommunityPrompt(page, 'Describe the primary shape and its color in the attached image. Reply in English in one sentence.')
  await page.locator('p').filter({ hasText: /red.*circle|circle.*red/iu }).last().waitFor({ timeout: 180000 })
  await expect.poll(() => page.getByRole('button', { name: 'Stop generating', exact: true }).count(), { timeout: 120000 }).toBe(0)
  expect((await page.content()).includes(inputs.modelApiKey)).toBe(false)
  receipt.result = { passed: true, realProvider: true, model: 'deepseek-flash', imageRecognized: 'red circle', memberHtmlCredentialAbsent: true }
}, 360000)

it('calls real Search and Fetch through the native DSH web providers without a member API key', async () => {
  receipt = { name: 'search-fetch', result: { passed: false } }
  const { page, inputs } = await setup('retrieval')
  await sendCommunityPrompt(page, 'Search the web for the DeepSeek official documentation, then fetch https://example.com.')
  await page.locator('p').filter({ hasText: /RETRIEVAL_REAL_(DONE|FAILED)/u }).last().waitFor({ timeout: 180000 })
  expect(model!.observations).toEqual({ search: true, fetch: true, failed: false })
  expect(model!.requests.some(text => text.includes(inputs.deepseekSearchApiKey))).toBe(false)
  expect((await page.content()).includes(inputs.deepseekSearchApiKey)).toBe(false)
  receipt.result = { passed: true, realSearch: true, realFetch: true, nativeDshProviders: true, toolDrivingModelIsFixture: true, upstreamCredentialAbsentFromModelAndMember: true }
}, 360000)
