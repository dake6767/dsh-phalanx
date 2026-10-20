// Validation: T2; real credentials: none; verified installed modules with test injection, real rootless DSH and administrator UI.
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { injectedCandidateApplication } from './support/injected-candidate-application.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { assertPinnedDshRevision, runtimeSection, defaultWorkspacePath, instanceWorkspacePath } from './support/real-dsh-runtime.js'
import { cookieHeader, createBrowserDshRpc } from './support/real-dsh-rpc.js'
import { hasToolResult, latestHumanText, streamText, streamToolCall } from './support/real-dsh-model.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import { signInCommunity } from './fixtures/community-native-browser.js'
import type { CommunityUsageRecords } from '../src/domain/admin-contract.js'

it('shows native search and fetch usage and imports legacy MCP tools once across installed restarts', async () => {
  assertPinnedDshRevision(runtimeSettings)
  const root = await mkdtemp(join(tmpdir(), 'usage-web-tools-')), completed = new Set<string>()
  let status = 200
  const model = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw), marker = latestHumanText(body)
    response.setHeader('content-type', 'text/event-stream')
    if (marker.startsWith('USE_WEB_')) {
      if (!hasToolResult(body, marker, false) && !hasToolResult(body, marker, true)) {
        const fetch = marker === 'USE_WEB_FETCH'
        streamToolCall(response, marker, fetch ? 'web_fetch' : 'web_search', fetch ? { url: 'https://example.test/PRIVATE_TARGET' } : { queries: ['PRIVATE_QUERY'] }); return
      }
      completed.add(marker)
    }
    streamText(response, 'WEB_USAGE_COMPLETE')
  })
  const upstream = createServer(async (request, response) => {
    for await (const chunk of request) void chunk
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(request.url?.endsWith('/fetch') ? { content: 'PRIVATE_FETCH_OUTPUT' } : { results: [{ title: 'Fixture', url: 'https://example.test/result', snippet: 'PRIVATE_SEARCH_OUTPUT', date: null }] }))
  })
  for (const server of [model, upstream]) { server.listen(0, '127.0.0.1'); await once(server, 'listening') }
  const address = (server: typeof model) => `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const runtime = runtimeSection(join(root, 'platform'), address(model), runtimeSettings)
  const overlay = join(root, 'native-tools.json'); await writeFile(overlay, JSON.stringify([{ id: 'tools', config: { mode: 'native' } }]))
  runtime.patches.push(overlay)
  const legacy = join(runtime.dataRoot, 'mcp', 'audit.json'), historic = { username: 'legacy', service: 'p-history', method: 'tools/call', tool: 'old-read', status: 'success', startedAt: Date.now() - 1000, durationMs: 10 }
  const legacyBytes = JSON.stringify([historic, historic, { ...historic, method: 'initialize' }])
  await mkdir(join(runtime.dataRoot, 'mcp'), { recursive: true }); await writeFile(legacy, legacyBytes)
  const config = { listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'usage-web-tools-installed-fixture-secret', runtime }
  const options = { testOnlyWebToolsUpstreamBaseUrl: address(upstream) + '/v1/tools' }
  let app = injectedCandidateApplication(config, options)
  const browser = await chromium.launch({ headless: true })
  let failure: unknown
  const cleanupErrors: unknown[] = []
  try {
    let origin = await app.start()
    const admin = await browser.newPage({ locale: 'en' }); admin.setDefaultTimeout(30000)
    expect((await admin.request.post(origin + '/bootstrap', { headers: { origin }, form: { credential: readBootstrapCredential(runtime.dataRoot)!.credential, username: 'admin', password: 'password' }, maxRedirects: 0 })).status()).toBe(303)
    const api = async (path: string, data?: object) => {
      const response = data ? await admin.request.post(origin + '/admin/api/' + path, { headers: { origin }, data }) : await admin.request.get(origin + '/admin/api/' + path)
      expect(response.ok(), await response.text()).toBe(true); return response.json()
    }
    let models = await api('models')
    models = await api('models', { revision: models.revision, action: 'save-provider', provider: { name: 'Fixture', baseUrl: address(model) + '/anthropic', apiFormat: 'anthropic-messages', apiKey: 'fictional-model-key', enabled: true, models: [{ name: 'usage-model', enabled: true }] } })
    await api('models', { revision: models.revision, action: 'save-provider', provider: { name: 'Retrieval', baseUrl: 'https://api.deepseek.com/anthropic', apiFormat: 'anthropic-messages', apiKey: 'fictional-retrieval-key', enabled: true, models: [{ name: 'deepseek-flash', enabled: true }] } })
    const account = await api('accounts', { username: 'member', password: 'password', email: '' })
    const member = await browser.newPage({ locale: 'en' }); member.setDefaultTimeout(30000)
    await signInCommunity(member, origin, 'member', 'password')
    await member.getByRole('button', { name: 'Plugins', exact: true }).click()
    await member.getByRole('heading', { name: 'Built-in plugin settings', exact: true }).waitFor()
    await member.getByRole('button', { name: 'View Web search', exact: true }).click()
    await member.getByRole('switch', { name: 'Use the new Web Search API', exact: true }).click()
    await member.getByRole('button', { name: 'Save', exact: true }).click()
    await expect.poll(() => member.getByRole('button', { name: 'Save', exact: true }).isDisabled()).toBe(true)
    const rpc = createBrowserDshRpc(member.context()), cookie = await cookieHeader(member.context(), origin)
    const prompt = async (marker: string) => {
      const session = await rpc.remoteRpc<{ sessionId: string }>(origin, cookie, 'session/create', { request: { cwd: instanceWorkspacePath(defaultWorkspacePath(runtime.dataRoot, 'member'), 'container' in runtime) } })
      await rpc.remoteRpc(origin, cookie, 'session/prompt', { request: { requestId: randomUUID(), sessionId: session.sessionId, mode: 'queue', content: [{ type: 'text', text: marker }] } })
      await expect.poll(() => completed.has(marker), { timeout: 90000 }).toBe(true)
      await expect.poll(async () => (await rpc.remoteRpc<{ items: { sessionId: string, running: boolean }[] }>(origin, cookie, 'session/list', { _request: {} })).items.find(row => row.sessionId === session.sessionId)?.running, { timeout: 30000 }).toBe(false)
    }
    await prompt('USE_WEB_SEARCH'); await prompt('USE_WEB_FETCH'); status = 429; await prompt('USE_WEB_LIMITED')
    const records = await api('usage-records') as CommunityUsageRecords
    expect(records.total).toBe(5)
    expect(records.items.filter(row => row.capability.kind === 'web-tools')).toMatchObject([
      { username: 'member', groupId: account.groupId, capability: { operation: 'search' }, outcome: 'failed', httpStatus: 429 },
      { capability: { operation: 'fetch' }, outcome: 'succeeded', httpStatus: 200 },
      { capability: { operation: 'search' }, outcome: 'succeeded', httpStatus: 200 },
    ])
    expect(records.items.filter(row => row.username === 'legacy')).toHaveLength(2)
    expect(records.items.filter(row => row.username === 'legacy').every(row => row.groupId === null && row.capability.operation === 'old-read')).toBe(true)
    expect(JSON.stringify(records)).not.toMatch(/PRIVATE_|fictional-|Bearer/)
    await admin.goto(origin + '/admin/usage-records')
    const grid = admin.getByRole('grid', { name: 'Tool usage records', exact: true })
    await grid.getByText('Web tools', { exact: true }).first().waitFor()
    await grid.getByText('old-read', { exact: true }).first().waitFor()
    await admin.getByLabel('Filter by capability', { exact: true }).fill('web-tools')
    await admin.getByLabel('Filter by operation', { exact: true }).fill('fetch')
    await admin.getByRole('button', { name: 'Apply filters', exact: true }).click()
    await expect.poll(() => grid.getByRole('row').count()).toBe(2)
    await app.stop(); app = injectedCandidateApplication(config, options); origin = await app.start()
    const reopened = await api('usage-records') as CommunityUsageRecords
    expect(reopened.total).toBe(5); expect(await api('usage-settings')).toEqual({ retentionDays: 180 })
    expect(await readFile(legacy, 'utf8')).toBe(legacyBytes)
  } catch (error) { failure = error }
  finally {
    for (const cleanup of [() => browser.close(), () => app.stop(), () => new CommunityRuntimeDriver(runtime).rebuild(),
      ...[model, upstream].map(server => async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }), () => rm(root, { recursive: true, force: true })]) {
      try { await cleanup() } catch (error) { cleanupErrors.push(error) }
    }
  }
  if (failure || cleanupErrors.length) throw new AggregateError([...(failure ? [failure] : []), ...cleanupErrors], 'Web usage acceptance or cleanup failed')
})
