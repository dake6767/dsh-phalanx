import type { CommunityRuntimeConfig } from '../src/domain/community-config.js'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { parse, parseDocument } from 'yaml'
import { candidateApplication } from './support/candidate-application.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import { execFileText } from '../src/adapters/runtime-command.js'
import { runtimeSection, assertPinnedDshRevision } from './support/real-dsh-runtime.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { createRealDshRpc } from './support/real-dsh-rpc.js'
import { latestHumanText, streamText } from './support/real-dsh-model.js'

it('yields only conflicting personal MCP entries and restores member intent across live lifecycle changes', async () => {
  assertPinnedDshRevision(runtimeSettings)
  const root = await mkdtemp(join(tmpdir(), 'mcp-lifecycle-'))
  const observations: { marker: string, tools: string[] }[] = []
  const model = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk
    const body = JSON.parse(text) as { tools?: { name: string }[] }, marker = latestHumanText(body)
    observations.push({ marker, tools: (body.tools ?? []).map(tool => tool.name) })
    res.setHeader('content-type', 'text/event-stream'); streamText(res, 'DONE_' + marker)
  })
  model.listen(0, '127.0.0.1'); await once(model, 'listening')
  const modelOrigin = `http://127.0.0.1:${(model.address() as { port: number }).port}`
  const upstream = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
    let text = ''; for await (const chunk of req) text += chunk
    const body = JSON.parse(text) as { id?: number, method: string }
    if (body.id === undefined) { res.writeHead(202); res.end(); return }
    const result = body.method === 'initialize' ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
      : body.method === 'tools/list' ? { tools: [{ name: req.url === '/new' ? 'replacement_echo' : 'platform_echo', inputSchema: { type: 'object', properties: {} } }] } : { content: [{ type: 'text', text: 'platform' }] }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }))
  })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
  const upstreamOrigin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`
  const base: CommunityRuntimeConfig = runtimeSection(join(root, 'platform'), modelOrigin, runtimeSettings)
  const runtime = { ...base, ...(base.container && process.env.DSH_PHALANX_E2E_CPU_THROTTLE ? { container: { ...base.container, extraArgs: ['--cpus', '0.5'] } } : {}) }
  const app = candidateApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'mcp-lifecycle-fixture-session-secret', modelGateway: { upstreamApiKey: 'fictional-key' }, runtime })
  const rpc = createRealDshRpc(); let carrier = '', passed = false
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
    const input = { name: 'p-collision', description: 'Fixture', url: upstreamOrigin + '/mcp' }
    expect((await post('mcp', { action: 'save', service: input })).status).toBe(200)
    const login = await fetch(origin + '/login', { method: 'POST', redirect: 'manual', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: 'member', password: 'password' }) })
    expect(login.status).toBe(303); const member = cookies(login)
    const owner = createHash('sha256').update(runtime.dataRoot).digest('hex')
    carrier = (await execFileText('podman', ['ps', '--filter', `label=dsh-phalanx.community-root=${owner}`, '--format', '{{.Names}}'])).trim()
    const before = JSON.parse(await execFileText('podman', ['inspect', carrier]))[0]
    const home = join(runtime.dataRoot, 'users/member/home/.dsh'), patch = join(home, 'cordis.patch.yml')
    const personalCommand = "require('readline').createInterface({input:process.stdin}).on('line',s=>{const b=JSON.parse(s);if(b.id===undefined)return;const result=b.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'personal',version:'1'}}:b.method==='tools/list'?{tools:[{name:'personal_echo',inputSchema:{type:'object',properties:{}}}]}:{content:[{type:'text',text:'personal'}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:b.id,result})+String.fromCharCode(10))})"
    const entry = (id: string, serverName: string, disabled = false) => ({ id, name: '/opt/dsh/node_modules/@deepseek-ai/dsh-mcp-client/lib/index.js', disabled, config: { transport: 'stdio', serverName, command: 'node', args: ['-e', personalCommand], env: { PERSONAL_SETTING: 'member-owned-value' } } })
    // Personal definitions live in the native profile; home overrides must not replace their configuration.
    const profilePatch = join(home, 'profiles/web/cordis.patch.yml')
    const faultRoot = join(runtime.dataRoot, 'users/member/home')
    await writeFile(join(faultRoot, 'mcp-fault.mjs'), `import { existsSync, readFileSync, writeFileSync } from 'node:fs';
