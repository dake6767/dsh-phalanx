// Validation: T3 development checkout; real credentials: none; requires native DSH source mode for the retrieval upstream seam.
import { memberSpacePath } from './support/real-dsh-runtime.js'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser } from 'playwright'
import { afterEach, expect, it } from 'vitest'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import type { CommunityModelSettings } from '../src/domain/admin-contract.js'
import type { CommunityApplication } from '../src/ports/community-application.js'
import { WEB_TOOLS_MEMBER_TOKEN_ENV } from '../src/dsh/web-tools.js'
import { selectCommunityWorkspace, signInCommunity } from './fixtures/community-native-browser.js'
import { removeCommunityFixture } from './fixtures/owned-cleanup.js'
import { createCommunityApplication, modelAccessToken, openTestAccounts } from './support/community-application.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { latestHumanText, streamText, streamToolCall } from './support/real-dsh-model.js'
import { cookieHeader, createRealDshRpc } from './support/real-dsh-rpc.js'
import { assertPinnedDshRevision, defaultWorkspacePath, instanceWorkspacePath, runtimeSection } from './support/real-dsh-runtime.js'

const PLATFORM_KEY = 'platform-deepseek-fixture-key'
const MEMBER_MODEL_KEY = 'community-provider-fixture-key'
const SEARCH_MARKER = 'PLATFORM_WEB_TOOLS_MARKER'

interface CapturedCall {
  path: string
  authorization: string
  body: Record<string, unknown>
}

/** DeepSeek Search/Fetch API fixture; records only what the platform sent. */
async function startRetrievalUpstream() {
  const calls: CapturedCall[] = []
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array))
      calls.push({
        path: request.url ?? '/',
        authorization: String(request.headers.authorization ?? ''),
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
      })
      response.setHeader('content-type', 'application/json')
      if (request.url === '/v1/tools/search') {
        response.end(JSON.stringify({ results: [{ title: 'Platform fixture', url: 'https://example.test/fixture', snippet: SEARCH_MARKER, date: null }] }))
      } else {
        response.writeHead(404)
        response.end('{}')
      }
    })()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    calls,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
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
      const result = block as { type?: unknown; tool_use_id?: unknown; content?: unknown }
      if (result.type !== 'tool_result' || result.tool_use_id !== toolUseId) continue
      if (typeof result.content === 'string') return result.content
      if (Array.isArray(result.content))
        return result.content
          .map(item =>
            typeof item === 'object' && item !== null && typeof (item as { text?: unknown }).text === 'string' ? (item as { text: string }).text : '',
          )
          .join('\n')
      return ''
    }
  }
  return undefined
}

/** Deterministic Messages fixture that drives the built-in web tools. */
async function startToolModel() {
  const toolResults: string[] = []
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array))
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { max_tokens?: number; tools?: { name?: string }[] }
      if (request.url !== '/anthropic/v1/messages' || request.headers['x-api-key'] !== MEMBER_MODEL_KEY) {
        response.writeHead(401)
        response.end('{}')
        return
      }
      response.setHeader('content-type', 'text/event-stream; charset=utf-8')
      const prompt = latestHumanText(body)
      if (body.max_tokens === 64 || prompt.startsWith('Generate the session title')) {
        streamText(response, 'Platform web tools')
        return
      }
      const tool = (name: string) => body.tools?.some(entry => entry.name === name) === true
      const finish = (text: string) => {
        streamText(response, text)
      }
      if (prompt.includes('PLATFORM_WEB_SEARCH_TASK')) {
        const result = resultText(body, 'platform-web-search')
        if (result !== undefined) toolResults.push(result)
        if (result !== undefined) {
          finish(result.includes(SEARCH_MARKER) ? 'PLATFORM_SEARCH_CONFIRMED' : 'PLATFORM_SEARCH_FAILED')
          return
        }
        if (!tool('web_search')) {
          finish('PLATFORM_TOOL_MISSING')
          return
        }
        streamToolCall(response, 'platform-web-search', 'web_search', { queries: ['fixture query'] })
        return
      }
      if (prompt.includes('PLATFORM_WEB_FETCH_TASK')) {
        finish(tool('web_fetch') ? 'PLATFORM_FETCH_UNEXPECTED' : 'PLATFORM_FETCH_UNAVAILABLE')
        return
      }
      if (prompt.includes('PLATFORM_WEB_DISABLED_TASK')) {
        finish(tool('web_search') ? 'PLATFORM_SEARCH_UNEXPECTED' : 'PLATFORM_SEARCH_DISABLED')
        return
      }
      finish('PLATFORM_UNEXPECTED_TASK')
    })()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    toolResults,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

/** Read every plausible text file under one member home and report matches. */
async function filesContaining(directory: string, needle: string): Promise<string[]> {
  const matches: string[] = []
  const visit = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name)
      if (entry.isDirectory()) {
        await visit(child)
        continue
      }
      if (!entry.isFile()) continue
      const facts = await stat(child)
      if (facts.size > 256 * 1024) continue
      try {
        if ((await readFile(child, 'utf8')).includes(needle)) matches.push(child)
      } catch {
        /* binary or unreadable file */
      }
    }
  }
  await visit(directory)
  return matches
}

