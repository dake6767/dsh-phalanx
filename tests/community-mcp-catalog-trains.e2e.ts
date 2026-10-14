import { createServer } from 'node:http'
import { once } from 'node:events'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile, readdir, chmod, lstat } from 'node:fs/promises'
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

it.skipIf(!runtimeSettings.containerImage)('imports pinned 12306 without credentials, prepares automatically and serves two isolated DSH members', async () => {
  assertPinnedDshRevision(runtimeSettings)
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + 86400000))
  const results: Record<string, { valid: boolean, error: boolean, excerpt: string }> = {}
  const model = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk
    const body = JSON.parse(text), marker = latestHumanText(body)
    response.setHeader('content-type', 'text/event-stream')
    if (hasToolResult(body, marker, false) || hasToolResult(body, marker, true)) {
      const blocks = (body.messages ?? []).flatMap((row: { content?: unknown }) => Array.isArray(row.content) ? row.content : []).filter((block: { type?: string, tool_use_id?: string }) => block.type === 'tool_result' && block.tool_use_id === marker)
      const content = JSON.stringify(blocks)
      results[marker] = { valid: /[GC]\d{2,5}/u.test(content) && [date, '北京南', '天津', 'prices', 'seat_name'].every(value => content.includes(value)), error: hasToolResult(body, marker, true), excerpt: content.slice(0, 1500) }
      streamText(response, 'TRAIN_QUERY_DONE')
    } else streamToolCall(response, marker, 'mcp__p-12306__get-tickets', { date, fromStation: '北京南', toStation: '天津', trainFilterFlags: 'G', limitedNum: 2, format: 'json' })
  })
  model.listen(0, '127.0.0.1'); await once(model, 'listening')
  const modelOrigin = `http://127.0.0.1:${(model.address() as { port: number }).port}`
  const root = await mkdtemp(join(tmpdir(), 'catalog-trains-')), runtime = runtimeSection(root, modelOrigin, runtimeSettings)
  const app = candidateApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'catalog-trains-fixture-session-secret', runtime })
  const browser = await chromium.launch({ headless: true }), rpc = createRealDshRpc()
  let passed = false, tools: string[] = [], preparation: unknown, containerIds: string[] = []
  try {
    const origin = await app.start(), admin = await browser.newPage({ locale: 'en', viewport: { width: 1440, height: 1000 } }); admin.setDefaultTimeout(60000)
    await admin.goto(`${origin}/bootstrap#credential=${readBootstrapCredential(root)!.credential}`)
    await admin.getByLabel('Username', { exact: true }).fill('admin'); await admin.getByLabel('Password', { exact: true }).fill('password')
    await admin.getByRole('button', { name: 'Create administrator', exact: true }).click(); await admin.waitForURL(origin + '/admin')
    const post = (path: string, body: object) => admin.request.post(origin + '/admin/api/' + path, { headers: { origin }, data: body })
    const settings = await (await admin.request.get(origin + '/admin/api/models')).json()
    expect((await post('models', { revision: settings.revision, action: 'save-provider', provider: { name: 'Fixture', baseUrl: modelOrigin + '/anthropic', apiFormat: 'anthropic-messages', apiKey: 'fictional-model-key', enabled: true, models: [{ name: 'fixture-model', enabled: true }] } })).status()).toBe(200)
    for (const username of ['alice', 'bob']) expect((await post('accounts', { username, password: 'password', email: '' })).status()).toBe(201)
    await admin.getByRole('link', { name: 'MCP library', exact: true }).click()
    await admin.getByRole('tab', { name: 'MCP catalog', exact: true }).click()
    await admin.getByRole('button', { name: 'View MCP service 12306', exact: true }).click()
    expect(await admin.getByRole('dialog').locator('input[type=password]').count()).toBe(0)
    await admin.getByRole('button', { name: 'Import MCP service', exact: true }).click()
    const library = async () => (await (await admin.request.get(origin + '/admin/api/mcp')).json())[0]
    await expect.poll(async () => { const row = await library(); preparation = row.preparation; return row.catalog.status }, { timeout: 660000 }).toMatch(/^(ready|failed)$/u)
    const row = await library(); tools = row.tools.map((tool: { name: string }) => tool.name)
    expect(row.catalog.status).toBe('ready'); expect(tools).toContain('get-tickets'); expect(row.credentialConfigured).toBe(false)
    expect((await post('mcp', { action: 'publish', name: 'p-12306', published: true })).status()).toBe(200)
    const owner = createHash('sha256').update(root).digest('hex')
    for (const username of ['alice', 'bob']) {
      const context = await browser.newContext({ locale: 'en', viewport: { width: 1440, height: 1000 } }), page = await context.newPage(); page.setDefaultTimeout(60000)
      await signInCommunity(page, origin, username, 'password')
      await page.getByRole('button', { name: 'Platform App Center', exact: true }).click(); await page.getByRole('tab', { name: 'MCP services', exact: true }).click()
      const toggle = page.getByRole('switch', { name: 'Enable MCP service p-12306', exact: true })
      await expect.poll(() => toggle.getAttribute('aria-checked')).toBe('false'); await toggle.click(); await expect.poll(() => toggle.getAttribute('aria-checked')).toBe('true')
      const cookie = await cookieHeader(context, origin), marker = 'TRAIN_' + username
      const session = await rpc.remoteRpc<{ sessionId: string }>(origin, cookie, 'session/create', { request: { cwd: '/dsh-phalanx/workspace' } })
      await rpc.remoteRpc(origin, cookie, 'session/prompt', { request: { requestId: randomUUID(), sessionId: session.sessionId, mode: 'queue', content: [{ type: 'text', text: marker }] } })
      await expect.poll(() => Boolean(results[marker]), { timeout: 90000 }).toBe(true)
      expect(results[marker]!.error).toBe(false); expect(results[marker]!.valid).toBe(true)
    }
    containerIds = (await execFileText('podman', ['ps', '--filter', `label=dsh-phalanx.mcp-shared=${owner}`, '--format', '{{.ID}}'])).trim().split(/\s+/u).filter(Boolean)
    expect(containerIds.length).toBeGreaterThanOrEqual(2)
    const inspections = JSON.parse(await execFileText('podman', ['inspect', ...containerIds]))
    for (const container of inspections) {
      const mounts = container.Mounts.filter((mount: { Type: string }) => mount.Type === 'bind')
      expect(mounts).toHaveLength(1); expect(mounts[0].RW).toBe(false); expect(JSON.stringify(mounts)).not.toContain('/users/')
    }
    expect((await post('mcp', { action: 'remove', name: 'p-12306' })).status()).toBe(200)
    await expect.poll(async () => (await execFileText('podman', ['ps', '--filter', `label=dsh-phalanx.mcp-shared=${owner}`, '--format', '{{.ID}}'])).trim()).toBe('')
    passed = true
  } finally {
    await browser.close(); await app.stop(); await new CommunityRuntimeDriver(runtime).rebuild()
    model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve()))
    const writable = async (path: string): Promise<void> => { if ((await lstat(path)).isDirectory()) { await chmod(path, 0o700); for (const name of await readdir(path)) await writable(join(path, name)) } }
    await writable(root); await rm(root, { recursive: true, force: true })
    if (process.env.DSH_PHALANX_E2E_EVIDENCE_DIR) await writeFile(join(process.env.DSH_PHALANX_E2E_EVIDENCE_DIR, '12306-result.json'), JSON.stringify({ passed, date, tools, preparation, results, containerIds }) + '\n')
  }
}, 900000)
