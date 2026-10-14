import { createServer } from 'node:http'
import { once } from 'node:events'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile, readFile, readdir, chmod, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { candidateApplication } from './support/candidate-application.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import { execFileText } from '../src/adapters/runtime-command.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { assertPinnedDshRevision, runtimeSection } from './support/real-dsh-runtime.js'
import { createRealDshRpc, cookieHeader } from './support/real-dsh-rpc.js'
import { latestHumanText, streamText, streamToolCall, hasToolResult } from './support/real-dsh-model.js'
import { signInCommunity } from './fixtures/community-native-browser.js'
import { readPrivateMcpCredential, memberExposesMcpCredentials } from './support/real-mcp-credentials.js'

it('serves both shipped market presets to two installed DSH members and recovers their idle shared sessions', async () => {
  if (process.platform !== 'linux' || process.getuid?.() === 0 || !process.env.DSH_PHALANX_INSTALL_ROOT || !process.env.DSH_PHALANX_CANDIDATE_SHA || !runtimeSettings.containerImage || !process.env.DSH_PHALANX_AMAP_API_KEY_FILE) throw Error('Requires an exact installed candidate, dedicated rootless Linux and a protected Amap key file')
  assertPinnedDshRevision(runtimeSettings)
  const secret = await readPrivateMcpCredential(process.env.DSH_PHALANX_AMAP_API_KEY_FILE)
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + 86400000))
  const results: Record<string, { valid: boolean, error: boolean, tools: string[] }> = {}
  let exposed = false, passed = false
  const model = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk
    exposed ||= text.includes(secret)
    const body = JSON.parse(text), marker = latestHumanText(body), train = marker.startsWith('TRAIN_')
    response.setHeader('content-type', 'text/event-stream')
    if (hasToolResult(body, marker, false) || hasToolResult(body, marker, true)) {
      const blocks = (body.messages ?? []).flatMap((row: { content?: unknown }) => Array.isArray(row.content) ? row.content : []).filter((block: { type?: string, tool_use_id?: string }) => block.type === 'tool_result' && block.tool_use_id === marker)
      const content = JSON.stringify(blocks)
      results[marker] = { error: hasToolResult(body, marker, true), tools: (body.tools ?? []).map((tool: { name: string }) => tool.name),
        valid: train ? /[GC]\d{2,5}/u.test(content) && [date, '北京南', '天津', 'prices', 'seat_name'].every(value => content.includes(value)) : /北京市|北京/u.test(content) && /weather|天气|temperature|温度/u.test(content) }
      streamText(response, 'MARKET_QUERY_DONE')
    } else if (/^(TRAIN|WEATHER)_/u.test(marker)) streamToolCall(response, marker, train ? 'mcp__p-12306__get-tickets' : 'mcp__p-amap__maps_weather', train ? { date, fromStation: '北京南', toStation: '天津', trainFilterFlags: 'G', limitedNum: 2, format: 'json' } : { city: '110000' })
    else streamText(response, 'MARKET_READY')
  })
  model.listen(0, '127.0.0.1'); await once(model, 'listening')
  const modelOrigin = `http://127.0.0.1:${(model.address() as { port: number }).port}`
  const root = await mkdtemp(join(tmpdir(), 'installed-market-')), runtime = runtimeSection(root, modelOrigin, runtimeSettings)
  const app = candidateApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'installed-market-fixture-session-secret', runtime })
  const browser = await chromium.launch({ headless: true }), rpc = createRealDshRpc()
  const owner = createHash('sha256').update(root).digest('hex')
  const carriers = async (shared: boolean) => (await execFileText('podman', ['ps', '--filter', `label=${shared ? 'dsh-phalanx.mcp-shared' : 'dsh-phalanx.community-root'}=${owner}`, ...shared ? [] : ['--filter', 'label=dsh-phalanx.user'], '--format', '{{.ID}}'])).trim().split(/\s+/u).filter(Boolean).sort()
  const discoveries: Record<string, number> = {}, recovered: string[] = [], shared: string[] = []
  try {
    const origin = await app.start(), admin = await browser.newPage({ locale: 'en', viewport: { width: 1440, height: 1000 } }); admin.setDefaultTimeout(60000)
    await admin.goto(`${origin}/bootstrap#credential=${readBootstrapCredential(root)!.credential}`)
    await admin.getByLabel('Username', { exact: true }).fill('admin'); await admin.getByLabel('Password', { exact: true }).fill('password')
    await admin.getByRole('button', { name: 'Create administrator', exact: true }).click(); await admin.waitForURL(origin + '/admin')
    const post = (path: string, body: object) => admin.request.post(origin + '/admin/api/' + path, { headers: { origin }, data: body })
    const get = async (path: string) => (await admin.request.get(origin + '/admin/api/' + path)).json()
    const settings = await get('models')
    expect((await post('models', { revision: settings.revision, action: 'save-provider', provider: { name: 'Fixture', baseUrl: modelOrigin + '/anthropic', apiFormat: 'anthropic-messages', apiKey: 'fictional-model-key', enabled: true, models: [{ name: 'fixture-model', enabled: true }] } })).status()).toBe(200)
    expect((await post('groups', { action: 'create', name: 'Self selected' })).status()).toBe(200)
    const groups = await get('groups') as { id: string, name: string, isDefault: boolean }[]
    const groupIds = { alice: groups.find(row => row.isDefault)!.id, bob: groups.find(row => row.name === 'Self selected')!.id }
    for (const username of ['alice', 'bob'] as const) expect((await post('accounts', { username, password: 'password', email: '', groupId: groupIds[username] })).status()).toBe(201)
    expect((await get('mcp/catalog')).map((row: { id: string }) => row.id).sort()).toEqual(['12306', 'amap'])
    for (const [title, name] of [['Amap', 'p-amap'], ['12306', 'p-12306']]) {
      await admin.goto(origin + '/admin'); await admin.getByRole('link', { name: 'MCP library', exact: true }).click()
      await admin.getByRole('tab', { name: 'MCP market', exact: true }).click()
      await admin.getByRole('button', { name: 'View preset ' + title, exact: true }).click()
      if (name === 'p-amap') await admin.getByLabel('Amap Web Service Key', { exact: true }).fill(secret)
      else expect(await admin.getByRole('dialog').locator('input[type=password]').count()).toBe(0)
      await admin.getByRole('button', { name: 'Import and test', exact: true }).click()
      const service = async () => (await get('mcp')).find((row: { name: string }) => row.name === name)
      await expect.poll(async () => (await service())?.catalog.status, { timeout: 660000 }).toMatch(/^(ready|failed)$/u)
      const row = await service(); expect(row.catalog.status).toBe('ready'); expect(row.testStatus).toBe('passed')
      expect(JSON.stringify(row).includes(secret)).toBe(false); discoveries[name!] = row.tools.length
      expect((await post('mcp', { action: 'publish', name, published: true })).status()).toBe(200)
    }
    expect((await post(`groups/${groupIds.alice}/mcp`, { names: ['p-amap'] })).status()).toBe(200)
    const members: { name: string, cookie: string, sessionId: string }[] = []
    const call = async (member: typeof members[number], marker: string) => {
      await rpc.remoteRpc(origin, member.cookie, 'session/prompt', { request: { requestId: randomUUID(), sessionId: member.sessionId, mode: 'queue', content: [{ type: 'text', text: marker }] } })
      await expect.poll(() => Boolean(results[marker]), { timeout: 90000 }).toBe(true)
      expect(results[marker]).toMatchObject({ valid: true, error: false })
      await expect.poll(async () => (await rpc.remoteRpc<{ items: { sessionId: string, running: boolean }[] }>(origin, member.cookie, 'session/list', { _request: {} })).items.find(row => row.sessionId === member.sessionId)?.running, { timeout: 30000 }).toBe(false)
    }
    for (const username of ['alice', 'bob']) {
      // Exclude the administrator probe and prior member's idle process before attribution.
      await expect.poll(() => carriers(true), { timeout: 120000 }).toHaveLength(0)
      const context = await browser.newContext({ locale: 'en', viewport: { width: 1440, height: 1000 } }), page = await context.newPage(); page.setDefaultTimeout(60000)
      await signInCommunity(page, origin, username, 'password')
      expect(await page.getByRole('button', { name: 'Service preview', exact: true }).count()).toBe(0)
      await page.getByRole('button', { name: 'Platform App Center', exact: true }).click(); await page.getByRole('tab', { name: 'MCP services', exact: true }).click()
      for (const name of ['p-amap', 'p-12306']) {
        const toggle = page.getByRole('switch', { name: 'Enable MCP service ' + name, exact: true }), granted = username === 'alice' && name === 'p-amap'
        await expect.poll(() => toggle.getAttribute('aria-checked')).toBe(granted ? 'true' : 'false')
        if (!granted) { await toggle.click(); await expect.poll(() => toggle.getAttribute('aria-checked')).toBe('true') }
      }
      const cookie = await cookieHeader(context, origin), session = await rpc.remoteRpc<{ sessionId: string }>(origin, cookie, 'session/create', { request: { cwd: '/dsh-phalanx/workspace' } })
      const member = { name: username, cookie, sessionId: session.sessionId }; members.push(member)
      await call(member, 'WEATHER_' + username); await call(member, 'TRAIN_' + username)
      const active = await carriers(true); expect(active).toHaveLength(1)
      expect(shared).not.toContain(active[0]); shared.push(active[0]!)
      const [row] = JSON.parse(await execFileText('podman', ['inspect', active[0]!]))
      const mounts = row.Mounts.filter((mount: { Type: string }) => mount.Type === 'bind')
      expect(mounts).toHaveLength(1); expect(mounts[0].RW).toBe(false); expect(JSON.stringify(mounts)).not.toContain('/users/')
      if (process.env.DSH_PHALANX_E2E_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.DSH_PHALANX_E2E_EVIDENCE_DIR, 'installed-market-' + username + '.png'), fullPage: true })
    }
    // Exercise both live member-authenticated sessions at the public MCP gateway.
    // Protocol initialization/listing needs no third-party train-query response.
    await expect.poll(() => carriers(true), { timeout: 120000 }).toHaveLength(0)
    const tokens = JSON.parse(await readFile(join(root, 'model-access.json'), 'utf8')) as string[][]
    const send = (name: string, message: object, session?: string) => fetch(`http://127.0.0.1:${runtimeSettings.containerGatewayPort}/mcp/p-12306`, {
      method: 'POST', headers: { authorization: 'Bearer ' + tokens.find(row => row[0] === name)![1], 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(session ? { 'mcp-session-id': session } : {}) }, body: JSON.stringify(message),
    })
    const sessions = await Promise.all(members.map(async member => {
      const response = await send(member.name, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'isolation-fixture', version: '1' } } })
      expect(response.status).toBe(200); await response.text()
      const session = response.headers.get('mcp-session-id'); expect(session).toBeTruthy(); return session!
    }))
    expect(sessions[0]).not.toBe(sessions[1])
    const concurrent = await carriers(true); expect(concurrent).toHaveLength(2)
    for (let round = 0; round < 2; round++) await Promise.all(members.map(async (member, index) => {
      const response = await send(member.name, { jsonrpc: '2.0', id: 2 + round, method: 'tools/list' }, sessions[index])
      expect(response.status).toBe(200); expect(await response.text()).toContain('get-tickets')
    }))
    expect(await carriers(true)).toEqual(concurrent); shared.push(...concurrent)
    const cross = await send('bob', { jsonrpc: '2.0', id: 4, method: 'tools/list' }, sessions[0]); await cross.body?.cancel()
    expect(cross.status).toBe(404)
    const instances = await carriers(false)
    expect(instances).toHaveLength(2)
    for (const id of instances) expect(await memberExposesMcpCredentials(id, [secret])).toBe(false)
    // Observe actual installed idle reclamation, then call each same DSH session.
    for (const member of members) {
      await expect.poll(() => carriers(true), { timeout: 120000 }).toHaveLength(0)
      await call(member, 'TRAIN_RECOVERED_' + member.name); recovered.push(member.name)
      const active = await carriers(true); expect(active).toHaveLength(1)
      expect(shared).not.toContain(active[0]); shared.push(active[0]!)
    }
    expect(await carriers(false)).toEqual(instances)
    expect(exposed).toBe(false); expect((await readFile(join(root, 'mcp/audit.json'), 'utf8')).includes(secret)).toBe(false)
    for (const name of ['p-amap', 'p-12306']) expect((await post('mcp', { action: 'remove', name })).status()).toBe(200)
    await expect.poll(() => carriers(true)).toHaveLength(0)
    passed = true
  } catch (error) {
    throw new Error(String(error).replaceAll(secret, '[redacted]').replaceAll(encodeURIComponent(secret), '[redacted]'))
  } finally {
    await browser.close(); await app.stop(); await new CommunityRuntimeDriver(runtime).rebuild()
    model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve()))
    const writable = async (path: string): Promise<void> => { if ((await lstat(path)).isDirectory()) { await chmod(path, 0o700); for (const name of await readdir(path)) await writable(join(path, name)) } }
    await writable(root); await rm(root, { recursive: true, force: true })
    if (process.env.DSH_PHALANX_E2E_EVIDENCE_DIR) await writeFile(join(process.env.DSH_PHALANX_E2E_EVIDENCE_DIR, 'installed-market-result.json'), JSON.stringify({ passed, date, candidate: process.env.DSH_PHALANX_CANDIDATE_SHA, discoveries, recovered, exposed, results }) + '\n')
  }
}, 1800000)
