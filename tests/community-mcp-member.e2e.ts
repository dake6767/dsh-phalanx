import type { CommunityRuntimeConfig } from '../src/domain/community-config.js'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile, readdir, chmod, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { chromium, type Browser } from 'playwright'
import { createCommunityApplication } from '../src/composition/community-application.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import { execFileText } from '../src/adapters/runtime-command.js'
import { runtimeSection, assertPinnedDshRevision } from './support/real-dsh-runtime.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { createRealDshRpc } from './support/real-dsh-rpc.js'
import { latestHumanText, streamText, streamToolCall, hasToolResult } from './support/real-dsh-model.js'

it('prepares Playwright once and hot-loads filtered stdio tools that read and write the member workspace', async () => {
  assertPinnedDshRevision(runtimeSettings)
  const root = await mkdtemp(join(tmpdir(), 'mcp-member-'))
  const observations: { marker: string, tools: string[], success: boolean, failed: boolean, fixtureRead: boolean, results: unknown[] }[] = []
  const model = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk
    const body = JSON.parse(text) as { tools?: { name: string }[], messages?: { content?: unknown }[] }, marker = latestHumanText(body), id = marker.toLowerCase()
    const success = hasToolResult(body, id, false), failed = hasToolResult(body, id, true)
    observations.push({ marker, tools: (body.tools ?? []).map(tool => tool.name), success, failed, fixtureRead: text.includes('MEMBER_WORKSPACE_FIXTURE'), results: (body.messages ?? []).flatMap(row => Array.isArray(row.content) ? row.content.filter(block => block.type === 'tool_result') : []) })
    res.setHeader('content-type', 'text/event-stream')
    if (marker === 'CALL_READ' && !success && !failed) streamToolCall(res, id, 'mcp__p-browser__browser_navigate', { url: 'file:///dsh-phalanx/workspace/input.html' })
    else if (marker === 'CALL_WRITE' && !success && !failed) streamToolCall(res, id, 'mcp__p-browser__browser_take_screenshot', { type: 'png', filename: 'member-output.png' })
    else streamText(res, 'DONE_' + marker)
  })
  model.listen(0, '127.0.0.1'); await once(model, 'listening')
  const modelOrigin = `http://127.0.0.1:${(model.address() as { port: number }).port}`
  const base: CommunityRuntimeConfig = runtimeSection(join(root, 'platform'), modelOrigin, runtimeSettings)
  const runtime = { ...base, ...(base.container && process.env.DSH_PHALANX_E2E_CPU_THROTTLE ? { container: { ...base.container, extraArgs: ['--cpus', '0.5'] } } : {}) }
  const app = createCommunityApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'mcp-member-fixture-session-secret', runtime })
  const rpc = createRealDshRpc(); let carrier = '', passed = false, preparation: unknown, browser: Browser | undefined
  const cookies = (res: Response) => res.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  try {
    const origin = await app.start()
    const bootstrap = await fetch(origin + '/bootstrap', { method: 'POST', redirect: 'manual', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ credential: readBootstrapCredential(runtime.dataRoot)!.credential, username: 'admin', password: 'password' }) })
    expect(bootstrap.status).toBe(303); const admin = cookies(bootstrap)
    const post = (path: string, body: object) => fetch(origin + '/admin/api/' + path, { method: 'POST', headers: { cookie: admin, origin, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const settings = await (await fetch(origin + '/admin/api/models', { headers: { cookie: admin } })).json()
    expect((await post('models', { revision: settings.revision, action: 'save-provider', provider: { name: 'Fixture', baseUrl: modelOrigin + '/anthropic', apiFormat: 'anthropic-messages', apiKey: 'fictional-key', enabled: true, models: [{ name: 'fixture-model', enabled: true }] } })).status).toBe(200)
    const created = await post('accounts', { username: 'member', password: 'password', email: '' }); expect(created.status).toBe(201)
    const account = await created.json() as { groupId: string, spaceId: string }
    const login = await fetch(origin + '/login', { method: 'POST', redirect: 'manual', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: 'member', password: 'password' }) })
    expect(login.status).toBe(303); const member = cookies(login)
    const owner = createHash('sha256').update(runtime.dataRoot).digest('hex')
    carrier = (await execFileText('podman', ['ps', '--filter', `label=dsh-phalanx.community-root=${owner}`, '--format', '{{.Names}}'])).trim()
    const before = JSON.parse(await execFileText('podman', ['inspect', carrier]))[0]
    const workspace = join(runtime.dataRoot, 'users/member/workspace')
    await writeFile(join(workspace, 'input.html'), '<h1>MEMBER_WORKSPACE_FIXTURE</h1>')
    const input = { name: 'p-browser', description: 'Prepared member browser', url: '', run: { location: 'member', command: 'npx', args: ['-y', '@playwright/mcp@0.0.80', '--headless', '--no-sandbox', '--browser', 'chromium', '--allow-unrestricted-file-access', '--output-dir', '/dsh-phalanx/workspace'], env: [{ name: 'PLAYWRIGHT_BROWSERS_PATH', value: '{dependencies}/browsers' }],
      prepareCommand: 'npm install --ignore-scripts --no-audit --no-fund --cache .npm-cache --save-exact @playwright/mcp@0.0.80 && PLAYWRIGHT_BROWSERS_PATH="$PWD/browsers" node node_modules/playwright/cli.js install chromium && rm -rf .npm-cache' } }
    expect((await post('mcp', { action: 'save', service: { ...input, credential: 'fictional-rejected-secret' } })).status).toBe(400)
    expect((await post('mcp', { action: 'save', service: input })).status).toBe(200)
    const library = async () => (await (await fetch(origin + '/admin/api/mcp', { headers: { cookie: admin } })).json()) as { name: string, preparation?: { stage: string, log: string }, testStatus: string, tools: { name: string }[] }[]
    await expect.poll(async () => { const row = (await library())[0]!; preparation = row.preparation; return row.preparation?.stage ?? 'pending' }, { timeout: 660000 }).toMatch(/^(ready|failed)$/)
    expect(preparation).toMatchObject({ stage: 'ready' })
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({ locale: 'en', viewport: { width: 1440, height: 1000 } })
    if (process.env.DSH_PHALANX_E2E_CPU_THROTTLE) await (await page.context().newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.DSH_PHALANX_E2E_CPU_THROTTLE) })
    page.setDefaultTimeout(15000)
    await page.request.post(origin + '/login', { headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, data: 'username=admin&password=password' })
    await page.goto(origin + '/admin'); await page.getByRole('link', { name: 'MCP library', exact: true }).click()
    await page.getByRole('row').filter({ hasText: input.name }).getByRole('button', { name: 'Edit', exact: true }).click()
    await page.getByText('Dependencies ready', { exact: true }).waitFor()
    await page.getByText('Preparation log', { exact: true }).click()
    expect(await page.getByRole('button', { name: 'Prepare again', exact: true }).isEnabled()).toBe(true)
    if (process.env.DSH_PHALANX_E2E_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.DSH_PHALANX_E2E_EVIDENCE_DIR, 'mcp-member-preparation.png'), fullPage: true })
    await page.getByRole('tab', { name: 'MCP tools', exact: true }).click()
    await page.getByRole('button', { name: 'Test connection', exact: true }).click()
    await page.getByText('MCP connection passed.', { exact: true }).waitFor()
    const discovery = (await library())[0]!
    const carriers = JSON.parse(await execFileText('podman', ['inspect', ...(await execFileText('podman', ['ps', '--filter', `label=dsh-phalanx.community-root=${owner}`, '--format', '{{.Names}}'])).trim().split('\n')]))
    const mounts = carriers.map((row: { Mounts: { Source: string, Destination: string, RW: boolean }[] }) => row.Mounts.find(mount => mount.Destination === '/dsh-phalanx/mcp-dependencies'))
    expect(mounts).toHaveLength(2); expect(mounts.every((mount: { Source: string, RW: boolean }) => !mount.RW && mount.Source === mounts[0].Source)).toBe(true)
    expect(discovery.testStatus).toBe('passed'); expect(discovery.tools.map((row: { name: string }) => row.name)).toContain('browser_navigate')
    expect((await post('groups/' + account.groupId + '/mcp', { names: [input.name] })).status).toBe(200)
    const session = await rpc.remoteRpc<{ sessionId: string }>(origin, member, 'session/create', { request: { cwd: '/dsh-phalanx/workspace' } })
    const prompt = async (marker: string) => {
      await rpc.remoteRpc(origin, member, 'session/prompt', { request: { requestId: randomUUID(), sessionId: session.sessionId, mode: 'queue', content: [{ type: 'text', text: marker }] } })
      await expect.poll(() => observations.some(row => row.marker === marker && (!marker.startsWith('CALL_') || row.success || row.failed)), { timeout: 90000 }).toBe(true)
      await expect.poll(async () => (await rpc.remoteRpc<{ items: { id: string, running: boolean }[] }>(origin, member, 'session/list', { _request: {} })).items.find(item => item.id === session.sessionId)?.running, { timeout: 30000 }).not.toBe(true)
      return observations.filter(row => row.marker === marker).at(-1)!
    }
    expect(await prompt('CALL_READ')).toMatchObject({ success: true, failed: false })
    // This pinned MCP writes accessibility snapshots to files and returns their links.
    const snapshots = (await readdir(workspace)).filter(name => /^page-.*\.yml$/u.test(name))
    expect(snapshots.length).toBeGreaterThan(0)
    const snapshot = (await Promise.all(snapshots.map(name => readFile(join(workspace, name), 'utf8')))).join('\n')
    expect(snapshot).toContain('MEMBER_WORKSPACE_FIXTURE')
    if (process.env.DSH_PHALANX_E2E_EVIDENCE_DIR) await writeFile(join(process.env.DSH_PHALANX_E2E_EVIDENCE_DIR, 'mcp-member-page.yml'), snapshot)
    expect(await prompt('CALL_WRITE')).toMatchObject({ success: true, failed: false })
    expect((await readFile(join(workspace, 'member-output.png'))).subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    expect((await post('mcp', { action: 'save', service: { ...input, disabledTools: ['browser_navigate'] } })).status).toBe(200)
    expect((await prompt('FILTERED')).tools).not.toContain('mcp__p-browser__browser_navigate')
    expect((await fetch(origin + '/market/api/mcp', { method: 'POST', headers: { cookie: member, origin, 'content-type': 'application/json' }, body: JSON.stringify({ name: input.name, action: 'disable' }) })).status).toBe(200)
    expect((await prompt('DISABLED')).tools.some(name => name.startsWith('mcp__p-browser__'))).toBe(false)
    const after = JSON.parse(await execFileText('podman', ['inspect', carrier]))[0]
    expect(after.Id).toBe(before.Id); expect(after.State.StartedAt).toBe(before.State.StartedAt)
    expect(after.Mounts.filter((row: { Destination: string }) => row.Destination === '/dsh-phalanx/mcp-dependencies')).toHaveLength(1)
    expect(after.Mounts.find((row: { Destination: string }) => row.Destination === '/dsh-phalanx/mcp-dependencies').RW).toBe(false)
    // A stubborn diagnostic must be reaped inside the member container, not merely lose its podman CLI.
    const cleanupServer = `import {createInterface} from 'node:readline';import {writeFileSync} from 'node:fs';writeFileSync('diagnostic.pid',String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);createInterface({input:process.stdin}).on('line',line=>{const row=JSON.parse(line);if(row.id)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:row.id,result:row.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}}}:{tools:[]}})+'\\n')});`
    const cleanupInput = { name: 'p-cleanup', description: '', url: '', run: { location: 'member', command: 'node', args: ['{dependencies}/server.mjs'], env: [], prepareCommand: 'printf %s ' + "'" + cleanupServer.replaceAll("'", "'\\''") + "' > server.mjs" } }
    expect((await post('mcp', { action: 'save', service: cleanupInput })).status).toBe(200)
    await expect.poll(async () => (await library()).find(row => row.name === 'p-cleanup')?.preparation?.stage, { timeout: 30000 }).toBe('ready')
    expect((await (await post('mcp/test', { name: 'p-cleanup' })).json()).testStatus).toBe('passed')
    const diagnosticPid = (await readFile(join(runtime.dataRoot, 'users/admin/workspace/diagnostic.pid'), 'utf8')).trim()
    expect(/^[0-9]+$/.test(diagnosticPid)).toBe(true)
    const adminCarrier = carriers.find((row: { Id: string }) => row.Id !== before.Id).Id
    const inspectProcess = 'try { process.kill(Number(process.argv[1]), 0); console.log("present") } catch (error) { if (error.code !== "ESRCH") throw error; console.log("absent") }'
    expect((await execFileText('podman', ['exec', adminCarrier, 'node', '-e', inspectProcess, diagnosticPid])).trim()).toBe('absent')
    passed = true
  } finally {
    const evidence = process.env.DSH_PHALANX_E2E_EVIDENCE_DIR
    if (evidence) await writeFile(join(evidence, 'mcp-member-result.json'), JSON.stringify({ passed, preparation, observations }, null, 2))
    if (!passed && evidence && carrier) await writeFile(join(evidence, 'mcp-member-container.log'), await execFileText('podman', ['logs', carrier]).catch(() => 'unavailable'))
    await browser?.close(); await app.stop(); await new CommunityRuntimeDriver(runtime).rebuild()
    model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve()))
    const writable = async (path: string): Promise<void> => { if ((await lstat(path)).isDirectory()) { await chmod(path, 0o700); for (const name of await readdir(path)) await writable(join(path, name)) } }
    await writable(root); await rm(root, { recursive: true, force: true })
  }
}, 900000)
