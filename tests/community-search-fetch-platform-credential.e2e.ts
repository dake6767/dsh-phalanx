// Validation: T3 development checkout; real credentials: none; requires native DSH source mode for the retrieval upstream seam.
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser } from 'playwright'
import { afterEach, expect, it } from 'vitest'
import { createCommunityApplication } from '../src/composition/community-application.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { signInCommunity, selectCommunityWorkspace, runCommunityTerminal } from './fixtures/community-native-browser.js'
import { assertPinnedDshRevision, runtimeSection, defaultWorkspacePath, instanceWorkspacePath } from './support/real-dsh-runtime.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { cookieHeader } from './support/real-dsh-rpc.js'
import { createRealDshRpc } from './support/real-dsh-rpc.js'
import { latestHumanText, streamText, streamToolCall } from './support/real-dsh-model.js'
import { dshWebProfilePath, DSH_PATCH_CONFIG } from '../src/dsh/profile-layout.js'
import type { CommunityModelSettings } from '../src/domain/admin-contract.js'
import type { CommunityApplication } from '../src/ports/community-application.js'

const PLATFORM_KEY = 'platform-deepseek-fixture-key'
const MEMBER_MODEL_KEY = 'community-provider-fixture-key'
const SEARCH_MARKER = 'PLATFORM_WEB_TOOLS_MARKER'
const FETCH_MARKER = 'PLATFORM_FETCH_MARKER'

interface CapturedCall { path: string, authorization: string, body: Record<string, unknown> }

/** DeepSeek Search/Fetch API fixture; records only what the platform sent. */
async function startRetrievalUpstream() {
  const calls: CapturedCall[] = []
  const server = createServer((request, response) => { void (async () => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array))
    calls.push({ path: request.url ?? '/', authorization: String(request.headers.authorization ?? ''),
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> })
    response.setHeader('content-type', 'application/json')
    if (request.url === '/v1/tools/search') {
      response.end(JSON.stringify({ results: [{ title: 'Platform fixture', url: 'https://example.test/fixture', snippet: SEARCH_MARKER, date: null }] }))
    } else if (request.url === '/v1/tools/fetch') {
      response.end(JSON.stringify({ content: `# Platform fixture page\n${FETCH_MARKER}` }))
    } else { response.writeHead(404); response.end('{}') }
  })() })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) } }
}

/** Tool-result text a model request carries back to the fixture. */
function resultText(body: unknown, toolUseId: string): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const messages = (body as { messages?: unknown }).messages
  if (!Array.isArray(messages)) return undefined
  for (const message of messages) {
    if (typeof message !== 'object' || message === null) continue
    const content = (message as { content?: unknown }).content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue
      const result = block as { type?: unknown, tool_use_id?: unknown, content?: unknown }
      if (result.type !== 'tool_result' || result.tool_use_id !== toolUseId) continue
      if (typeof result.content === 'string') return result.content
      if (Array.isArray(result.content)) return result.content.map(item => typeof item === 'object' && item !== null && typeof (item as { text?: unknown }).text === 'string' ? (item as { text: string }).text : '').join('\n')
      return ''
    }
  }
  return undefined
}