export function apply(ctx) { ctx.on('app-boot/config-reload', () => {
  if (existsSync('/dsh-phalanx/home/mcp-arm') && readFileSync('/dsh-phalanx/home/.dsh/cordis.patch.yml', 'utf8').includes('phalanx-mcp-yield:["failure-personal",')) {
    writeFileSync('/dsh-phalanx/home/mcp-failed', 'injected'); throw new Error('Injected member fixture reload failure');
  }
}) }`)
    const original = await readFile(profilePatch, 'utf8').catch(() => '[]')
    const document = parseDocument(original, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] })
    document.add({ insert: [entry('personal-mcp', 'p-collision'), entry('already-disabled', 'p-collision', true), entry('unrelated-mcp', 'personal-other')] })
    document.add({ insert: [{ id: 'mcp-failure-fixture', name: '/dsh-phalanx/home/mcp-fault.mjs' }] })
    await writeFile(profilePatch, String(document))
    const session = await rpc.remoteRpc<{ sessionId: string }>(origin, member, 'session/create', { request: { cwd: '/dsh-phalanx/workspace' } })
    const prompt = async (marker: string) => {
      await rpc.remoteRpc(origin, member, 'session/prompt', { request: { requestId: randomUUID(), sessionId: session.sessionId, mode: 'queue', content: [{ type: 'text', text: marker }] } })
      await expect.poll(() => observations.some(row => row.marker === marker), { timeout: 60000 }).toBe(true)
      await expect.poll(async () => (await rpc.remoteRpc<{ items: { sessionId: string, running: boolean }[] }>(origin, member, 'session/list', { _request: {} })).items.find(item => item.sessionId === session.sessionId)?.running, { timeout: 30000 }).toBe(false)
      return observations.find(row => row.marker === marker)!.tools.filter(name => name.startsWith('mcp__')).sort()
    }
    const inventory = () => rpc.remoteRpc<{ entryId: string, enabled: boolean, fiberPhase: string }[]>(origin, member, 'pluginManager/listPlugins', {})
    await expect.poll(async () => (await inventory()).some(row => row.entryId.endsWith(':personal-mcp') && row.enabled && row.fiberPhase === 'active'), { timeout: 30000 }).toBe(true)
    expect(await prompt('PERSONAL')).toEqual(['mcp__p-collision__personal_echo', 'mcp__personal-other__personal_echo'])
    const grant = (names: string[]) => post('groups/' + account.groupId + '/mcp', { names })
    expect((await grant(['p-collision'])).status).toBe(200)
    const platformTools = await prompt('PLATFORM')
    if (process.env.DSH_PHALANX_E2E_EVIDENCE_DIR) await writeFile(join(process.env.DSH_PHALANX_E2E_EVIDENCE_DIR, 'lifecycle-inventory.json'), JSON.stringify(await inventory(), null, 2))
    expect(platformTools).toEqual(['mcp__p-collision__platform_echo', 'mcp__personal-other__personal_echo'])
    expect(await readFile(patch, 'utf8')).toContain('phalanx-mcp-yield')
    expect((await grant([])).status).toBe(200)
    expect(await prompt('RESTORED')).toEqual(['mcp__p-collision__personal_echo', 'mcp__personal-other__personal_echo'])
    expect((await inventory()).find(row => row.entryId.endsWith(':already-disabled'))?.enabled).toBe(false)
    expect((await grant(['p-collision'])).status).toBe(200)
    await prompt('GRANTED_AGAIN')
    const toggle = (enabled: boolean) => fetch(origin + '/market/api/mcp', { method: 'POST', headers: { cookie: member, origin, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'p-collision', action: enabled ? 'enable' : 'disable' }) })
    expect((await toggle(false)).status).toBe(200)
    expect(await prompt('MEMBER_DISABLED')).toEqual(['mcp__p-collision__personal_echo', 'mcp__personal-other__personal_echo'])
    expect((await toggle(true)).status).toBe(200)
    expect((await post('mcp/test', { name: 'p-collision' })).status).toBe(200)
    expect((await post('mcp', { action: 'publish', name: 'p-collision', published: true })).status).toBe(200)
    expect((await grant([])).status).toBe(200)
    expect((await toggle(true)).status).toBe(200)
    expect(await prompt('MARKET_SELECTED')).toEqual(['mcp__p-collision__platform_echo', 'mcp__personal-other__personal_echo'])
    expect((await post('mcp', { action: 'publish', name: 'p-collision', published: false })).status).toBe(200)
    expect(await prompt('UNPUBLISHED')).toEqual(['mcp__p-collision__personal_echo', 'mcp__personal-other__personal_echo'])
    expect((await grant(['p-collision'])).status).toBe(200)
    expect(await prompt('GRANT_REMAINS')).toEqual(['mcp__p-collision__platform_echo', 'mcp__personal-other__personal_echo'])
    const personalId = (await inventory()).find(row => row.entryId.endsWith(':personal-mcp'))!.entryId
    // Native profile writes and platform refresh race through the official coordination seams.
    const [disabled, renamed] = await Promise.all([
      rpc.remoteRpc(origin, member, 'pluginManager/setPluginEnabled', { id: personalId, enabled: false }),
      post('mcp', { action: 'save', originalName: 'p-collision', service: { ...input, name: 'p-renamed', url: upstreamOrigin + '/new' } }),
    ])
    expect(disabled).toMatchObject({ application: 'applied' }); expect(renamed.status).toBe(200)
    expect(await prompt('RENAMED')).toEqual(['mcp__p-renamed__replacement_echo', 'mcp__personal-other__personal_echo'])
    expect(await readFile(patch, 'utf8')).not.toContain('phalanx-mcp-yield')
    expect(await rpc.remoteRpc(origin, member, 'pluginManager/setPluginEnabled', { id: personalId, enabled: true })).toMatchObject({ application: 'applied' })
    expect((await post('mcp', { action: 'save', originalName: 'p-renamed', service: input })).status).toBe(200)
    expect(await prompt('COLLISION_AGAIN')).toEqual(['mcp__p-collision__platform_echo', 'mcp__personal-other__personal_echo'])
    expect((await post('mcp', { action: 'remove', name: 'p-collision' })).status).toBe(200)
    expect(await prompt('REMOVED')).toEqual(['mcp__p-collision__personal_echo', 'mcp__personal-other__personal_echo'])
    const personalRows = parse(await readFile(profilePatch, 'utf8'), { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] }) as { insert?: ReturnType<typeof entry>[] }[]
    expect(personalRows.flatMap(row => row.insert ?? []).filter(row => row.id !== 'mcp-failure-fixture')).toEqual([entry('personal-mcp', 'p-collision'), entry('already-disabled', 'p-collision', true), entry('unrelated-mcp', 'personal-other')])
    const after = JSON.parse(await execFileText('podman', ['inspect', carrier]))[0]
    expect(after.Id).toBe(before.Id); expect(after.State.StartedAt).toBe(before.State.StartedAt)
    expect((await post('mcp', { action: 'save', service: input })).status).toBe(200)
    expect((await grant(['p-collision'])).status).toBe(200)
    expect(await prompt('BEFORE_RESTART')).toEqual(['mcp__p-collision__platform_echo', 'mcp__personal-other__personal_echo'])
    expect((await fetch(origin + '/recovery/restart', { method: 'POST', headers: { cookie: member, origin, 'content-type': 'application/json' }, body: JSON.stringify({ confirmed: true }) })).status).toBe(200)
    expect(await prompt('AFTER_RESTART')).toEqual(['mcp__p-collision__platform_echo', 'mcp__personal-other__personal_echo'])
    carrier = (await execFileText('podman', ['ps', '--filter', `label=dsh-phalanx.community-root=${owner}`, '--format', '{{.Names}}'])).trim()
    expect((await grant([])).status).toBe(200)
    expect(await prompt('RESTART_RESTORED')).toEqual(['mcp__p-collision__personal_echo', 'mcp__personal-other__personal_echo'])
    const homeDocument = parseDocument(await readFile(patch, 'utf8'))
    homeDocument.add({ insert: [entry('home-personal', 'p-home')] })
    await writeFile(patch, String(homeDocument))
    await expect.poll(async () => (await inventory()).some(row => row.entryId.endsWith(':home-personal') && row.fiberPhase === 'active'), { timeout: 30000 }).toBe(true)
    expect((await prompt('HOME_PERSONAL'))).toContain('mcp__p-home__personal_echo')
    expect((await post('mcp', { action: 'save', service: { ...input, name: 'p-home' } })).status).toBe(200)
    expect((await grant(['p-home'])).status).toBe(200)
    expect(await prompt('HOME_PLATFORM')).toEqual(['mcp__p-collision__personal_echo', 'mcp__p-home__platform_echo', 'mcp__personal-other__personal_echo'])
    expect((await grant([])).status).toBe(200)
    expect(await prompt('HOME_RESTORED')).toEqual(['mcp__p-collision__personal_echo', 'mcp__p-home__personal_echo', 'mcp__personal-other__personal_echo'])
    expect((await post('mcp', { action: 'save', service: { ...input, name: 'p-failure' } })).status).toBe(200)
    expect((await grant(['p-failure'])).status).toBe(200)
    expect(await prompt('FAILURE_BASELINE')).toContain('mcp__p-failure__platform_echo')
    const entriesFile = join(runtime.dataRoot, 'mcp/members', account.spaceId, 'entries.json'), stableEntries = await readFile(entriesFile, 'utf8')
    await writeFile(join(faultRoot, 'mcp-arm'), 'armed')
    const failureDocument = parseDocument(await readFile(patch, 'utf8'))
    failureDocument.add({ insert: [entry('failure-personal', 'p-failure')] })
    await writeFile(patch, String(failureDocument))
    await rpc.remoteRpc(origin, member, 'session/prompt', { request: { requestId: randomUUID(), sessionId: session.sessionId, mode: 'queue', content: [{ type: 'text', text: 'INJECTED_FAILURE' }] } })
    await expect.poll(() => access(join(faultRoot, 'mcp-failed')).then(() => true, () => false), { timeout: 30000 }).toBe(true)
    await expect.poll(async () => (await rpc.remoteRpc<{ items: { sessionId: string, running: boolean }[] }>(origin, member, 'session/list', { _request: {} })).items.find(item => item.sessionId === session.sessionId)?.running, { timeout: 30000 }).toBe(false)
    await rm(join(faultRoot, 'mcp-arm'))
    expect(await prompt('RECOVERED')).toContain('mcp__p-failure__platform_echo')
    expect(await readFile(entriesFile, 'utf8')).toBe(stableEntries)
    expect((await grant([])).status).toBe(200)
    expect(await prompt('FAILURE_PERSONAL_RESTORED')).toContain('mcp__p-failure__personal_echo')
    expect((await grant(['p-failure'])).status).toBe(200)
    expect(await prompt('BEFORE_LOCATION_CHANGE')).toContain('mcp__p-failure__platform_echo')
    expect((await post('mcp', { action: 'save', service: { ...input, name: 'p-failure', run: { location: 'member', command: 'node', args: [], env: [], prepareCommand: 'exit 1' } } })).status).toBe(200)
    const unprepared = await prompt('LOCATION_UNPREPARED')
    expect(unprepared).toContain('mcp__p-failure__personal_echo'); expect(unprepared).not.toContain('mcp__p-failure__platform_echo')
    expect((await post('mcp', { action: 'save', service: { ...input, name: 'p-failure', run: null } })).status).toBe(200)
    const remoteAgain = await prompt('LOCATION_REMOTE_AGAIN')
    expect(remoteAgain).toContain('mcp__p-failure__platform_echo'); expect(remoteAgain).not.toContain('mcp__p-failure__personal_echo')
    passed = true
  } finally {
    const evidence = process.env.DSH_PHALANX_E2E_EVIDENCE_DIR
    if (evidence) await writeFile(join(evidence, 'mcp-lifecycle-result.json'), JSON.stringify({ passed, observations }, null, 2))
    if (!passed && evidence && carrier) {
      await writeFile(join(evidence, 'mcp-lifecycle-container.log'), await execFileText('podman', ['logs', carrier]).catch(() => 'unavailable'))
      await writeFile(join(evidence, 'mcp-lifecycle-files.log'), await execFileText('podman', ['exec', carrier, 'sh', '-c', 'find /dsh-phalanx/home/.dsh -name "*.log" -type f -exec tail -100 {} \\;']).catch(() => 'unavailable'))
    }
    await app.stop(); await new CommunityRuntimeDriver(runtime).rebuild()
    for (const server of [upstream, model]) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
    await rm(root, { recursive: true, force: true })
  }
}, 300000)
