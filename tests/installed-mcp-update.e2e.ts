import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, writeFile, rm, readdir, chmod, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { candidateApplication } from './support/candidate-application.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { runtimeSection, assertPinnedDshRevision } from './support/real-dsh-runtime.js'
import { createRealDshRpc, cookieHeader } from './support/real-dsh-rpc.js'
import { latestHumanText, streamText, streamToolCall, hasToolResult } from './support/real-dsh-model.js'
import { readPrivateMcpCredential } from './support/real-mcp-credentials.js'
import { signInCommunity } from './fixtures/community-native-browser.js'

it('updates an installed prior-preset fixture without replacing the live credential or member selection on failure', async () => {
  if (process.platform !== 'linux' || process.getuid?.() === 0 || !process.env.DSH_PHALANX_INSTALL_ROOT || !process.env.DSH_PHALANX_CANDIDATE_SHA || !runtimeSettings.containerImage || !process.env.DSH_PHALANX_AMAP_API_KEY_FILE) throw Error('Requires an exact installed candidate, dedicated rootless Linux and a protected Amap key file')
  assertPinnedDshRevision(runtimeSettings)
  const secret = await readPrivateMcpCredential(process.env.DSH_PHALANX_AMAP_API_KEY_FILE)
  const results: Record<string, { valid: boolean, failed: boolean, tools: string[] }> = {}
  let exposed = false, passed = false
  const model = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk
    exposed ||= text.includes(secret)
    const body = JSON.parse(text), marker = latestHumanText(body)
    response.setHeader('content-type', 'text/event-stream')
    if (hasToolResult(body, marker, false) || hasToolResult(body, marker, true)) {
      const blocks = (body.messages ?? []).flatMap((row: { content?: unknown }) => Array.isArray(row.content) ? row.content : []).filter((row: { type?: string, tool_use_id?: string }) => row.type === 'tool_result' && row.tool_use_id === marker)
      results[marker] = { valid: /北京市|北京/u.test(JSON.stringify(blocks)), failed: hasToolResult(body, marker, true), tools: (body.tools ?? []).map((tool: { name: string }) => tool.name).filter((name: string) => name.startsWith('mcp__')) }
      streamText(response, 'UPDATE_DONE')
    } else streamToolCall(response, marker, 'mcp__p-amap__maps_weather', { city: '110000' })
  })
  model.listen(0, '127.0.0.1'); await once(model, 'listening')
  const modelOrigin = `http://127.0.0.1:${(model.address() as { port: number }).port}`
  const root = await mkdtemp(join(tmpdir(), 'installed-preset-update-')), runtime = runtimeSection(root, modelOrigin, runtimeSettings)
  const config = { listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'installed-update-fixture-session-secret', runtime }
  let app = candidateApplication(config), origin = '', groupId = ''
  const browser = await chromium.launch({ headless: true }), admin = await browser.newPage({ locale: 'en' }), member = await browser.newPage({ locale: 'en' })
  admin.setDefaultTimeout(60000); member.setDefaultTimeout(60000)
  const post = (path: string, data: object) => admin.request.post(origin + '/admin/api/' + path, { headers: { origin }, data })
  const get = async (path: string) => (await admin.request.get(origin + '/admin/api/' + path)).json()
  const row = async () => (await get('mcp'))[0]
  try {
    origin = await app.start()
    expect((await admin.request.post(origin + '/bootstrap', { headers: { origin }, form: { credential: readBootstrapCredential(root)!.credential, username: 'admin', password: 'password' }, maxRedirects: 0 })).status()).toBe(303)
    const settings = await get('models')
    expect((await post('models', { revision: settings.revision, action: 'save-provider', provider: { name: 'Fixture', baseUrl: modelOrigin + '/anthropic', apiFormat: 'anthropic-messages', apiKey: 'fictional-model-key', enabled: true, models: [{ name: 'fixture-model', enabled: true }] } })).status()).toBe(200)
    const account = await post('accounts', { username: 'member', password: 'password', email: '' }); expect(account.status()).toBe(201); groupId = (await account.json()).groupId
    expect((await post('mcp/catalog', { action: 'import', input: { presetId: 'amap', name: 'p-amap', credential: secret, requestId: 'installed-update-original-import' } })).status()).toBe(202)
    await expect.poll(async () => (await row())?.catalog.status, { timeout: 90000 }).toBe('ready')
    const original = await row(), disabledTools = original.tools.filter((tool: { name: string }) => tool.name !== 'maps_weather').map((tool: { name: string }) => tool.name)
    expect((await post('mcp', { action: 'save', service: { name: original.name, description: original.description, url: original.url, run: original.run, headers: original.headers, query: original.query, disabledTools } })).status()).toBe(200)
    expect((await (await post('mcp/test', { name: 'p-amap' })).json()).testStatus).toBe('passed')
    expect((await post('mcp', { action: 'publish', name: 'p-amap', published: true })).status()).toBe(200)
    await signInCommunity(member, origin, 'member', 'password')
    expect((await member.request.post(origin + '/market/api/mcp', { headers: { origin }, data: { name: 'p-amap', action: 'enable' } })).status()).toBe(200)
    await app.stop()
    // Explicit prior-version persistence fixture; no historic released preset is claimed.
    // Candidate executable and preset source stay unchanged throughout this test.
    const file = join(root, 'mcp/library.json'), stored = JSON.parse(await readFile(file, 'utf8'))
    stored.services[0].catalog.version = '0'; stored.services[0].description = 'Previous Amap preset'
    await writeFile(file, JSON.stringify(stored), { mode: 0o600 })
    app = candidateApplication(config); origin = await app.start()
    await admin.context().clearCookies(); await member.context().clearCookies()
    expect((await admin.request.post(origin + '/login', { headers: { origin }, form: { username: 'admin', password: 'password' }, maxRedirects: 0 })).status()).toBe(303)
    await signInCommunity(member, origin, 'member', 'password')
    const rpc = createRealDshRpc(), cookie = await cookieHeader(member.context(), origin)
    const session = await rpc.remoteRpc<{ sessionId: string }>(origin, cookie, 'session/create', { request: { cwd: '/dsh-phalanx/workspace' } })
    const call = async (marker: string) => {
      await rpc.remoteRpc(origin, cookie, 'session/prompt', { request: { requestId: randomUUID(), sessionId: session.sessionId, mode: 'queue', content: [{ type: 'text', text: marker }] } })
      await expect.poll(() => Boolean(results[marker]), { timeout: 90000 }).toBe(true)
      expect(results[marker]).toEqual({ valid: true, failed: false, tools: ['mcp__p-amap__maps_weather'] })
      await expect.poll(async () => (await rpc.remoteRpc<{ items: { sessionId: string, running: boolean }[] }>(origin, cookie, 'session/list', { _request: {} })).items.find(item => item.sessionId === session.sessionId)?.running, { timeout: 30000 }).toBe(false)
    }
    await call('BEFORE_UPDATE')
    expect((await member.request.get(origin + '/admin/api/mcp/catalog')).status()).toBe(403)
    expect((await post('mcp/catalog/update', { name: 'p-amap', version: '1', credential: 'fictional-invalid-market-update-key', requestId: 'installed-update-failed-key' })).status()).toBe(202)
    await expect.poll(async () => (await row()).catalogUpdate?.status, { timeout: 90000 }).toBe('failed')
    expect(await row()).toMatchObject({ description: 'Previous Amap preset', published: true, credentialConfigured: true, catalog: { version: '0' } })
    await call('AFTER_FAILED_UPDATE')
    await admin.goto(origin + '/admin'); await admin.getByRole('link', { name: 'MCP library', exact: true }).click()
    await admin.getByRole('button', { name: 'Review catalog update', exact: true }).click()
    await admin.getByText('Catalog update 0 → 1', { exact: true }).waitFor()
    expect((await admin.content()).includes(secret)).toBe(false)
    await admin.getByRole('button', { name: 'Validate and update', exact: true }).click()
    await expect.poll(async () => (await row()).catalogUpdate?.status, { timeout: 90000 }).toBe('applied')
    expect(await row()).toMatchObject({ description: 'Amap', published: true, credentialConfigured: true, disabledTools, catalog: { version: '1' } })
    await call('AFTER_APPLIED_UPDATE')
    const visible = await (await member.request.get(origin + '/market/api/mcp')).json()
    expect(visible[0]).toMatchObject({ name: 'p-amap', enabled: true })
    expect(JSON.stringify(visible).includes(secret)).toBe(false); expect((await readFile(join(root, 'mcp/audit.json'), 'utf8')).includes(secret)).toBe(false)
    expect((await member.request.get(origin + '/admin/api/mcp/catalog')).status()).toBe(403)
    expect((await get(`groups/${groupId}/mcp`)).services.find((service: { name: string }) => service.name === 'p-amap').granted).toBe(false)
    expect(exposed).toBe(false); passed = true
  } catch (error) {
    throw new Error(String(error).replaceAll(secret, '[redacted]').replaceAll(encodeURIComponent(secret), '[redacted]'))
  } finally {
    await browser.close(); await app.stop(); await new CommunityRuntimeDriver(runtime).rebuild()
    model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve()))
    const writable = async (path: string): Promise<void> => { if ((await lstat(path)).isDirectory()) { await chmod(path, 0o700); for (const name of await readdir(path)) await writable(join(path, name)) } }
    await writable(root); await rm(root, { recursive: true, force: true })
    if (process.env.DSH_PHALANX_E2E_EVIDENCE_DIR) await writeFile(join(process.env.DSH_PHALANX_E2E_EVIDENCE_DIR, 'installed-update-result.json'), JSON.stringify({ passed, priorPresetIsControlledFixture: true, candidate: process.env.DSH_PHALANX_CANDIDATE_SHA, exposed, results }) + '\n')
  }
}, 900000)