/** Deterministic Messages fixture that drives the built-in web tools. */
async function startToolModel() {
  const toolResults: string[] = []
  const server = createServer((request, response) => { void (async () => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array))
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { max_tokens?: number, tools?: { name?: string }[] }
    if (request.url !== '/anthropic/v1/messages' || request.headers['x-api-key'] !== MEMBER_MODEL_KEY) { response.writeHead(401); response.end('{}'); return }
    response.setHeader('content-type', 'text/event-stream; charset=utf-8')
    const prompt = latestHumanText(body)
    if (body.max_tokens === 64 || prompt.startsWith('Generate the session title')) { streamText(response, 'Platform web tools'); return }
    const tool = (name: string) => body.tools?.some(entry => entry.name === name) === true
    const finish = (text: string) => { streamText(response, text) }
    if (prompt.includes('PLATFORM_WEB_SEARCH_TASK')) {
      const result = resultText(body, 'platform-web-search'); if (result !== undefined) toolResults.push(result)
      if (result !== undefined) { finish(result.includes(SEARCH_MARKER) ? 'PLATFORM_SEARCH_CONFIRMED' : 'PLATFORM_SEARCH_FAILED'); return }
      if (!tool('web_search')) { finish('PLATFORM_TOOL_MISSING'); return }
      streamToolCall(response, 'platform-web-search', 'web_search', { queries: ['fixture query'] })
      return
    }
    if (prompt.includes('PLATFORM_WEB_FETCH_TASK')) {
      const result = resultText(body, 'platform-web-fetch'); if (result !== undefined) toolResults.push(result)
      if (result !== undefined) { finish(result.includes(FETCH_MARKER) ? 'PLATFORM_FETCH_CONFIRMED' : 'PLATFORM_FETCH_FAILED'); return }
      if (!tool('web_fetch')) { finish('PLATFORM_TOOL_MISSING'); return }
      streamToolCall(response, 'platform-web-fetch', 'web_fetch', { url: 'https://example.test/page' })
      return
    }
    if (prompt.includes('PLATFORM_WEB_UNAVAILABLE_TASK')) {
      const result = resultText(body, 'platform-web-unavailable'); if (result !== undefined) toolResults.push(result)
      if (result !== undefined) {
        finish(result.includes('no shared model credential for api.deepseek.com') ? `PLATFORM_UNAVAILABLE_CONFIRMED ${result.slice(0, 400)}` : `PLATFORM_UNAVAILABLE_UNEXPECTED ${result}`)
        return
      }
      if (!tool('web_search')) { finish('PLATFORM_TOOL_MISSING'); return }
      streamToolCall(response, 'platform-web-unavailable', 'web_search', { queries: ['fixture query'] })
      return
    }
    if (prompt.includes('PLATFORM_WEB_FAKE_KEY_TASK')) {
      const result = resultText(body, 'platform-web-fake-key'); if (result !== undefined) toolResults.push(result)
      if (result !== undefined) { finish(/Model access is required|Authentication is required/u.test(result) ? 'PLATFORM_FAKE_KEY_REJECTED' : `PLATFORM_FAKE_KEY_UNEXPECTED ${result}`); return }
      if (!tool('web_search')) { finish('PLATFORM_TOOL_MISSING'); return }
      streamToolCall(response, 'platform-web-fake-key', 'web_search', { queries: ['fixture query'] })
      return
    }
    finish('PLATFORM_UNEXPECTED_TASK')
  })() })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, toolResults,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) } }
}

let app: CommunityApplication | undefined
let browser: Browser | undefined
let root: string | undefined
let retrieval: Awaited<ReturnType<typeof startRetrievalUpstream>> | undefined
let model: Awaited<ReturnType<typeof startToolModel>> | undefined
afterEach(async () => {
  delete process.env.DSH_PHALANX_ALLOW_TEST_ONLY_WEB_TOOLS
  await browser?.close(); await app?.stop(); await retrieval?.close(); await model?.close()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined; app = undefined; browser = undefined; retrieval = undefined; model = undefined
})

