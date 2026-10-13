import type { CommunityRuntimeConfig } from '../../src/domain/community-config.js'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile, readdir, chmod, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect } from 'vitest'
import { chromium, type Browser } from 'playwright'
import { candidateApplication } from './candidate-application.js'
import { createCommunityApplication } from '../../src/composition/community-application.js'
import { readBootstrapCredential } from '../../src/adapters/bootstrap-credential.js'
import { CommunityRuntimeDriver } from '../../src/adapters/community-runtime-driver.js'
import { execFileText } from '../../src/adapters/runtime-command.js'
import { runtimeSection, assertPinnedDshRevision } from './real-dsh-runtime.js'
import { runtimeSettings } from './real-dsh-kit.js'
import { createRealDshRpc } from './real-dsh-rpc.js'
import { latestHumanText, streamText, streamToolCall, hasToolResult } from './real-dsh-model.js'

export async function verifySharedMcpScenario(scenario: 'management' | 'recovery'): Promise<void> {
  assertPinnedDshRevision(runtimeSettings)
  const root = await mkdtemp(join(tmpdir(), 'mcp-shared-'))
  const observations: { marker: string, tools: string[], result: boolean, text: string }[] = []
  const recoveryDurationsMs: number[] = []
  const model = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk
    const body = JSON.parse(text), marker = latestHumanText(body), result = hasToolResult(body, marker.toLowerCase(), false)
    observations.push({ marker, result, tools: (body.tools ?? []).map((row: { name: string }) => row.name), text })
    res.setHeader('content-type', 'text/event-stream')
    if (marker.startsWith('CALL_') && !result && !hasToolResult(body, marker.toLowerCase(), true)) streamToolCall(res, marker.toLowerCase(), 'mcp__p-search__search', {})
    else streamText(res, 'DONE_' + marker)
  })
  model.listen(0, '127.0.0.1'); await once(model, 'listening')
  const modelOrigin = `http://127.0.0.1:${(model.address() as { port: number }).port}`
  const base = runtimeSection(join(root, 'platform'), modelOrigin, runtimeSettings)
  const runtime: CommunityRuntimeConfig = { ...base, environment: { ...base.environment, MEMBER_ONLY: 'member-private-value' } }
  let now = Date.now()
  const config = { listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'shared-mcp-fixture-session-secret', runtime }
  const app = scenario === 'recovery' ? createCommunityApplication(config, { clock: { now: () => now } }) : candidateApplication(config)
  const rpc = createRealDshRpc(); let passed = false, browser: Browser | undefined, preparation: unknown
  const cookies = (res: Response) => res.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  const fixture = `import {createInterface} from 'node:readline'; import {randomUUID} from 'node:crypto'; import {writeFileSync,existsSync} from 'node:fs';
const session=randomUUID(); let writable=false; try {writeFileSync('runtime-write','forbidden');writable=true}catch{}
for await (const line of createInterface({input:process.stdin})) { const m=JSON.parse(line); if(m.id===undefined)continue;
const result=m.method==='initialize'?{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:m.method==='tools/list'?{tools:[{name:'search',inputSchema:{type:'object'}},{name:'write',inputSchema:{type:'object'}}]}:{content:[{type:'text',text:JSON.stringify({session,key:process.env.API_KEY,member:process.env.MEMBER_ONLY??null,workspace:existsSync('/dsh-phalanx/workspace'),writable})}]};
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n')}`
  const prepareCommand = `node -e 'require("fs").writeFileSync("server.mjs",Buffer.from("${Buffer.from(fixture).toString('base64')}","base64"));require("fs").writeFileSync("private-key",process.env.API_KEY)'`
  const input = { name: 'p-search', description: 'Private shared fixture', url: '', credential: 'fictional-shared-secret', disabledTools: ['write'], run: { location: 'shared', command: 'node', args: ['server.mjs'], env: [{ name: 'API_KEY', value: '{credential}' }], prepareCommand } }
  const owner = createHash('sha256').update(runtime.dataRoot).digest('hex')
  const carriers = async () => (await execFileText('podman', ['ps', '--filter', `label=dsh-phalanx.mcp-shared=${owner}`, '--format', '{{.ID}}'])).trim().split(/\s+/u).filter(Boolean)
  try {
    const origin = await app.start()
    const bootstrap = await fetch(origin + '/bootstrap', { method: 'POST', redirect: 'manual', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ credential: readBootstrapCredential(runtime.dataRoot)!.credential, username: 'admin', password: 'password' }) })
    expect(bootstrap.status).toBe(303); const admin = cookies(bootstrap)
    const post = (path: string, body: object) => fetch(origin + '/admin/api/' + path, { method: 'POST', headers: { cookie: admin, origin, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const settings = await (await fetch(origin + '/admin/api/models', { headers: { cookie: admin } })).json()
    expect((await post('models', { revision: settings.revision, action: 'save-provider', provider: { name: 'Fixture', baseUrl: modelOrigin + '/anthropic', apiFormat: 'anthropic-messages', apiKey: 'fictional-model-key', enabled: true, models: [{ name: 'fixture-model', enabled: true }] } })).status).toBe(200)
    const members: { name: string, cookie: string, groupId: string, spaceId: string, sessionId: string }[] = []
    for (const name of ['alice', 'bob']) {
      const created = await post('accounts', { username: name, password: 'password', email: '' }); expect(created.status).toBe(201)
      const account = await created.json()
      const login = await fetch(origin + '/login', { method: 'POST', redirect: 'manual', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: name, password: 'password' }) })
      expect(login.status).toBe(303); const cookie = cookies(login)
      const session = await rpc.remoteRpc<{ sessionId: string }>(origin, cookie, 'session/create', { request: { cwd: '/dsh-phalanx/workspace' } })
      members.push({ name, cookie, ...account, sessionId: session.sessionId })
    }
    expect((await post('mcp', { action: 'save', service: input })).status).toBe(200)
    const library = async () => (await (await fetch(origin + '/admin/api/mcp', { headers: { cookie: admin } })).json()) as { preparation?: { stage: string, isolated?: boolean }, testStatus: string }[]
    const prepared = async () => {
      await expect.poll(async () => { preparation = (await library())[0]?.preparation; return (preparation as { stage?: string })?.stage }, { timeout: 120000 }).toMatch(/^(ready|failed)$/)
      expect(preparation).toMatchObject({ stage: 'ready', isolated: true })
    }
    await prepared()
    if (scenario === 'management') {
      browser = await chromium.launch({ headless: true }); const page = await browser.newPage({ locale: 'en', viewport: { width: 1440, height: 1000 } })
      if (process.env.DSH_PHALANX_E2E_CPU_THROTTLE) await (await page.context().newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.DSH_PHALANX_E2E_CPU_THROTTLE) })
      await page.request.post(origin + '/login', { headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, data: 'username=admin&password=password' })
      await page.goto(origin + '/admin'); await page.getByRole('link', { name: 'MCP library', exact: true }).click()
      await page.getByRole('row').filter({ hasText: 'p-search' }).getByRole('button', { name: 'Edit', exact: true }).click()
      await page.getByText('Dependencies ready', { exact: true }).waitFor()
      expect(await page.getByRole('button', { name: 'Prepare again', exact: true }).isEnabled()).toBe(true)
      await page.getByRole('tab', { name: 'MCP tools', exact: true }).click(); await page.getByRole('button', { name: 'Test connection', exact: true }).click()
      await page.getByText('MCP connection passed.', { exact: true }).waitFor()
      if (process.env.DSH_PHALANX_E2E_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.DSH_PHALANX_E2E_EVIDENCE_DIR, 'shared-mcp-editor.png'), fullPage: true })
    }
    expect((await post('groups/' + members[0]!.groupId + '/mcp', { names: ['p-search'] })).status).toBe(200)
    const prompt = async (member: typeof members[number], marker: string) => {
      await rpc.remoteRpc(origin, member.cookie, 'session/prompt', { request: { requestId: randomUUID(), sessionId: member.sessionId, mode: 'queue', content: [{ type: 'text', text: marker }] } })
      await expect.poll(() => observations.some(row => row.marker === marker && (row.result || !marker.startsWith('CALL_'))), { timeout: 90000 }).toBe(true)
      await expect.poll(async () => (await rpc.remoteRpc<{ items: { id: string, running: boolean }[] }>(origin, member.cookie, 'session/list', { _request: {} })).items.find(row => row.id === member.sessionId)?.running, { timeout: 30000 }).not.toBe(true)
      return observations.filter(row => row.marker === marker).at(-1)!
    }
    const alice = await prompt(members[0]!, 'CALL_ALICE'), bob = await prompt(members[1]!, 'CALL_BOB')
    for (const row of [alice, bob]) { expect(row.tools).toContain('mcp__p-search__search'); expect(row.tools).not.toContain('mcp__p-search__write'); expect(row.text).toContain('[redacted]'); expect(row.text).not.toContain('fictional-shared-secret'); expect(row.text).toContain('\\"member\\":null'); expect(row.text).toContain('\\"workspace\\":false'); expect(row.text).toContain('\\"writable\\":false') }
    let before = await carriers(); expect(before).toHaveLength(2)
    const inspection = JSON.parse(await execFileText('podman', ['inspect', ...before]))
    for (const row of inspection) {
      expect(row.Mounts.filter((mount: { Type: string }) => mount.Type === 'bind')).toHaveLength(1)
      expect(row.Mounts.find((mount: { Type: string }) => mount.Type === 'bind')).toMatchObject({ RW: false })
      expect(JSON.stringify(row)).not.toContain('fictional-shared-secret'); expect(JSON.stringify(row.Mounts)).not.toContain('/users/')
      expect(row.HostConfig.Memory).toBe(512 * 1024 * 1024)
    }
    if (scenario === 'recovery') {
      const memberInstances = () => execFileText('podman', ['ps', '--filter', `label=dsh-phalanx.community-root=${owner}`, '--filter', 'label=dsh-phalanx.user', '--format', '{{.ID}}'])
      const instances = await memberInstances()
      now += 61_000
      await expect.poll(carriers, { timeout: 30_000 }).toHaveLength(0)
      for (const [index, member] of members.entries()) {
        const started = performance.now()
        const recovered = await prompt(member, 'CALL_RECOVERED_' + index)
        recoveryDurationsMs.push(Math.round(performance.now() - started))
        expect(recovered.result).toBe(true)
        expect(recovered.text).toContain('[redacted]')
      }
      expect(await memberInstances()).toBe(instances)
      const replaced = await carriers()
      expect(replaced).toHaveLength(2)
      expect(replaced.some(id => before.includes(id))).toBe(false)
      before = replaced
    }
    const tokens = JSON.parse(await readFile(join(runtime.dataRoot, 'model-access.json'), 'utf8')) as string[][]
    const send = (name: string, message: unknown, session?: string) => fetch(`http://127.0.0.1:${runtime.container!.gatewayPort}/mcp/p-search`, { method: 'POST', headers: { authorization: 'Bearer ' + tokens.find(row => row[0] === name)![1], 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(session ? { 'mcp-session-id': session } : {}) }, body: JSON.stringify(message) })
    const sessions: string[] = []
    for (const name of ['alice', 'bob']) { const response = await send(name, { jsonrpc: '2.0', id: 90, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } } }); expect(response.status).toBe(200); sessions.push(response.headers.get('mcp-session-id')!); await response.text() }
    expect(sessions[0]).not.toBe(sessions[1])
    expect((await send('bob', { jsonrpc: '2.0', id: 91, method: 'tools/list' }, sessions[0])).status).toBe(404)
    expect(await (await send('alice', { jsonrpc: '2.0', id: 92, method: 'tools/call', params: { name: 'write' } }, sessions[0])).json()).toHaveProperty('error')
    const allMembers = (await execFileText('podman', ['ps', '--filter', `label=dsh-phalanx.community-root=${owner}`, '--filter', 'label=dsh-phalanx.user', '--format', '{{.Names}}'])).trim().split('\n').filter(Boolean)
    for (const member of ['alice', 'bob']) expect(allMembers.some(name => name.startsWith('dsh-phalanx-' + member + '-'))).toBe(true)
    for (const name of allMembers) {
      const output = await execFileText('podman', ['exec', name, 'node', '-e', `const fs=require('fs');process.stdout.write(JSON.stringify(process.env));for(const p of fs.readdirSync('/proc').filter(p=>/^\\d+$/.test(p))){try{process.stdout.write(fs.readFileSync('/proc/'+p+'/cmdline'));process.stdout.write(fs.readFileSync('/proc/'+p+'/environ'))}catch{}};for(const p of ['/dsh-phalanx/member-mcp/entries.json'])process.stdout.write(fs.readFileSync(p));`])
      expect(output).not.toContain('fictional-shared-secret'); expect(output).not.toContain('/shared-dependencies/')
    }
    expect((await post('mcp', { action: 'save', service: { ...input, credential: 'fictional-rotated-key' } })).status).toBe(200)
    expect((await carriers()).some(id => before.includes(id))).toBe(false)
    await prepared(); await prompt(members[0]!, 'CALL_ROTATED')
    expect((await post('groups/' + members[0]!.groupId + '/mcp', { names: [] })).status).toBe(200)
    expect(await carriers()).toHaveLength(0)
    expect((await send('alice', { jsonrpc: '2.0', id: 99, method: 'tools/list' }, sessions[0])).status).toBe(403)
    expect((await prompt(members[0]!, 'REVOKED')).tools).not.toContain('mcp__p-search__search')
    expect(await readFile(join(runtime.dataRoot, 'mcp', 'audit.json'), 'utf8')).not.toContain('fictional-')
    passed = true
  } finally {
    const evidence = process.env.DSH_PHALANX_E2E_EVIDENCE_DIR
    if (evidence) await writeFile(join(evidence, scenario === 'recovery' ? 'shared-mcp-recovery-result.json' : 'shared-mcp-result.json'), JSON.stringify({ passed, preparation, recoveryDurationsMs, observations: observations.map(({ marker, tools, result }) => ({ marker, tools: tools.filter(name => name.startsWith('mcp__')), result })) }, null, 2))
    await browser?.close(); await app.stop(); await new CommunityRuntimeDriver(runtime).rebuild()
    model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve()))
    const writable = async (path: string): Promise<void> => { if ((await lstat(path)).isDirectory()) { await chmod(path, 0o700); for (const name of await readdir(path)) await writable(join(path, name)) } }
    await writable(root); await rm(root, { recursive: true, force: true })
  }
}
