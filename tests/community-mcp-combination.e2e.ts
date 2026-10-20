// Validation: T4 only; real credentials: required (provider keys or deployed account). Never selected by T2.
import { readUsageRecords } from './support/usage-records.js'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile, readdir, chmod, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { candidateApplication } from './support/candidate-application.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import { execFileText } from '../src/adapters/runtime-command.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { assertPinnedDshRevision, runtimeSection } from './support/real-dsh-runtime.js'
import { createRealDshRpc } from './support/real-dsh-rpc.js'
import { streamText, streamToolCall, hasToolResult, latestHumanText } from './support/real-dsh-model.js'
import { readPrivateMcpCredential, memberExposesMcpCredentials } from './support/real-mcp-credentials.js'
import { amapSample, bochaSample, githubSample, context7Sample, playwrightSample } from './support/real-mcp-samples.js'
import { verifiedBochaInput } from './support/verified-bocha-input.js'
import type { CommunityMcpInput, CommunityMcpSettings } from '../src/domain/admin-contract.js'

const keyFiles = [process.env.DSH_PHALANX_GITHUB_MCP_PAT_FILE, process.env.DSH_PHALANX_AMAP_API_KEY_FILE, process.env.DSH_PHALANX_BOCHA_API_KEY_FILE]
it.skipIf(keyFiles.some(path => !path) || !runtimeSettings.containerImage)('combines five real MCP samples across granted and self-selected groups in one installed candidate', async () => {
  assertPinnedDshRevision(runtimeSettings)
  const secrets = await Promise.all(keyFiles.map(path => readPrivateMcpCredential(path!)))
  const inputs: CommunityMcpInput[] = [context7Sample, { ...githubSample, credential: secrets[0]! }, { ...amapSample, credential: secrets[1]! }, { ...bochaSample, credential: secrets[2]! }, playwrightSample]
  const calls: Record<string, { tool: string, args: Record<string, unknown>, valid: (text: string) => boolean }> = {
    'p-context7': { tool: 'resolve-library-id', args: { libraryName: 'React', query: 'React useState hook documentation' }, valid: text => text.includes('react') && text.includes('/') },
    'p-github': { tool: 'get_me', args: {}, valid: text => text.includes('login') && text.includes('id') },
    'p-amap': { tool: 'maps_weather', args: { city: '110000' }, valid: text => /北京市|北京/u.test(text) && /weather|天气|temperature|温度/u.test(text) },
    'p-bocha': { tool: 'bocha_web_search', args: { query: 'Python official documentation', count: 1 }, valid: text => text.includes('Title:') && text.includes('URL:') },
    'p-browser': { tool: 'browser_navigate', args: { url: 'file:///dsh-phalanx/workspace/input.html' }, valid: text => text.includes('input.html') },
  }
  const observations: { marker: string, tools: string[], success: boolean, failed: boolean, semantic: boolean }[] = []
  let exposed = false, passed = false
  const model = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk
    exposed ||= secrets.some(secret => text.includes(secret))
    const body = JSON.parse(text), marker = latestHumanText(body), id = marker.toLowerCase(), name = marker.split(':')[2] ?? '', call = calls[name]
    const success = hasToolResult(body, id, false), failed = hasToolResult(body, id, true)
    const results = (body.messages ?? []).flatMap((row: { content?: unknown }) => Array.isArray(row.content) ? row.content : []).filter((block: { type?: string, tool_use_id?: string }) => block.type === 'tool_result' && block.tool_use_id === id)
    observations.push({ marker, tools: (body.tools ?? []).map((tool: { name: string }) => tool.name).filter((tool: string) => tool.startsWith('mcp__')), success, failed, semantic: Boolean(call && success && call.valid(JSON.stringify(results))) })
    response.setHeader('content-type', 'text/event-stream')
    if (marker.startsWith('CALL:') && call && !success && !failed) streamToolCall(response, id, `mcp__${name}__${call.tool}`, call.args)
    else streamText(response, 'DONE_' + marker)
  })
  model.listen(0, '127.0.0.1'); await once(model, 'listening')
  const modelOrigin = `http://127.0.0.1:${(model.address() as { port: number }).port}`
  const root = await mkdtemp(join(tmpdir(), 'mcp-combination-'))
  const fixture = await verifiedBochaInput(runtimeSection(root, modelOrigin, runtimeSettings)), runtime = fixture.runtime
  inputs[3] = { ...fixture.service, credential: secrets[2]! }
  const app = candidateApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'combination-fixture-session-secret', runtime })
  const rpc = createRealDshRpc(), cookie = (response: Response) => response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  const preparations: Record<string, string> = {}, discoveries: Record<string, number> = {}
  try {
    const origin = await app.start()
    const bootstrap = await fetch(origin + '/bootstrap', { method: 'POST', redirect: 'manual', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ credential: readBootstrapCredential(root)!.credential, username: 'admin', password: 'password' }) })
    expect(bootstrap.status).toBe(303); const admin = cookie(bootstrap)
    const post = (path: string, body: object) => fetch(origin + '/admin/api/' + path, { method: 'POST', headers: { cookie: admin, origin, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const get = async (path: string) => await (await fetch(origin + '/admin/api/' + path, { headers: { cookie: admin } })).json()
    const settings = await get('models')
    expect((await post('models', { revision: settings.revision, action: 'save-provider', provider: { name: 'Fixture', baseUrl: modelOrigin + '/anthropic', apiFormat: 'anthropic-messages', apiKey: 'fictional-model-key', enabled: true, models: [{ name: 'fixture-model', enabled: true }] } })).status).toBe(200)
    expect((await post('groups', { action: 'create', name: 'Self selected' })).status).toBe(200)
    const groups = await get('groups') as { name: string, id: string, isDefault: boolean }[]
    const members: { name: string, groupId: string, cookie: string, sessionId: string }[] = []
    for (const [name, groupId] of [['alice', groups.find(row => row.isDefault)!.id], ['bob', groups.find(row => row.name === 'Self selected')!.id]] as const) {
      expect((await post('accounts', { username: name, password: 'password', email: '', groupId })).status).toBe(201)
      const login = await fetch(origin + '/login', { method: 'POST', redirect: 'manual', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: name, password: 'password' }) })
      expect(login.status).toBe(303); const member = cookie(login)
      const session = await rpc.remoteRpc<{ sessionId: string }>(origin, member, 'session/create', { request: { cwd: '/dsh-phalanx/workspace' } })
      members.push({ name, groupId, cookie: member, sessionId: session.sessionId })
      await writeFile(join(root, 'users', name, 'workspace/input.html'), `<h1>COMBINATION_${name}</h1>`)
    }
    const prompt = async (member: typeof members[number], marker: string) => {
      await rpc.remoteRpc(origin, member.cookie, 'session/prompt', { request: { requestId: randomUUID(), sessionId: member.sessionId, mode: 'queue', content: [{ type: 'text', text: marker }] } })
      await expect.poll(() => observations.some(row => row.marker === marker && (!marker.startsWith('CALL:') || row.success || row.failed)), { timeout: 90000 }).toBe(true)
      await expect.poll(async () => (await rpc.remoteRpc<{ items: { sessionId: string, running: boolean }[] }>(origin, member.cookie, 'session/list', { _request: {} })).items.find(row => row.sessionId === member.sessionId)?.running, { timeout: 30000 }).toBe(false)
      return observations.filter(row => row.marker === marker).at(-1)!
    }
    const toggle = (member: typeof members[number], name: string, action: string) => fetch(origin + '/market/api/mcp', { method: 'POST', headers: { cookie: member.cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify({ name, action }) })
    for (const input of inputs) {
      expect((await post('mcp', { action: 'save', service: input })).status).toBe(200)
      if (input.run) {
        await expect.poll(async () => { const row = (await get('mcp')).find((value: { name: string }) => value.name === input.name); preparations[input.name] = row.preparation?.stage ?? 'pending'; return preparations[input.name] }, { timeout: 660000 }).toMatch(/^(ready|failed)$/u)
        expect(preparations[input.name]).toBe('ready')
      }
      const tested = await post('mcp/test', { name: input.name }); expect(tested.status).toBe(200)
      const discovered = await tested.json() as CommunityMcpSettings
      expect(secrets.some(secret => JSON.stringify(discovered).includes(secret))).toBe(false)
      expect(discovered.testStatus).toBe('passed'); discoveries[input.name] = discovered.tools.length
      expect(discovered.tools.some(tool => tool.name === calls[input.name]!.tool)).toBe(true)
      if (input.name === 'p-github') {
        const disabledTools = discovered.tools.filter(tool => tool.name !== 'get_me').map(tool => tool.name)
        expect((await post('mcp', { action: 'save', service: { ...input, disabledTools, credential: undefined } })).status).toBe(200)
        expect((await (await post('mcp/test', { name: input.name })).json()).testStatus).toBe('passed')
      }
      expect((await post('mcp', { action: 'publish', name: input.name, published: true })).status).toBe(200)
    }
    const names = inputs.map(input => input.name), alice = members[0]!, bob = members[1]!
    expect((await post(`groups/${alice.groupId}/mcp`, { names })).status).toBe(200)
    expect((await prompt(bob, 'BEFORE_SELECTION')).tools).toEqual([])
    for (const name of names) expect((await toggle(bob, name, 'enable')).status).toBe(200)
    for (const member of members) {
      for (const name of names) {
        const result = await prompt(member, `CALL:${member.name}:${name}`)
        expect(result).toMatchObject({ success: true, failed: false, semantic: true })
        expect(result.tools.filter(tool => tool.startsWith('mcp__p-github__'))).toEqual(['mcp__p-github__get_me'])
      }
      const workspace = join(root, 'users', member.name, 'workspace')
      const snapshots = await Promise.all((await readdir(workspace)).filter(name => /^page-.*\.yml$/u.test(name)).map(name => readFile(join(workspace, name), 'utf8')))
      expect(snapshots.join('\n').includes('COMBINATION_' + member.name)).toBe(true)
    }
    expect(exposed).toBe(false)
    const owner = createHash('sha256').update(root).digest('hex')
    const carriers = (await execFileText('podman', ['ps', '--filter', `label=dsh-phalanx.community-root=${owner}`, '--filter', 'label=dsh-phalanx.user', '--format', '{{.Names}}'])).trim().split('\n').filter(Boolean)
    for (const name of ['alice', 'bob']) expect(carriers.some(carrier => carrier.startsWith('dsh-phalanx-' + name + '-'))).toBe(true)
    const before = JSON.parse(await execFileText('podman', ['inspect', ...carriers])).map((row: { Id: string, State: { StartedAt: string } }) => [row.Id, row.State.StartedAt])
    for (const carrier of carriers) {
      expect(await memberExposesMcpCredentials(carrier, secrets)).toBe(false)
    }
    expect(secrets.some(secret => JSON.stringify(observations).includes(secret))).toBe(false)
    for (const name of names) expect((await toggle(alice, name, 'disable')).status).toBe(200)
    expect((await prompt(alice, 'OPTIONAL_DISABLED')).tools).toEqual([])
    const required = inputs.find(input => input.name === 'p-amap')!
    expect((await post('mcp', { action: 'save', service: { ...required, credential: undefined, required: true } })).status).toBe(200)
    expect((await toggle(alice, required.name, 'disable')).status).toBe(403)
    expect((await prompt(alice, 'REQUIRED')).tools).toContain('mcp__p-amap__maps_weather')
    expect((await post(`groups/${alice.groupId}/mcp`, { names: [] })).status).toBe(200)
    expect((await prompt(alice, 'REVOKED')).tools).toEqual([])
    for (const name of names) expect((await post('mcp', { action: 'remove', name })).status).toBe(200)
    expect((await prompt(bob, 'REMOVED')).tools).toEqual([])
    const after = JSON.parse(await execFileText('podman', ['inspect', ...carriers])).map((row: { Id: string, State: { StartedAt: string } }) => [row.Id, row.State.StartedAt])
    expect(after).toEqual(before)
    const audit = JSON.stringify(await readUsageRecords(origin, admin))
    expect(secrets.some(secret => audit.includes(secret))).toBe(false)
    passed = true
  } finally {
    await app.stop(); await new CommunityRuntimeDriver(runtime).rebuild()
    model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve()))
    const writable = async (path: string): Promise<void> => { if ((await lstat(path)).isDirectory()) { await chmod(path, 0o700); for (const name of await readdir(path)) await writable(join(path, name)) } }
    await writable(root); await rm(root, { recursive: true, force: true })
    if (process.env.DSH_PHALANX_E2E_EVIDENCE_DIR) await writeFile(join(process.env.DSH_PHALANX_E2E_EVIDENCE_DIR, 'mcp-combination-result.json'), JSON.stringify({ passed, preparations, discoveries, exposed, observations }) + '\n')
  }
}, 1800000)
