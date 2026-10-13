import { createServer } from 'node:http'
import { once } from 'node:events'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { candidateApplication } from './support/candidate-application.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import { execFileText } from '../src/adapters/runtime-command.js'
import { runtimeSection, assertPinnedDshRevision } from './support/real-dsh-runtime.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { createRealDshRpc, cookieHeader } from './support/real-dsh-rpc.js'
import { latestHumanText, streamText } from './support/real-dsh-model.js'
import { signInCommunity } from './fixtures/community-native-browser.js'

it('toggles granted and published MCP through the native app center and preserves choices across resets and restarts', async () => {
  assertPinnedDshRevision(runtimeSettings)
  const root = await mkdtemp(join(tmpdir(), 'mcp-market-')), observations: { marker: string, tools: string[] }[] = []
  const model = createServer(async (req, res) => {
    let data = ''; for await (const chunk of req) data += chunk
    const body = JSON.parse(data), marker = latestHumanText(body)
    observations.push({ marker, tools: (body.tools ?? []).map((tool: { name: string }) => tool.name) })
    res.setHeader('content-type', 'text/event-stream'); streamText(res, 'DONE_' + marker)
  })
  model.listen(0, '127.0.0.1'); await once(model, 'listening')
  const modelOrigin = `http://127.0.0.1:${(model.address() as { port: number }).port}`
  let diagnosticFailure = false
  const upstream = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
    let data = ''; for await (const chunk of req) data += chunk
    const body = JSON.parse(data)
    if (body.id === undefined) { res.writeHead(202); res.end(); return }
    if (diagnosticFailure) { res.writeHead(503); res.end(); return }
    const result = body.method === 'initialize' ? { protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
      : { tools: ['read', 'write'].map(name => ({ name, description: name + ' data', inputSchema: { type: 'object' } })) }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }))
  })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
  const upstreamUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}/mcp`
  const runtime = runtimeSection(join(root, 'platform'), modelOrigin, runtimeSettings)
  const config = { listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'mcp-market-fixture-session-secret', runtime }
  let app = candidateApplication(config), origin = '', admin = '', carrier = '', passed = false
  const browser = await chromium.launch({ headless: true }), page = await browser.newPage({ locale: 'en', viewport: { width: 1440, height: 1000 } })
  if (process.env.DSH_PHALANX_E2E_CPU_THROTTLE) await (await page.context().newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: 4 })
  page.setDefaultTimeout(30000)
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
  const post = (path: string, body: object) => fetch(origin + '/admin/api/' + path, { method: 'POST', headers: { cookie: admin, origin, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const service = (name: string, required = false) => ({ name, required, description: name + ' tools', url: upstreamUrl, disabledTools: ['write'] })
  const rpc = createRealDshRpc()
  try {
    origin = await app.start()
    const bootstrap = await fetch(origin + '/bootstrap', { method: 'POST', redirect: 'manual', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ credential: readBootstrapCredential(runtime.dataRoot)!.credential, username: 'admin', password: 'password' }) })
    expect(bootstrap.status).toBe(303); admin = bootstrap.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    const settings = await (await fetch(origin + '/admin/api/models', { headers: { cookie: admin } })).json()
    expect((await post('models', { revision: settings.revision, action: 'save-provider', provider: { name: 'Fixture', baseUrl: modelOrigin + '/anthropic', apiFormat: 'anthropic-messages', apiKey: 'fictional-fixture-key', enabled: true, models: [{ name: 'fixture-model', enabled: true }] } })).status).toBe(200)
    const created = await post('accounts', { username: 'member', password: 'password', email: '' }); expect(created.status).toBe(201)
    const account = await created.json() as { groupId: string }
    for (const name of ['p-team', 'p-store']) {
      expect((await post('mcp', { action: 'save', service: service(name) })).status).toBe(200)
      expect((await post('mcp', { action: 'publish', name, published: true })).status).toBe(409)
      expect((await (await post('mcp/test', { name })).json()).testStatus).toBe('passed')
    }
    expect((await post('groups/' + account.groupId + '/mcp', { names: ['p-team'] })).status).toBe(200)
    expect((await post('mcp', { action: 'publish', name: 'p-store', published: true })).status).toBe(200)
    await signInCommunity(page, origin, 'member', 'password')
    const owner = createHash('sha256').update(runtime.dataRoot).digest('hex')
    carrier = (await execFileText('podman', ['ps', '--filter', `label=dsh-phalanx.community-root=${owner}`, '--format', '{{.Names}}'])).trim()
    if (process.env.DSH_PHALANX_E2E_CPU_THROTTLE) await execFileText('podman', ['update', '--cpus', '0.5', carrier])
    const before = JSON.parse(await execFileText('podman', ['inspect', carrier]))[0]
    const member = await cookieHeader(page.context(), origin)
    const session = await rpc.remoteRpc<{ sessionId: string }>(origin, member, 'session/create', { request: { cwd: '/dsh-phalanx/workspace' } })
    const prompt = async (marker: string) => {
      await rpc.remoteRpc(origin, member, 'session/prompt', { request: { requestId: randomUUID(), sessionId: session.sessionId, mode: 'queue', content: [{ type: 'text', text: marker }] } })
      await expect.poll(() => observations.some(row => row.marker === marker), { timeout: 60000 }).toBe(true)
      await expect.poll(async () => (await rpc.remoteRpc<{ items: { id: string, running: boolean }[] }>(origin, member, 'session/list', { _request: {} })).items.find(row => row.id === session.sessionId)?.running, { timeout: 30000 }).not.toBe(true)
      return observations.find(row => row.marker === marker)!.tools.filter(name => name.startsWith('mcp__'))
    }
    const open = async () => { await page.getByRole('button', { name: 'Platform App Center', exact: true }).click(); await page.getByRole('tab', { name: 'MCP services', exact: true }).click() }
    await open()
    const team = page.getByRole('switch', { name: 'Enable MCP service p-team', exact: true }), store = page.getByRole('switch', { name: 'Enable MCP service p-store', exact: true })
    await expect.poll(() => team.getAttribute('aria-checked')).toBe('true'); expect(await store.getAttribute('aria-checked')).toBe('false')
    expect(await prompt('GRANTED')).toEqual(['mcp__p-team__read'])
    const market = await (await page.request.get(origin + '/market/api/mcp')).json()
    expect(Object.keys(market[0]).sort()).toEqual(['description', 'enabled', 'granted', 'name', 'required', 'tools'])
    expect(market.flatMap((row: { tools: { name: string }[] }) => row.tools).every((tool: { name: string }) => tool.name === 'read')).toBe(true)
    await page.getByRole('button', { name: 'View MCP tools for p-team', exact: true }).click()
    await page.getByRole('dialog').getByText('read', { exact: true }).waitFor(); expect(await page.getByRole('dialog').getByText('write', { exact: true }).count()).toBe(0)
    await page.getByRole('button', { name: 'Close MCP tools', exact: true }).click()
    await team.click(); await expect.poll(() => team.getAttribute('aria-checked')).toBe('false'); expect(await prompt('DISABLED')).toEqual([])
    const direct = await execFileText('podman', ['exec', carrier, 'node', '-e', "fetch(new URL('/mcp/p-team',process.env.DSH_PHALANX_MODEL_GATEWAY_URL),{headers:{authorization:'Bearer '+process.env.DSH_PHALANX_MODEL_GATEWAY_ACCESS_TOKEN}}).then(r=>process.stdout.write(String(r.status)))"])
    expect(direct).toBe('403')
    expect((await post('mcp', { action: 'save', service: service('p-team', true) })).status).toBe(200)
    await page.getByRole('button', { name: 'Reload MCP services', exact: true }).click()
    await expect.poll(() => team.isDisabled()).toBe(true); expect(await team.getAttribute('aria-checked')).toBe('true')
    expect(await prompt('REQUIRED')).toEqual(['mcp__p-team__read'])
    expect((await page.request.post(origin + '/market/api/mcp', { data: { name: 'p-team', action: 'disable' } })).status()).toBe(403)
    expect((await post('mcp', { action: 'save', service: service('p-team') })).status).toBe(200)
    await page.getByRole('button', { name: 'Reload MCP services', exact: true }).click()
    await expect.poll(() => team.isEnabled()).toBe(true); expect(await team.getAttribute('aria-checked')).toBe('false')
    await store.click(); await expect.poll(() => store.getAttribute('aria-checked')).toBe('true'); expect(await prompt('SELECTED')).toEqual(['mcp__p-store__read'])
    diagnosticFailure = true
    expect((await (await post('mcp/test', { name: 'p-store' })).json()).testStatus).toBe('failed')
    diagnosticFailure = false
    expect((await post('mcp', { action: 'save', service: { ...service('p-store'), credential: 'rotated-fictional-key' } })).status).toBe(200)
    await page.getByRole('button', { name: 'Reload MCP services', exact: true }).click()
    await expect.poll(() => store.getAttribute('aria-checked')).toBe('true')
    expect(await prompt('ROTATED')).toEqual(['mcp__p-store__read'])
    expect((await (await post('mcp/test', { name: 'p-store' })).json()).testStatus).toBe('passed')
    expect((await post('mcp', { action: 'publish', name: 'p-store', published: false })).status).toBe(200)
    await page.getByRole('button', { name: 'Reload MCP services', exact: true }).click(); await expect.poll(() => store.count()).toBe(0)
    expect(await prompt('UNPUBLISHED')).toEqual([])
    expect((await post('mcp', { action: 'publish', name: 'p-store', published: true })).status).toBe(200)
    await page.getByRole('button', { name: 'Reload MCP services', exact: true }).click(); await expect.poll(() => store.getAttribute('aria-checked')).toBe('false')
    await store.click(); await expect.poll(() => store.getAttribute('aria-checked')).toBe('true')
    const after = JSON.parse(await execFileText('podman', ['inspect', carrier]))[0]
    expect(after.Id).toBe(before.Id); expect(after.State.StartedAt).toBe(before.State.StartedAt)
    const evidence = process.env.DSH_PHALANX_E2E_EVIDENCE_DIR
    if (evidence) await page.screenshot({ path: join(evidence, 'mcp-market-desktop.png'), fullPage: true })
    await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    if (evidence) await page.screenshot({ path: join(evidence, 'mcp-market-mobile.png'), fullPage: true })
    expect((await post('accounts/member/reset-environment', { confirmed: true })).status).toBe(200)
    await signInCommunity(page, origin, 'member', 'password'); await open()
    await expect.poll(() => store.getAttribute('aria-checked')).toBe('true'); expect(await team.getAttribute('aria-checked')).toBe('false')
    await app.stop(); app = candidateApplication(config); origin = await app.start()
    await signInCommunity(page, origin, 'member', 'password'); await open()
    await expect.poll(() => store.getAttribute('aria-checked')).toBe('true'); expect(await team.getAttribute('aria-checked')).toBe('false')
    expect(errors).toEqual([]); passed = true
  } finally {
    const evidence = process.env.DSH_PHALANX_E2E_EVIDENCE_DIR
    if (evidence) { await writeFile(join(evidence, 'mcp-market-result.json'), JSON.stringify({ passed, observations }, null, 2)); if (!passed) await page.screenshot({ path: join(evidence, 'mcp-market-failure.png'), fullPage: true }).catch(() => {}) }
    await browser.close(); await app.stop(); await new CommunityRuntimeDriver(runtime).rebuild()
    upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve()))
    model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve())); await rm(root, { recursive: true, force: true })
  }
}, 300000)