it('enables DeepSeek Search and Fetch through the platform gateway without exposing the platform key', async () => {
  assertPinnedDshRevision(runtimeSettings)
  retrieval = await startRetrievalUpstream(); model = await startToolModel()
  root = await mkdtemp(join(tmpdir(), 'search-fetch-platform-'))
  const runtime = runtimeSection(root, model.origin, runtimeSettings)
  process.env.DSH_PHALANX_ALLOW_TEST_ONLY_WEB_TOOLS = '1'
  app = createCommunityApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'search-fetch-platform-session-32-bytes', runtime },
    { testOnlyWebToolsUpstreamBaseUrl: `${retrieval.origin}/v1/tools` })
  const origin = await app.start(); browser = await chromium.launch({ headless: true })
  const admin = await browser.newContext({ locale: 'en' })
  const bootstrap = await admin.request.post(`${origin}/bootstrap`, { form: {
    credential: readBootstrapCredential(root)!.credential, username: 'admin', password: 'password',
  }, headers: { origin }, maxRedirects: 0 })
  expect(bootstrap.status()).toBe(303)
  const save = async (body: object) => {
    const response = await admin.request.post(`${origin}/admin/api/models`, { headers: { origin }, data: body })
    expect(response.status(), await response.text()).toBe(200)
    return await response.json() as CommunityModelSettings
  }
  let settings = await save({ revision: 0, action: 'save-provider', provider: { name: 'Member chat', baseUrl: `${model.origin}/anthropic`,
    apiFormat: 'anthropic-messages', apiKey: MEMBER_MODEL_KEY, enabled: true, models: [{ name: 'deepseek-chat', enabled: true }] } })
  const chatId = settings.providers[0]!.models[0]!.id
  settings = await save({ revision: settings.revision, action: 'save-provider', provider: { name: 'DeepSeek retrieval',
    baseUrl: 'https://api.deepseek.com/anthropic', apiFormat: 'anthropic-messages', apiKey: PLATFORM_KEY, enabled: true,
    models: [{ name: 'deepseek-flash', enabled: true }] } })
  settings = await save({ revision: settings.revision, action: 'set-default', defaultModelId: chatId })
  const created = await admin.request.post(`${origin}/admin/api/accounts`, { headers: { origin }, data: { username: 'alice', email: 'alice@example.test', password: 'password' } })
  expect(created.status()).toBe(201)
  const context = await browser.newContext({ locale: 'en' })
  const page = await context.newPage(); page.setDefaultTimeout(20_000)
  await signInCommunity(page, origin, 'alice', 'password')
  if ('container' in runtime) throw new Error('This scenario requires native DSH source mode')
  await selectCommunityWorkspace(context, page, origin, instanceWorkspacePath(defaultWorkspacePath(root, 'alice'), false), false)
  const cookie = await cookieHeader(context, origin)
  const rpc = createRealDshRpc()

  // The switch is available, saves, and the platform-injected credential keeps the key control inactive and unset.
  await page.getByRole('button', { name: 'Plugins', exact: true }).click()
  await page.getByRole('heading', { name: 'Built-in plugin settings', exact: true }).waitFor()
  await page.getByRole('button', { name: 'View Web search', exact: true }).click()
  const toggle = page.getByRole('switch', { name: 'Use the new Web Search API', exact: true })
  expect(await toggle.isChecked()).toBe(false)
  await toggle.click()
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(() => page.getByRole('button', { name: 'Save', exact: true }).isDisabled(), { timeout: 20_000 }).toBe(true)
  expect(await toggle.isChecked()).toBe(true)
  const key = page.getByLabel('API key', { exact: true })
  expect(await key.inputValue()).toBe('')
  await page.getByText('A key is configured.', { exact: true }).waitFor()
  const selection = await rpc.remoteRpc<{ searchProvider?: string, fetchProvider?: string }>(origin, cookie, 'settings/describe', {})
  expect(JSON.stringify(selection)).toContain('deepseek-search-api')
  expect(JSON.stringify(selection)).not.toContain(PLATFORM_KEY)

  await page.getByRole('button', { name: 'New session', exact: true }).first().click()
  await page.locator('[data-composer-input]').waitFor()
  // Search reaches the platform gateway and the upstream receives the platform key, never the member token.
  const memberHome = join(root, 'users', 'alice', 'home')
  const memberCheck = async (command: string, output: string): Promise<string> => {
    await runCommunityTerminal(page, `${command}; printf '%s' '${output}'`, output)
    return await readFile(join(memberHome, '.e2e-check'), 'utf8')
  }
  const access = JSON.parse(await readFile(join(root, 'model-access.json'), 'utf8')) as string[][]
  const memberToken = access.find(row => row[0] === 'alice')?.[1]
  expect(memberToken).toMatch(/^[A-Za-z0-9_-]{43}$/u)
  const homeProfile = join(dshWebProfilePath(join(root, 'users', 'alice', 'home')), DSH_PATCH_CONFIG)
  const composer = page.locator('[data-composer-input]')
  const ask = async (text: string, marker: string) => {
    await composer.fill(text); await composer.press('Enter')
    await page.getByText(marker, { exact: false }).first().waitFor({ timeout: 120_000 })
  }
  await ask('PLATFORM_WEB_SEARCH_TASK: search the fixture.', 'PLATFORM_SEARCH_CONFIRMED')
  const searchCall = retrieval.calls.find(call => call.path === '/v1/tools/search')
  expect(searchCall).toBeDefined()
  expect(searchCall!.authorization).toBe(`Bearer ${PLATFORM_KEY}`)
  expect(searchCall!.authorization).not.toContain(memberToken)
  expect(searchCall!.body).toMatchObject({ query: 'fixture query', need_content: false })
  await ask('PLATFORM_WEB_FETCH_TASK: fetch the fixture.', 'PLATFORM_FETCH_CONFIRMED')
  const fetchCall = retrieval.calls.find(call => call.path === '/v1/tools/fetch')
  expect(fetchCall?.authorization).toBe(`Bearer ${PLATFORM_KEY}`)
  expect(fetchCall?.body).toEqual({ url: 'https://example.test/page' })
  expect(retrieval.calls.every(call => call.authorization === `Bearer ${PLATFORM_KEY}`)).toBe(true)
  expect(retrieval.calls.every(call => !call.authorization.includes(memberToken!))).toBe(true)

  // The key is absent from the member environment, profile, settings responses and the spawned DSH process.
  const checks = await memberCheck(`node -e 'const fs=require("node:fs");const file=process.env.HOME+"/.e2e-check";const env=JSON.stringify(process.env).includes(${JSON.stringify(PLATFORM_KEY)});const profile=fs.readFileSync(${JSON.stringify(homeProfile)},"utf8").includes(${JSON.stringify(PLATFORM_KEY)});fs.writeFileSync(file,"ENV="+(env?"1":"0")+" PROFILE="+(profile?"1":"0"))'`, 'E2E_CHECK')
  expect(checks).toBe('ENV=0 PROFILE=0')
  const settingsRead = await rpc.remoteRpc<unknown>(origin, cookie, 'settings/describe', {})
  expect(JSON.stringify(settingsRead)).not.toContain(PLATFORM_KEY)
  expect('args' in runtime).toBe(true)
  const dshBin = ('args' in runtime ? runtime.args[0] : undefined)!
  const pids = execFileSync('pgrep', ['-f', dshBin], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(Number)
  expect(pids.length).toBeGreaterThan(0)
  const dshEnvironment = (pid: number): string => process.platform === 'linux'
    ? readFileSync(`/proc/${pid}/environ`).toString()
    : execFileSync('ps', ['eww', '-p', String(pid)], { encoding: 'utf8' })
  expect(pids.filter(pid => dshEnvironment(pid).includes(PLATFORM_KEY))).toEqual([])

  // Removing the DeepSeek provider leaves an explicit unavailable explanation about the host, not key guidance.
  const retrievalProvider = settings.providers.find(provider => provider.name === 'DeepSeek retrieval')!
  settings = await save({ revision: settings.revision, action: 'delete-provider', providerId: retrievalProvider.id })
  await ask('PLATFORM_WEB_UNAVAILABLE_TASK: search with no platform credential.', 'PLATFORM_UNAVAILABLE_CONFIRMED')
  const unavailableResult = model.toolResults.find(text => text.includes('DeepSeek Search and Fetch are unavailable'))
  expect(unavailableResult).toContain('no shared model credential for api.deepseek.com')
  expect(unavailableResult).toContain('administrator')
  expect(unavailableResult).not.toMatch(/API [Kk]ey/u)

  // A key typed into the native control cannot replace the platform credential: the gateway refuses it before upstream.
  settings = await save({ revision: settings.revision, action: 'save-provider', provider: { name: 'DeepSeek retrieval',
    baseUrl: 'https://api.deepseek.com/anthropic', apiFormat: 'anthropic-messages', apiKey: PLATFORM_KEY, enabled: true,
    models: [{ name: 'deepseek-flash', enabled: true }] } })
  const callsBeforeFake = retrieval.calls.length
  await page.getByRole('button', { name: 'Plugins', exact: true }).click()
  await page.getByRole('heading', { name: 'Built-in plugin settings', exact: true }).waitFor()
  await page.getByRole('button', { name: 'View Web search', exact: true }).click()
  await page.getByLabel('API key', { exact: true }).fill('member-typed-fake-key')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(() => page.getByRole('button', { name: 'Save', exact: true }).isDisabled(), { timeout: 20_000 }).toBe(true)
  await page.getByRole('button', { name: 'New session', exact: true }).first().click()
  const fakeComposer = page.locator('[data-composer-input]'); await fakeComposer.waitFor()
  await fakeComposer.fill('PLATFORM_WEB_FAKE_KEY_TASK: search with a typed key.'); await fakeComposer.press('Enter')
  await page.getByText('PLATFORM_FAKE_KEY_REJECTED', { exact: false }).first().waitFor({ timeout: 120_000 })
  expect(retrieval.calls.length).toBe(callsBeforeFake)
})
