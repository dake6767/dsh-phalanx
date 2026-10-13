import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, chmod, readdir, lstat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { createCommunityApplication } from '../src/composition/community-application.js'
import { NodePluginUpstreamTransport } from '../src/adapters/plugin-upstream-transport.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { assertPinnedDshRevision, runtimeSection } from './support/real-dsh-runtime.js'
import { createRealDshRpc, cookieHeader } from './support/real-dsh-rpc.js'
import { latestHumanText, streamText, streamToolCall, hasToolResult } from './support/real-dsh-model.js'
import { signInCommunity } from './fixtures/community-native-browser.js'
import type { McpPreset } from '../src/domain/mcp-catalog.js'

it.skipIf(!runtimeSettings.containerImage)('retains a live DSH service during failed and pending preset updates, then switches its read-only dependencies', async () => {
  assertPinnedDshRevision(runtimeSettings)
  const results: Record<string, string> = {}
  const model = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk
    const body = JSON.parse(text), marker = latestHumanText(body)
    response.setHeader('content-type', 'text/event-stream')
    if (hasToolResult(body, marker, false) || hasToolResult(body, marker, true)) {
      results[marker] = JSON.stringify((body.messages ?? []).flatMap((row: { content?: unknown }) => Array.isArray(row.content) ? row.content : []).filter((row: { type?: string, tool_use_id?: string }) => row.type === 'tool_result' && row.tool_use_id === marker))
      streamText(response, 'UPDATE_QUERY_DONE')
    } else streamToolCall(response, marker, 'mcp__p-fixture__version', {})
  })
  model.listen(0, '127.0.0.1'); await once(model, 'listening')
  const modelOrigin = `http://127.0.0.1:${(model.address() as { port: number }).port}`
  const root = await mkdtemp(join(tmpdir(), 'catalog-update-')), runtime = runtimeSection(root, modelOrigin, runtimeSettings)
  const script = `const fs=require('node:fs'),readline=require('node:readline');readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(!m.id)return;const result=m.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:m.method==='tools/list'?{tools:[{name:'version',inputSchema:{type:'object'}}]}:{content:[{type:'text',text:fs.readFileSync(process.argv[1],'utf8')}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n')})`
  const presets: McpPreset[] = [{ entry: { id: '12306', version: '1', title: { en: 'Fixture', 'zh-CN': '夹具' }, description: { en: 'Fixture', 'zh-CN': '夹具' }, location: 'shared', documentation: 'https://example.test', imported: 0 }, configuration: { description: 'Fixture', url: '', run: { location: 'shared', command: 'node', args: ['-e', script, '{dependencies}/version'], env: [], prepareCommand: 'printf VERSION_OLD > version' } } }]
  const transport = new NodePluginUpstreamTransport('idle')
  let fail = false, hold = false, release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }), probing = new Promise<void>(resolve => { entered = resolve })
  const app = createCommunityApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'catalog-update-fixture-session-secret', runtime }, { mcpPresets: presets, mcpTransport: { send: async input => {
    if (input.upstream.name.startsWith('p-update-')) { if (fail) return new Response(null, { status: 503 }); if (hold) { entered(); await gate } }
    return transport.send(input)
  } } })
  const browser = await chromium.launch({ headless: true }), rpc = createRealDshRpc()
  let passed = false
  try {
    const origin = await app.start(), admin = await browser.newPage({ locale: 'en', viewport: { width: 1440, height: 1000 } }); admin.setDefaultTimeout(60000)
    await admin.goto(`${origin}/bootstrap#credential=${readBootstrapCredential(root)!.credential}`)
    await admin.getByLabel('Username', { exact: true }).fill('admin'); await admin.getByLabel('Password', { exact: true }).fill('password')
    await admin.getByRole('button', { name: 'Create administrator', exact: true }).click(); await admin.waitForURL(origin + '/admin')
    const post = (path: string, data: object) => admin.request.post(origin + '/admin/api/' + path, { headers: { origin }, data })
    const settings = await (await admin.request.get(origin + '/admin/api/models')).json()
    expect((await post('models', { revision: settings.revision, action: 'save-provider', provider: { name: 'Fixture', baseUrl: modelOrigin + '/anthropic', apiFormat: 'anthropic-messages', apiKey: 'fictional-model-key', enabled: true, models: [{ name: 'fixture-model', enabled: true }] } })).status()).toBe(200)
    expect((await post('accounts', { username: 'alice', password: 'password', email: '' })).status()).toBe(201)
    expect((await post('mcp/catalog', { action: 'import', input: { presetId: '12306', name: 'p-fixture', credential: '', requestId: 'update-e2e-original-import' } })).status()).toBe(202)
    const row = async () => (await (await admin.request.get(origin + '/admin/api/mcp')).json())[0]
    await expect.poll(async () => (await row()).catalog.status, { timeout: 60000 }).toBe('ready')
    expect((await post('mcp', { action: 'publish', name: 'p-fixture', published: true })).status()).toBe(200)
    const context = await browser.newContext({ locale: 'en' }), member = await context.newPage(); member.setDefaultTimeout(60000)
    await signInCommunity(member, origin, 'alice', 'password')
    await member.getByRole('button', { name: 'Platform App Center', exact: true }).click(); await member.getByRole('tab', { name: 'MCP services', exact: true }).click()
    const toggle = member.getByRole('switch', { name: 'Enable MCP service p-fixture', exact: true })
    await toggle.click(); await expect.poll(() => toggle.getAttribute('aria-checked')).toBe('true')
    const cookie = await cookieHeader(context, origin)
    const session = await rpc.remoteRpc<{ sessionId: string }>(origin, cookie, 'session/create', { request: { cwd: '/dsh-phalanx/workspace' } })
    const call = async (marker: string, version: string) => {
      await rpc.remoteRpc(origin, cookie, 'session/prompt', { request: { requestId: randomUUID(), sessionId: session.sessionId, mode: 'queue', content: [{ type: 'text', text: marker }] } })
      await expect.poll(() => results[marker], { timeout: 60000 }).toContain(version)
      expect(results[marker]).not.toContain('"is_error":true')
    }
    await call('BEFORE_UPDATE', 'VERSION_OLD')
    presets[0] = { ...presets[0]!, entry: { ...presets[0]!.entry, version: '2' }, configuration: { ...presets[0]!.configuration, run: { ...presets[0]!.configuration.run!, prepareCommand: 'exit 7' } } }
    await admin.getByRole('link', { name: 'MCP library', exact: true }).click()
    const start = async () => {
      await admin.getByRole('button', { name: 'Review preset update', exact: true }).click()
      await admin.getByText('Preset update 1 → 2', { exact: true }).waitFor()
      await admin.getByRole('button', { name: 'Validate and update', exact: true }).click()
    }
    await start()
    await expect.poll(async () => (await row()).catalogUpdate?.status, { timeout: 60000 }).toBe('failed')
    await call('PREPARATION_FAILED', 'VERSION_OLD')
    presets[0] = { ...presets[0]!, configuration: { ...presets[0]!.configuration, run: { ...presets[0]!.configuration.run!, prepareCommand: 'printf VERSION_NEW > version' } } }
    await admin.reload()
    fail = true; await start()
    await expect.poll(async () => (await row()).catalogUpdate?.status, { timeout: 60000 }).toBe('failed')
    await call('FAILED_UPDATE', 'VERSION_OLD')
    fail = false; hold = true
    await admin.reload(); await start(); await probing
    await call('PENDING_UPDATE', 'VERSION_OLD')
    hold = false; release()
    await expect.poll(async () => (await row()).catalogUpdate?.status, { timeout: 60000 }).toBe('applied')
    await call('APPLIED_UPDATE', 'VERSION_NEW')
    expect(await row()).toMatchObject({ name: 'p-fixture', published: true, catalog: { version: '2' } })
    await member.reload(); await member.getByRole('button', { name: 'Platform App Center', exact: true }).click(); await member.getByRole('tab', { name: 'MCP services', exact: true }).click()
    expect(await toggle.getAttribute('aria-checked')).toBe('true')
    passed = true
  } finally {
    release(); await browser.close(); await app.stop(); await new CommunityRuntimeDriver(runtime).rebuild()
    model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve()))
    const writable = async (path: string): Promise<void> => { if ((await lstat(path)).isDirectory()) { await chmod(path, 0o700); for (const name of await readdir(path)) await writable(join(path, name)) } }
    await writable(root); await rm(root, { recursive: true, force: true })
    if (process.env.DSH_PHALANX_E2E_EVIDENCE_DIR) await writeFile(join(process.env.DSH_PHALANX_E2E_EVIDENCE_DIR, 'catalog-update-result.json'), JSON.stringify({ passed, results }) + '\n')
  }
}, 300000)
