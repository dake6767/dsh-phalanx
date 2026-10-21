// Validation: T2; real credentials: none; installed DSH clients in all three MCP run locations.
import type { CommunityRuntimeConfig } from '../src/domain/community-config.js'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { candidateApplication } from './support/candidate-application.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { assertPinnedDshRevision, runtimeSection } from './support/real-dsh-runtime.js'
import { createBrowserDshRpc, cookieHeader } from './support/real-dsh-rpc.js'
import { communityEntryUrl } from './support/community-space.js'
import { latestHumanText, hasToolResult, streamText, streamToolCall } from './support/real-dsh-model.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import { signInCommunity } from './fixtures/community-native-browser.js'

it('projects remote, shared and member MCP into an expert, isolates failed services, preserves independent access and deduplicates enabled globals', async () => {
  assertPinnedDshRevision(runtimeSettings)
  const root = await realpath(await mkdtemp(join(tmpdir(), 'expert-mcp-'))), secret = randomUUID(), captures = new Map<string, string[]>()
  const credentials: boolean[] = []; let exposed = false
  const model = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk
    exposed ||= raw.includes(secret)
    const body = JSON.parse(raw), marker = latestHumanText(body)
    if (body.tools?.length) captures.set(marker, body.tools.map((tool: { name: string }) => tool.name))
    response.setHeader('content-type', 'text/event-stream')
    if (marker.startsWith('CALL_EXPERT_MCP')) {
      for (const location of ['remote', 'shared', 'member']) if (!hasToolResult(body, location + '-call', false) && !hasToolResult(body, location + '-call', true)) { streamToolCall(response, location + '-call', 'mcp__p-' + location + '__echo', {}); return }
    }
    streamText(response, 'DONE_' + marker)
  })
  const tools = [{ name: 'echo', description: 'MCP echo', inputSchema: { type: 'object', properties: {} } }, { name: 'write', inputSchema: { type: 'object', properties: {} } }]
  const remote = createServer(async (request, response) => {
    if (request.url === '/unavailable') { response.writeHead(503).end('Fixture unavailable'); return }
    if (request.method !== 'POST') { response.writeHead(405).end(); return }
    credentials.push(request.headers.authorization === 'Bearer ' + secret)
    let raw = ''; for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw)
    if (body.id === undefined) { response.writeHead(202).end(); return }
    const result = body.method === 'initialize' ? { protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'remote-fixture', version: '1' } }
      : body.method === 'tools/list' ? { tools } : { content: [{ type: 'text', text: 'REMOTE_READY ' + secret }] }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }))
  })
  model.listen(0, '127.0.0.1'); remote.listen(0, '127.0.0.1'); await Promise.all([once(model, 'listening'), once(remote, 'listening')])
  const address = (server: typeof model) => `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const baseRuntime = runtimeSection(join(root, 'platform'), address(model), runtimeSettings), home = join(baseRuntime.dataRoot, 'users/member/home'), overlay = join(root, 'expert-mcp.json')
  const runtime: CommunityRuntimeConfig = { ...baseRuntime, patches: [...baseRuntime.patches, overlay] }
  await writeFile(overlay, JSON.stringify([{ id: 'tools', config: { mode: 'native' } }, { insert: [{ id: 'expert-mcp-observer', name: runtime.container ? '/dsh-phalanx/home/expert-mcp-observer.mjs' : join(home, 'expert-mcp-observer.mjs') }] }]))
  const app = candidateApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'expert-mcp-acceptance-fixture-secret', runtime })
  const browser = await chromium.launch({ headless: true })
  let primaryFailure: unknown
  const cleanupErrors: unknown[] = []
  try {
    const origin = await app.start(), admin = await browser.newPage({ locale: 'en' }); admin.setDefaultTimeout(30000)
    await admin.goto(origin + '/bootstrap#credential=' + readBootstrapCredential(runtime.dataRoot)!.credential)
    await admin.getByLabel('Username', { exact: true }).fill('admin'); await admin.getByLabel('Password', { exact: true }).fill('password')
    await admin.getByRole('button', { name: 'Create administrator' }).click(); await admin.waitForURL(origin + '/admin')
    const api = async (path: string, data?: object) => { const response = data ? await admin.request.post(origin + '/admin/api/' + path, { headers: { origin }, data }) : await admin.request.get(origin + '/admin/api/' + path); expect(response.ok(), await response.text()).toBe(true); return response.json() }
    const models = await api('models')
    await api('models', { revision: models.revision, action: 'save-provider', provider: { name: 'Fixture', baseUrl: address(model) + '/anthropic', apiFormat: 'anthropic-messages', apiKey: 'fictional-model-key', enabled: true, models: [{ name: 'expert-mcp', enabled: true }] } })
    const account = await api('accounts', { username: 'member', password: 'password', email: '' })
    await mkdir(home, { recursive: true }); await copyFile('tests/fixtures/skill-observer.mjs', join(home, 'expert-mcp-observer.mjs'))
    await api('mcp', { action: 'save', service: { name: 'p-remote', description: 'Remote expert MCP', url: address(remote), credential: secret, headers: [{ name: 'Authorization', value: 'Bearer {credential}' }], disabledTools: ['write'] } })
    const script = `import{createInterface}from'node:readline';for await(const line of createInterface({input:process.stdin})){const m=JSON.parse(line);if(m.id===undefined)continue;const result=m.method==='initialize'?{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:m.method==='tools/list'?{tools:${JSON.stringify(tools)}}:{content:[{type:'text',text:process.env.LOCATION+'_READY '+(process.env.KEY??'member-public')}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n')}`
    const prepareCommand = `node -e 'if(process.env.KEY)throw Error("Unexpected preparation credential");require("fs").writeFileSync("server.mjs",Buffer.from("${Buffer.from(script).toString('base64')}","base64"))'`
    for (const location of ['shared', 'member'] as const) {
      await api('mcp', { action: 'save', service: { name: 'p-' + location, description: location + ' expert MCP', url: '', ...(location === 'shared' ? { credential: secret } : {}), disabledTools: ['write'], run: { location, command: 'node', args: ['{dependencies}/server.mjs'], env: [{ name: 'LOCATION', value: location.toUpperCase() }, ...(location === 'shared' ? [{ name: 'KEY', value: '{credential}' }] : [])], prepareCommand } } })
      await expect.poll(async () => (await api('mcp')).find((row: { name: string }) => row.name === 'p-' + location)?.preparation?.stage, { timeout: 120000 }).toMatch(/^(ready|failed)$/u)
      expect((await api('mcp')).find((row: { name: string }) => row.name === 'p-' + location)?.preparation).toMatchObject({ stage: 'ready' })
    }
    await api('mcp', { action: 'save', service: { name: 'p-bad-remote', description: 'Unavailable remote fixture', url: address(remote) + '/unavailable' } })
    for (const location of ['shared', 'member'] as const) {
      await api('mcp', { action: 'save', service: { name: 'p-bad-' + location, description: 'Unavailable ' + location + ' fixture', url: '', run: { location, command: 'node', args: ['-e', 'process.exit(1)'], env: [] } } })
      await expect.poll(async () => (await api('mcp')).find((row: { name: string }) => row.name === 'p-bad-' + location)?.preparation?.stage, { timeout: 120000 }).toBe('ready')
    }
    await admin.getByRole('link', { name: 'Expert library', exact: true }).click(); await admin.getByRole('button', { name: 'Create expert', exact: true }).click()
    await admin.getByLabel('Expert name', { exact: true }).fill('MCP expert'); await admin.getByLabel('Expert description', { exact: true }).fill('Three MCP locations')
    await admin.getByLabel('Expert persona', { exact: true }).fill('Use expert MCP tools.')
    for (const name of ['p-remote', 'p-shared', 'p-member', 'p-bad-remote', 'p-bad-shared', 'p-bad-member']) await admin.getByRole('dialog').getByText(name, { exact: true }).first().click()
    await admin.getByRole('button', { name: 'Save expert', exact: true }).click(); await admin.getByRole('button', { name: 'Edit expert MCP expert', exact: true }).waitFor()
    const expert = (await api('experts')).experts[0], preset = 'phalanx-expert-' + expert.id, grantPath = `groups/${account.groupId}/experts`, grant = await api(grantPath)
    expect([...expert.mcp].sort()).toEqual(['p-bad-member', 'p-bad-remote', 'p-bad-shared', 'p-member', 'p-remote', 'p-shared'])
    await api(grantPath, { names: [expert.id], revision: grant.revision, confirmed: true })
    const member = await browser.newPage({ locale: 'en' }); await signInCommunity(member, origin, 'member', 'password')
    const cookie = await cookieHeader(member.context(), origin), base = communityEntryUrl(origin, cookie), rpc = createBrowserDshRpc(member.context())
    const session = async (agentPreset: string) => (await rpc.remoteRpc<{ sessionId: string }>(origin, cookie, 'session/create', { request: { cwd: runtime.container ? '/dsh-phalanx/workspace' : join(runtime.dataRoot, 'users/member/workspace'), agentPreset } })).sessionId
    const tool = async (sessionId: string, name: string) => { const response = await member.request.post(base + 'skills-fixture', { headers: { origin }, data: { operation: 'tool', sessionId, name, args: {} } }); expect(response.status(), await response.text()).toBe(200); const result = await response.json(); expect(JSON.stringify(result)).not.toContain(secret); return result }
    const prompt = async (sessionId: string, marker: string) => {
      await rpc.remoteRpc(origin, cookie, 'session/prompt', { request: { requestId: randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text: marker }] } })
      await expect.poll(() => captures.has(marker), { timeout: 30000 }).toBe(true)
      await expect.poll(async () => (await rpc.remoteRpc<{ items: { sessionId: string, running: boolean }[] }>(origin, cookie, 'session/list', { _request: {} })).items.find(row => row.sessionId === sessionId)?.running, { timeout: 30000 }).toBe(false)
      return captures.get(marker)!
    }
    const verify = async (globalRemote: boolean) => {
      const roster = await rpc.remoteRpc<{ presets: { id: string, broken?: string }[] }>(origin, cookie, 'agentPresets/list', {})
      const mounted = roster.presets.find(row => row.id === preset)
      expect(mounted).toBeDefined(); expect(mounted?.broken).toBeUndefined()
      const expertSession = await session(preset), standard = await session('standard')
      const inventory = await prompt(expertSession, randomUUID())
      for (const location of ['remote', 'shared', 'member']) {
        const result = await tool(expertSession, 'mcp__p-' + location + '__echo')
        expect(result.isError, JSON.stringify(result)).not.toBe(true); expect(JSON.stringify(result)).toContain(location.toUpperCase() + '_READY')
        expect((await tool(expertSession, 'mcp__p-' + location + '__write')).error.info.code).toBe('UNKNOWN_TOOL')
      }
      const result = await tool(standard, 'mcp__p-remote__echo')
      if (globalRemote) expect(JSON.stringify(result)).toContain('REMOTE_READY'); else expect(result.error.info.code).toBe('UNKNOWN_TOOL')
      for (const location of ['shared', 'member']) expect((await tool(standard, 'mcp__p-' + location + '__echo')).error.info.code).toBe('UNKNOWN_TOOL')
      for (const location of ['remote', 'shared', 'member']) expect(inventory.filter(name => name === 'mcp__p-' + location + '__echo')).toHaveLength(1)
      await prompt(expertSession, 'CALL_EXPERT_MCP_' + randomUUID())
      expect(exposed).toBe(false); expect(credentials.every(Boolean)).toBe(true); expect(credentials.length).toBeGreaterThan(0)
      await expect.poll(async () => (await api('experts')).experts.flatMap((row: { checking?: readonly string[] }) => row.checking ?? []), { timeout: 30000 }).toEqual([])
      expect((await api('experts')).experts[0].failures).toEqual([{ username: 'member', entries: ['mcp:p-bad-member', 'mcp:p-bad-remote', 'mcp:p-bad-shared'] }])
      return expertSession
    }
    await verify(false)
    await api(`groups/${account.groupId}/mcp`, { names: ['p-remote'] })
    const restart = async () => expect((await member.request.post(origin + '/recovery/restart', { headers: { origin }, data: { confirmed: true } })).status()).toBe(200)
    await restart(); await verify(true)
    expect((await member.request.post(origin + '/market/api/mcp', { headers: { origin }, data: { name: 'p-remote', action: 'disable' } })).status()).toBe(200)
    await restart(); const stale = await verify(false)
    // Immediate gateway withdrawal removes only the expert source; a direct source remains independent.
    await api(`groups/${account.groupId}/mcp`, { names: ['p-remote'] })
    expect((await member.request.post(origin + '/market/api/mcp', { headers: { origin }, data: { name: 'p-remote', action: 'enable' } })).status()).toBe(200)
    const lastGrant = await api(grantPath)
    await api(grantPath, { names: [], revision: lastGrant.revision, confirmed: true })
    expect(JSON.stringify(await tool(stale, 'mcp__p-remote__echo'))).toContain('REMOTE_READY')
    const denied = await tool(stale, 'mcp__p-shared__echo')
    expect(denied.isError).toBe(true); expect(JSON.stringify(denied)).toContain('authorization-denied')
  } catch (error) { primaryFailure = error }
  finally {
    const attempt = async (action: () => Promise<unknown>) => { try { await action(); return true } catch (error) { cleanupErrors.push(error); return false } }
    await attempt(() => browser.close())
    const stopped = await attempt(() => app.stop()), rebuilt = await attempt(() => new CommunityRuntimeDriver(runtime).rebuild())
    for (const server of [model, remote]) { server.closeAllConnections(); await attempt(() => new Promise<void>(resolve => server.close(() => resolve()))) }
    const writable = async (path: string): Promise<void> => { if ((await lstat(path)).isDirectory()) { await chmod(path, 0o700); for (const name of await readdir(path)) await writable(join(path, name)) } }
    if (stopped && rebuilt) await attempt(async () => { await writable(root); await rm(root, { recursive: true, force: true }) })
  }
  if (cleanupErrors.length) throw new AggregateError(primaryFailure ? [primaryFailure, ...cleanupErrors] : cleanupErrors, 'Expert MCP acceptance cleanup failed')
  if (primaryFailure) throw primaryFailure
}, 360000)
