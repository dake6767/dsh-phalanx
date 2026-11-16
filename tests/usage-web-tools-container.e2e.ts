// Validation: T2; real credentials: none; verified installed modules with test injection, real rootless DSH and administrator UI.
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdtemp, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { WEB_TOOLS_GATEWAY_PATHS } from '../src/dsh/web-tools.js'
import { modelAccessToken } from './support/community-application.js'
import { injectedCandidateApplication } from './support/injected-candidate-application.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { assertPinnedDshRevision, runtimeSection, defaultWorkspacePath, instanceWorkspacePath } from './support/real-dsh-runtime.js'
import { cookieHeader, createBrowserDshRpc } from './support/real-dsh-rpc.js'
import { hasToolResult, latestHumanText, streamText, streamToolCall } from './support/real-dsh-model.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import { signInCommunity } from './fixtures/community-native-browser.js'
import type { CommunityUsageRecords } from '../src/domain/admin-contract.js'
import { removeCommunityFixture } from './fixtures/owned-cleanup.js'

it('retains gateway search usage across installed restarts while native retrieval is unavailable', async () => {
  assertPinnedDshRevision(runtimeSettings)
  const root = await mkdtemp(join(tmpdir(), 'usage-web-tools-')),
    completed = new Set<string>()
  let status = 200,
    fetchCalls = 0,
    searchCalls = 0
  const failedTools = new Set<string>()
  const model = createServer(async (request, response) => {
    let raw = ''
    for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw),
      marker = latestHumanText(body)
    const tools = (body.tools ?? []).map((tool: { name: string }) => tool.name)
    expect(tools).not.toContain('web_fetch')
    expect(tools).not.toContain('web_search')
    if (hasToolResult(body, marker, true)) failedTools.add(marker)
    response.setHeader('content-type', 'text/event-stream')
    if (marker.startsWith('USE_WEB_')) {
      if (!hasToolResult(body, marker, false) && !hasToolResult(body, marker, true)) {
        const fetch = marker === 'USE_WEB_FETCH'
        streamToolCall(
          response,
          marker,
          fetch ? 'web_fetch' : 'web_search',
          fetch ? { url: 'https://example.test/PRIVATE_TARGET' } : { queries: ['PRIVATE_QUERY'] },
        )
        return
      }
      completed.add(marker)
    }
    streamText(response, 'WEB_USAGE_COMPLETE')
  })
  const upstream = createServer(async (request, response) => {
    for await (const chunk of request) void chunk
    if (request.url?.endsWith('/fetch')) fetchCalls++
    if (request.url?.endsWith('/search')) searchCalls++
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify(
        request.url?.endsWith('/fetch')
          ? { content: 'PRIVATE_FETCH_OUTPUT' }
          : { results: [{ title: 'Fixture', url: 'https://example.test/result', snippet: 'PRIVATE_SEARCH_OUTPUT', date: null }] },
      ),
    )
  })
  for (const server of [model, upstream]) {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
  }
  const address = (server: typeof model) => `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const runtime = runtimeSection(join(root, 'platform'), address(model), runtimeSettings)
  const overlay = join(root, 'native-tools.json')
  await writeFile(overlay, JSON.stringify([]))
  runtime.patches.push(overlay)
  const config = { listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'usage-web-tools-installed-fixture-secret', runtime }
  const options = { testOnlyWebToolsUpstreamBaseUrl: address(upstream) + '/v1/tools' }
  let app = injectedCandidateApplication(config, options)
  const browser = await chromium.launch({ headless: true })
  let failure: unknown
  const cleanupErrors: unknown[] = []
  try {
    let origin = await app.start()
    const admin = await browser.newPage({ locale: 'en' })
    admin.setDefaultTimeout(30000)
    expect(
      (
        await admin.request.post(origin + '/bootstrap', {
          headers: { origin },
          form: { credential: readBootstrapCredential(runtime.dataRoot)!.credential, username: 'admin', password: 'password' },
          maxRedirects: 0,
        })
      ).status(),
    ).toBe(303)
    const api = async (path: string, data?: object) => {
      const response = data
        ? await admin.request.post(origin + '/admin/api/' + path, { headers: { origin }, data })
        : await admin.request.get(origin + '/admin/api/' + path)
      expect(response.ok(), await response.text()).toBe(true)
      return response.json()
    }
    const models = await api('models')
    await api('models', {
      revision: models.revision,
      action: 'save-provider',
      provider: {
        name: 'Fixture',
        baseUrl: address(model) + '/anthropic',
        apiFormat: 'anthropic-messages',
        apiKey: 'fictional-model-key',
        enabled: true,
        models: [{ name: 'usage-model', enabled: true }],
      },
    })
    const account = await api('accounts', { username: 'member', password: 'password', email: '' })
    const member = await browser.newPage({ locale: 'en' })
    member.setDefaultTimeout(30000)
    await signInCommunity(member, origin, 'member', 'password')
    const rpc = createBrowserDshRpc(member.context()),
      cookie = await cookieHeader(member.context(), origin)
    const prompt = async (marker: string) => {
      const session = await rpc.remoteRpc<{ sessionId: string }>(origin, cookie, 'session/create', {
        request: { cwd: instanceWorkspacePath(await defaultWorkspacePath(runtime.dataRoot, 'member'), 'container' in runtime) },
      })
      await rpc.remoteRpc(origin, cookie, 'session/prompt', {
        request: { requestId: randomUUID(), sessionId: session.sessionId, mode: 'queue', content: [{ type: 'text', text: marker }] },
      })
      await expect.poll(() => completed.has(marker), { timeout: 90000 }).toBe(true)
      await expect
        .poll(
          async () =>
            (await rpc.remoteRpc<{ items: { sessionId: string; running: boolean }[] }>(origin, cookie, 'session/list', { _request: {} })).items.find(
              row => row.sessionId === session.sessionId,
            )?.running,
          { timeout: 30000 },
        )
        .toBe(false)
    }
    await prompt('USE_WEB_SEARCH')
    await prompt('USE_WEB_FETCH')
    expect(failedTools.has('USE_WEB_SEARCH')).toBe(true)
    expect(failedTools.has('USE_WEB_FETCH')).toBe(true)
    expect(fetchCalls).toBe(0)
    expect(searchCalls).toBe(0)
    const token = await modelAccessToken(runtime.dataRoot, 'member', account.spaceId)
    const gatewayOrigin = runtimeSettings.containerImage === undefined ? origin : `http://127.0.0.1:${runtimeSettings.containerGatewayPort}`
    const search = () =>
      fetch(gatewayOrigin + WEB_TOOLS_GATEWAY_PATHS.search, {
        method: 'POST',
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: JSON.stringify({ query: 'PRIVATE_QUERY' }),
      })
    const siteSearch = await api('platform-search')
    await api('platform-search', { action: 'save', revision: siteSearch.revision, enabled: true, apiKey: 'fictional-retrieval-key' })
    const successful = await search()
    expect(successful.status).toBe(200)
    expect(await successful.text()).toContain('PRIVATE_SEARCH_OUTPUT')
    status = 429
    const limited = await search()
    expect(limited.status).toBe(429)
    await limited.text()
    const records = (await api('usage-records')) as CommunityUsageRecords
    expect(records.total).toBe(2)
    expect(records.items.filter(row => row.capability.kind === 'web-tools')).toMatchObject([
      { username: 'member', groupId: account.groupId, capability: { operation: 'search' }, outcome: 'failed', httpStatus: 429 },
      { capability: { operation: 'search' }, outcome: 'succeeded', httpStatus: 200 },
    ])
    expect(JSON.stringify(records)).not.toMatch(/PRIVATE_|fictional-|Bearer/)
    // hidden in 0.1.32: preserve capability/operation filtering through the API.
    expect((await api('usage-records?capability=web-tools&operation=search')).items).toEqual(records.items)
    await app.stop()
    app = injectedCandidateApplication(config, options)
    origin = await app.start()
    const reopened = (await api('usage-records')) as CommunityUsageRecords
    expect(reopened.total).toBe(2)
    expect(await api('usage-settings')).toEqual({ retentionDays: 180 })
    expect(reopened.items).toEqual(records.items)
    await expect(stat(join(runtime.dataRoot, 'mcp/audit.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  } catch (error) {
    failure = error
  } finally {
    for (const cleanup of [
      () => browser.close(),
      () => app.stop(),
      () => new CommunityRuntimeDriver(runtime).rebuild(),
      ...[model, upstream].map(server => async () => {
        server.closeAllConnections()
        await new Promise<void>(resolve => server.close(() => resolve()))
      }),
      () => removeCommunityFixture(root),
    ]) {
      try {
        await cleanup()
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
  }
  if (failure || cleanupErrors.length) throw new AggregateError([...(failure ? [failure] : []), ...cleanupErrors], 'Web usage acceptance or cleanup failed')
})