let app: CommunityApplication | undefined
let browser: Browser | undefined
let root: string | undefined
let retrieval: Awaited<ReturnType<typeof startRetrievalUpstream>> | undefined
let model: Awaited<ReturnType<typeof startToolModel>> | undefined
afterEach(async () => {
  await browser?.close()
  await app?.stop()
  await retrieval?.close()
  await model?.close()
  if (root !== undefined) await removeCommunityFixture(root)
  root = undefined
  app = undefined
  browser = undefined
  retrieval = undefined
  model = undefined
})

it('uses the independent platform key for rc.3 search and keeps fetch unavailable', async () => {
  assertPinnedDshRevision(runtimeSettings)
  retrieval = await startRetrievalUpstream()
  model = await startToolModel()
  root = await mkdtemp(join(tmpdir(), 'search-fetch-platform-'))
  const runtime = runtimeSection(root, model.origin, runtimeSettings)
  app = createCommunityApplication(
    { listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'search-fetch-platform-session-32-bytes', runtime },
    { testOnlyWebToolsUpstreamBaseUrl: `${retrieval.origin}/v1/tools` },
  )
  const origin = await app.start()
  browser = await chromium.launch({ headless: true })
  const admin = await browser.newContext({ locale: 'en' })
  const bootstrap = await admin.request.post(`${origin}/bootstrap`, {
    form: {
      credential: readBootstrapCredential(root)!.credential,
      username: 'admin',
      password: 'password',
    },
    headers: { origin },
    maxRedirects: 0,
  })
  expect(bootstrap.status()).toBe(303)
  const save = async (body: object) => {
    const response = await admin.request.post(`${origin}/admin/api/models`, { headers: { origin }, data: body })
    expect(response.status(), await response.text()).toBe(200)
    return (await response.json()) as CommunityModelSettings
  }
  let settings = await save({
    revision: 0,
    action: 'save-provider',
    provider: {
      name: 'Member chat',
      baseUrl: `${model.origin}/anthropic`,
      apiFormat: 'anthropic-messages',
      apiKey: MEMBER_MODEL_KEY,
      enabled: true,
      models: [{ name: 'deepseek-chat', enabled: true }],
    },
  })
  const chatId = settings.providers[0]!.models[0]!.id
  settings = await save({
    revision: settings.revision,
    action: 'save-provider',
    provider: {
      name: 'DeepSeek retrieval',
      baseUrl: 'https://api.deepseek.com/anthropic',
      apiFormat: 'anthropic-messages',
      apiKey: 'distinct-shared-deepseek-key',
      enabled: true,
      models: [{ name: 'deepseek-flash', enabled: true }],
    },
  })
  settings = await save({ revision: settings.revision, action: 'set-default', defaultModelId: chatId })
  const created = await admin.request.post(`${origin}/admin/api/accounts`, {
    headers: { origin },
    data: { username: 'alice', email: 'alice@example.test', password: 'password' },
  })
  expect(created.status()).toBe(201)
  const context = await browser.newContext({ locale: 'en' })
  const page = await context.newPage()
  page.setDefaultTimeout(20_000)
  await signInCommunity(page, origin, 'alice', 'password')
  if ('container' in runtime) throw new Error('This scenario requires native DSH source mode')
  const workspace = instanceWorkspacePath(await defaultWorkspacePath(root, 'alice'), false)
  await selectCommunityWorkspace(context, page, origin, workspace, false)
  const rpc = createRealDshRpc()
  const memberHome = join(await memberSpacePath(root, 'alice'), 'home')
  const inspectMemberProcess = async () => {
    const pids = execFileSync('pgrep', ['-f', runtime.args[0]!], { encoding: 'utf8' }).trim().split('\n')
    for (const pid of pids) {
      const environment =
        process.platform === 'linux'
          ? (await readFile(`/proc/${pid}/environ`, 'utf8').catch(() => '')).replaceAll('\0', ' ')
          : execFileSync('ps', ['eww', '-p', pid], { encoding: 'utf8' })
      if (!environment.includes(`HOME=${memberHome} `)) continue
      expect(environment.includes(PLATFORM_KEY)).toBe(false)
      return {
        hasSearchToken: environment.includes(` ${WEB_TOOLS_MEMBER_TOKEN_ENV}=`),
        gatewayUrl: / DSH_PHALANX_MODEL_GATEWAY_URL=(\S+)/u.exec(environment)?.[1],
      }
    }
    throw new Error('Member DSH process was not found')
  }

  const composer = page.locator('[data-composer-input]')
  const ask = async (text: string, marker: string) => {
    const replies = page.getByText(marker, { exact: true })
    const previous = await replies.count()
    await composer.fill(text)
    await composer.press('Enter')
    await replies.nth(previous).waitFor({ timeout: 120_000 })
  }
  const searchSettings = async (input?: object) => {
    const url = origin + '/admin/api/platform-search'
    const response = input ? await admin.request.post(url, { headers: { origin }, data: input }) : await admin.request.get(url)
    expect(response.ok(), await response.text()).toBe(true)
    return await response.json()
  }
  const initial = await searchSettings()
  expect(initial).toEqual({ enabled: false, hasKey: false, revision: 0 })
  expect((await inspectMemberProcess()).hasSearchToken).toBe(false)
  await ask('PLATFORM_WEB_DISABLED_TASK', 'PLATFORM_SEARCH_DISABLED')
  expect(retrieval.calls).toEqual([])
  const configured = await searchSettings({ action: 'save', revision: initial.revision, enabled: true, apiKey: PLATFORM_KEY })
  await ask('PLATFORM_WEB_DISABLED_TASK after saving', 'PLATFORM_SEARCH_DISABLED')
  const restart = async () => {
    const response = await context.request.post(origin + '/recovery/restart', { headers: { origin }, data: { confirmed: true }, timeout: 300_000 })
    expect(response.ok(), await response.text()).toBe(true)
    await page.reload()
    await page.getByRole('button', { name: /^Platform account:/u }).waitFor()
    await selectCommunityWorkspace(context, page, origin, workspace, false)
  }
  await restart()
  const { hasSearchToken, gatewayUrl } = await inspectMemberProcess()
  expect(hasSearchToken).toBe(true)
  expect(gatewayUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//u)
  const describe = async () =>
    await rpc.remoteRpc<{ namespaces: { ns: string; value: unknown; revision: number }[] }>(
      origin,
      await cookieHeader(context, origin),
      'settings/describe',
      {},
    )
  const native = await describe()
  expect(native.namespaces.find(row => row.ns === 'web-deepseek-api')?.value).toMatchObject({
    searchBaseURL: new URL('/_dsh-phalanx/web/v1/tools', gatewayUrl).href,
    searchApiKeyEnv: WEB_TOOLS_MEMBER_TOKEN_ENV,
    sendOriginalQuestion: false,
  })
  expect(JSON.stringify(native)).not.toContain(PLATFORM_KEY)
  await ask('PLATFORM_WEB_SEARCH_TASK: the user question is private.', 'PLATFORM_SEARCH_CONFIRMED')
  expect(retrieval.calls).toEqual([
    { path: '/v1/tools/search', authorization: `Bearer ${PLATFORM_KEY}`, body: expect.objectContaining({ query: 'fixture query', need_content: false }) },
  ])
  expect(retrieval.calls[0]!.body).not.toHaveProperty('ori_question')
  expect(await filesContaining(memberHome, PLATFORM_KEY)).toEqual([])
  await ask('PLATFORM_WEB_FETCH_TASK', 'PLATFORM_FETCH_UNAVAILABLE')
  // The native settings menu saves through the same DSH settings RPC.
  const setSearchProvider = async (searchProvider: string) => {
    const view = await describe()
    const web = view.namespaces.find(row => row.ns === 'web')
    expect(web).toBeDefined()
    await rpc.remoteRpc(origin, await cookieHeader(context, origin), 'settings/update', {
      ns: 'web',
      patch: { searchProvider },
      expectedRevision: web!.revision,
    })
  }
  await setSearchProvider('deepseek-official')
  await restart()
  await ask('PLATFORM_WEB_DISABLED_TASK after member opts out', 'PLATFORM_SEARCH_DISABLED')
  expect(retrieval.calls).toHaveLength(1)
  await setSearchProvider('deepseek-search-api')
  const rotated = await searchSettings({ action: 'save', revision: configured.revision, enabled: true, apiKey: 'rotated-search-fixture-key' })
  const accounts = await openTestAccounts(root)
  let token: string
  try {
    token = await modelAccessToken(root, 'alice', (await accounts.getState('alice'))!.spaceId)
  } finally {
    await accounts.close()
  }
  const gateway = () =>
    fetch(origin + '/_dsh-phalanx/web/v1/tools/search', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'fixture query', ori_question: 'private original' }),
    })
  expect((await gateway()).status).toBe(200)
  expect(retrieval.calls.at(-1)?.authorization).toBe('Bearer rotated-search-fixture-key')
  expect(retrieval.calls.at(-1)?.body).not.toHaveProperty('ori_question')
  const disabled = await searchSettings({ action: 'save', revision: rotated.revision, enabled: false })
  expect(disabled).toMatchObject({ enabled: false, hasKey: true })
  expect((await gateway()).status).toBe(503)
  await restart()
  expect((await inspectMemberProcess()).hasSearchToken).toBe(false)
  await ask('PLATFORM_WEB_DISABLED_TASK after restart', 'PLATFORM_SEARCH_DISABLED')
  expect(await searchSettings({ action: 'clear', revision: disabled.revision })).toMatchObject({ enabled: false, hasKey: false })
}, 300_000)
