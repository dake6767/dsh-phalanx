// Validation: T2; real credentials: none; installed rootless DSH and offline-prechecked fixture archives.
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { candidateApplication } from './support/candidate-application.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { assertPinnedDshRevision, runtimeSection } from './support/real-dsh-runtime.js'
import { cookieHeader, createRealDshRpc } from './support/real-dsh-rpc.js'
import { communityEntryUrl } from './support/community-space.js'
import { latestHumanText, streamText } from './support/real-dsh-model.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import { signInCommunity } from './fixtures/community-native-browser.js'
import { expertFixturePackage, packExpertPlugin } from './fixtures/expert-plugin.js'

it.skipIf(!runtimeSettings.containerImage)('isolates expert plugins, credentials and failures, deduplicates global acquisition and yields native copies', async () => {
  assertPinnedDshRevision(runtimeSettings)
  const root = await mkdtemp(join(tmpdir(), 'expert-plugins-')), secret = randomUUID(), received: string[] = []
  const captured = new Map<string, string[]>(); let exposed = false
  const model = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    exposed ||= raw.includes(secret)
    const body = JSON.parse(raw)
    if (body.tools?.length) captured.set(latestHumanText(body), body.tools.map((row: { name: string }) => row.name))
    res.setHeader('content-type', 'text/event-stream'); streamText(res, 'EXPERT_PLUGIN_READY')
  })
  const upstream = createServer(async (req, res) => {
    for await (const chunk of req) void chunk
    received.push(req.headers.authorization ?? '')
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ status: 'UPSTREAM_READY' }))
  })
  const mcp = createServer(async (req, res) => {
    if (req.url === '/failed') { res.writeHead(503).end('Fixture unavailable'); return }
    if (req.method !== 'POST') { res.writeHead(405).end(); return }
    received.push(req.headers.authorization ?? '')
    let raw = ''; for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    if (body.id === undefined) { res.writeHead(202).end(); return }
    const result = body.method === 'initialize' ? { protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'plugin-combination-fixture', version: '1' } } : body.method === 'tools/list' ? { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] } : { content: [{ type: 'text', text: 'MCP_COMBINATION_READY' }] }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }))
  })
  for (const server of [model, upstream, mcp]) { server.listen(0, '127.0.0.1'); await once(server, 'listening') }
  const address = (server: typeof model) => `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const runtime = { ...runtimeSection(join(root, 'platform'), address(model), runtimeSettings), environment: { FAIL_EXPERT: '1' } }
  const home = join(runtime.dataRoot, 'users/member/home'), overlay = join(root, 'observer.json')
  await writeFile(overlay, JSON.stringify([{ id: 'tools', config: { mode: 'native' } }, { insert: [{ id: 'expert-test-observer', name: '/dsh-phalanx/home/observer.mjs' }] }]))
  runtime.patches.push(overlay)
  const app = candidateApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'expert-plugins-installed-fixture-secret', runtime })
  const browser = await chromium.launch({ headless: true })
  let primaryFailure: unknown
  const cleanupErrors: unknown[] = []
  try {
    const origin = await app.start(), admin = await browser.newPage({ locale: 'en' }); admin.setDefaultTimeout(30000)
    await admin.goto(origin + '/bootstrap#credential=' + readBootstrapCredential(runtime.dataRoot)!.credential)
    await admin.getByLabel('Username', { exact: true }).fill('admin'); await admin.getByLabel('Password', { exact: true }).fill('password')
    await admin.getByRole('button', { name: 'Create administrator' }).click(); await admin.waitForURL(origin + '/admin')
    const request = (path: string, data?: object) => data ? admin.request.post(origin + '/admin/api/' + path, { headers: { origin }, data }) : admin.request.get(origin + '/admin/api/' + path)
    const api = async (path: string, data?: object) => { const response = await request(path, data); expect(response.ok(), await response.text()).toBe(true); return response.json() }
    const models = await api('models')
    await api('models', { revision: models.revision, action: 'save-provider', provider: { name: 'Fixture', baseUrl: address(model) + '/anthropic', apiFormat: 'anthropic-messages', apiKey: 'fictional-model-key', enabled: true, models: [{ name: 'expert-model', enabled: true }] } })
    const account = await api('accounts', { username: 'member', password: 'password', email: '' })
    await mkdir(home, { recursive: true }); await copyFile('tests/fixtures/skill-observer.mjs', join(home, 'observer.mjs'))
    const packages: string[] = []
    for (const kind of ['healthy', 'core', 'sync', 'async', 'import', 'dependent'] as const) {
      const packed = await packExpertPlugin(root, kind); packages.push(packed.packageName)
      const response = await admin.request.post(origin + '/admin/api/plugins/upload', { headers: { origin, 'content-type': 'application/gzip', 'x-plugin-filename': 'expert.tgz' }, data: await readFile(packed.archive) })
      expect(response.status(), await response.text()).toBe(202)
      await expect.poll(async () => (await api('plugins')).find((row: { packageName: string }) => row.packageName === packed.packageName)?.stage, { timeout: 240000 }).toMatch(/^(available|failed)$/u)
      const prepared = (await api('plugins')).find((row: { packageName: string }) => row.packageName === packed.packageName)
      expect(prepared, JSON.stringify(prepared)).toMatchObject({ stage: 'available' })
    }
    const query = '?packageName=' + encodeURIComponent(expertFixturePackage)
    await api('plugins/upstreams' + query, { action: 'save', upstream: { name: 'search', baseUrl: address(upstream), credential: secret, headers: [{ name: 'Authorization', value: 'Bearer {credential}' }] } })
    await api('plugins/access' + query, { environment: [], entriesYaml: JSON.stringify({ consumer: { endpoint: '{upstream:search}', apiKey: '{access-token}', label: 'configured', nested: { added: true } } }) })
    await api('mcp', { action: 'save', service: { name: 'p-fixture', description: 'Healthy combined MCP', url: address(mcp), credential: secret, headers: [{ name: 'Authorization', value: 'Bearer {credential}' }] } })
    await api('mcp', { action: 'save', service: { name: 'p-failed', description: 'Unavailable combined MCP', url: address(mcp) + '/failed' } })
    await admin.getByRole('link', { name: 'Expert library', exact: true }).click()
    await admin.getByRole('button', { name: 'Create expert', exact: true }).click()
    await admin.getByLabel('Expert name', { exact: true }).fill('Plugin expert')
    await admin.getByLabel('Expert description', { exact: true }).fill('Isolated plugins')
    await admin.getByLabel('Expert persona', { exact: true }).fill('Use the expert plugin.')
    expect(await admin.getByRole('checkbox', { name: '@example/expert-core', exact: true }).isDisabled()).toBe(true)
    await admin.getByText('Unavailable plugins and plugins that change core entries cannot be included in an expert.', { exact: true }).waitFor()
    for (const name of packages.filter(name => name !== '@example/expert-core')) await admin.getByRole('dialog').getByText(name, { exact: true }).first().click()
    for (const name of ['p-fixture', 'p-failed']) await admin.getByRole('dialog').getByText(name, { exact: true }).first().click()
    await admin.getByRole('button', { name: 'Save expert', exact: true }).click()
    await admin.getByRole('button', { name: 'Edit expert Plugin expert', exact: true }).waitFor()
    let library = await api('experts'); const first = library.experts[0], preset = 'phalanx-expert-' + first.id
    const input = { name: 'Other expert', description: 'Second isolated service', icon: '', persona: 'Independent expert.', skills: [], skillPacks: [], plugins: [expertFixturePackage] }
    const rejected = await request('experts', { revision: library.revision, expert: { ...input, plugins: ['@example/expert-core'] } })
    expect(rejected.status()).toBe(400); expect(await rejected.json()).toMatchObject({ code: 'expert-plugin-core-modification' })
    await api('experts', { revision: library.revision, expert: input }); library = await api('experts')
    const second = library.experts.find((row: { id: string }) => row.id !== first.id)
    const grantPath = `groups/${account.groupId}/experts`, grant = await api(grantPath)
    await api(grantPath, { names: [first.id, second.id], revision: grant.revision, confirmed: true })
    const member = await browser.newPage({ locale: 'en' }); await signInCommunity(member, origin, 'member', 'password')
    const cookie = await cookieHeader(member.context(), origin), base = communityEntryUrl(origin, cookie), rpc = createRealDshRpc()
    const session = async (agentPreset: string) => (await rpc.remoteRpc<{ sessionId: string }>(origin, cookie, 'session/create', { request: { cwd: '/dsh-phalanx/workspace', agentPreset } })).sessionId
    const tool = async (sessionId: string, name = 'expert_fixture_remote') => { const r = await member.request.post(base + 'skills-fixture', { headers: { origin }, data: { operation: 'tool', sessionId, name, args: {} } }); expect(r.status(), await r.text()).toBe(200); const result = await r.json(); expect(JSON.stringify(result)).not.toContain(secret); return result }
    const check = async (global: boolean) => {
      let standardSession = ''
      const roster = await rpc.remoteRpc<{ presets: { id: string, broken?: string }[] }>(origin, cookie, 'agentPresets/list', {})
      for (const expert of [first, second]) {
        const mounted = roster.presets.find(row => row.id === 'phalanx-expert-' + expert.id)
        expect(mounted).toBeDefined(); expect(mounted?.broken).toBeUndefined()
      }
      for (const id of [preset, 'phalanx-expert-' + second.id, 'standard']) {
        const sessionId = await session(id), marker = randomUUID()
        if (id === 'standard') standardSession = sessionId
        await rpc.remoteRpc(origin, cookie, 'session/prompt', { request: { requestId: randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text: marker }] } })
        await expect.poll(() => captured.has(marker), { timeout: 30000 }).toBe(true)
        await expect.poll(async () => (await rpc.remoteRpc<{ items: { sessionId: string, running: boolean }[] }>(origin, cookie, 'session/list', { _request: {} })).items.find(row => row.sessionId === sessionId)?.running, { timeout: 30000 }).toBe(false)
        expect(captured.get(marker)!.filter(name => name === 'expert_fixture_remote')).toHaveLength(id === 'standard' && !global ? 0 : 1)
        expect(captured.get(marker)).toContain('bash')
        const mcpResult = await tool(sessionId, 'mcp__p-fixture__echo')
        if (id === preset) expect(JSON.stringify(mcpResult)).toContain('MCP_COMBINATION_READY')
        else expect(mcpResult.error.info.code).toBe('UNKNOWN_TOOL')
        const result = await tool(sessionId)
        if (id === 'standard' && !global) expect(result.error.info.code).toBe('UNKNOWN_TOOL')
        else expect(result.value).toMatchObject({ marker: 'PLATFORM_COPY', remote: { status: 'UPSTREAM_READY' }, label: 'configured', nested: { preserved: true, added: true } })
      }
      await expect.poll(async () => (await api('experts')).experts.flatMap((row: { checking?: readonly string[] }) => row.checking ?? []), { timeout: 30000 }).toEqual([])
      const failures = (await api('experts')).experts.find((row: { id: string }) => row.id === first.id).failures
      expect(failures).toEqual([{ username: 'member', entries: ['mcp:p-failed', 'plugin:@example/expert-async', 'plugin:@example/expert-dependent', 'plugin:@example/expert-import', 'plugin:@example/expert-sync'] }])
      expect((await member.request.get(origin + '/recovery')).status()).toBe(200)
      expect(received.length).toBeGreaterThan(0); expect(received.every(value => value === 'Bearer ' + secret)).toBe(true); expect(exposed).toBe(false)
      return standardSession
    }
    await check(false)
    const direct = `groups/${account.groupId}/plugins`
    await api(direct, { action: 'save', packages: [expertFixturePackage], preinstalls: [], revision: (await api(direct)).revision })
    const restart = async () => expect((await member.request.post(origin + '/recovery/restart', { headers: { origin }, data: { confirmed: true } })).status()).toBe(200)
    await restart(); const standard = await check(true)
    // Revoke platform sources before installing an independent native copy.
    let currentGrant = await api(grantPath)
    await api(grantPath, { names: [], revision: currentGrant.revision, confirmed: true })
    expect((await tool(standard)).value.remote.status).toBe('UPSTREAM_READY')
    await api(direct, { action: 'save', packages: [], preinstalls: [], revision: (await api(direct)).revision })
    const denied = await tool(standard)
    expect(denied.isError).toBe(true); expect(JSON.stringify(denied)).toContain('upstream denied 403')
    currentGrant = await api(grantPath)
    await api(grantPath, { names: [first.id, second.id], revision: currentGrant.revision, confirmed: true })
    await restart()
    const local = await packExpertPlugin(root, 'local'); await copyFile(local.archive, join(home, 'local.tgz'))
    const installRpc = createRealDshRpc('', (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(240000) }))
    expect(await installRpc.remoteRpc(origin, cookie, 'pluginManager/installBundle', { spec: '/dsh-phalanx/home/local.tgz' })).toMatchObject({ changed: true })
    await restart(); await check(true)
    expect(await readFile(join(home, '.dsh/profiles/web/cordis.patch.yml'), 'utf8')).toContain('phalanx-managed-yield')
    // Removing a referenced platform plugin leaves both experts usable and restores the independent native copy.
    const removal = await api('plugins/impact' + query)
    await api('plugins/change', { action: 'remove', packageName: expertFixturePackage, revision: removal.revision, confirmed: true })
    await admin.reload(); await admin.getByText('plugin:' + expertFixturePackage, { exact: true }).first().waitFor()
    const partial = (await api('experts')).experts
    for (const row of partial) expect(row.missing).toContain('plugin:' + expertFixturePackage)
    await restart()
    const survivingRoster = await rpc.remoteRpc<{ presets: { id: string, broken?: string }[] }>(origin, cookie, 'agentPresets/list', {})
    for (const expert of [first, second]) expect(survivingRoster.presets.find(row => row.id === 'phalanx-expert-' + expert.id)?.broken).toBeUndefined()
    const survivingSession = await session(preset), survivingMarker = randomUUID()
    await rpc.remoteRpc(origin, cookie, 'session/prompt', { request: { requestId: randomUUID(), sessionId: survivingSession, mode: 'queue', content: [{ type: 'text', text: survivingMarker }] } })
    await expect.poll(() => captured.has(survivingMarker), { timeout: 30000 }).toBe(true)
    expect(captured.get(survivingMarker)).toContain('bash')
    expect((await tool(survivingSession)).value).toMatchObject({ marker: 'LOCAL_COPY' })
    expect(JSON.stringify(await tool(survivingSession, 'mcp__p-fixture__echo'))).toContain('MCP_COMBINATION_READY')
    expect(exposed).toBe(false)

  } catch (error) { primaryFailure = error }
  finally {
    const attempt = async (action: () => Promise<unknown>) => { try { await action(); return true } catch (error) { cleanupErrors.push(error); return false } }
    await attempt(() => browser.close())
    const stopped = await attempt(() => app.stop()), rebuilt = await attempt(() => new CommunityRuntimeDriver(runtime).rebuild())
    for (const server of [model, upstream, mcp]) { server.closeAllConnections(); await attempt(() => new Promise<void>(resolve => server.close(() => resolve()))) }
    const writable = async (path: string): Promise<void> => { if ((await lstat(path)).isDirectory()) { await chmod(path, 0o700); for (const name of await readdir(path)) await writable(join(path, name)) } }
    if (stopped && rebuilt) await attempt(async () => { await writable(root); await rm(root, { recursive: true, force: true }) })
  }
  if (cleanupErrors.length) throw new AggregateError(primaryFailure ? [primaryFailure, ...cleanupErrors] : cleanupErrors, 'Expert plugin acceptance cleanup failed')
  if (primaryFailure) throw primaryFailure
}, 900000)
