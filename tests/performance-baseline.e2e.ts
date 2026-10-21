// Validation: T4 diagnostic spike; real credentials: none; manual rootless measurement, outside frozen T2 inventory.
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, readFile, writeFile, rm, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { chromium, type Browser, type Response as BrowserResponse } from 'playwright'
import { expect, it, vi } from 'vitest'
import { createCommunityApplication } from '../src/composition/community-application.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import * as runtimeCommand from '../src/adapters/runtime-command.js'
import * as runtimeProcess from '../src/adapters/runtime-process.js'
import * as profile from '../src/adapters/community-profile.js'
import * as platformPlugin from '../src/adapters/community-platform-plugin.js'
import * as managedPlugins from '../src/adapters/managed-plugins.js'
import * as skills from '../src/adapters/member-skills.js'
import * as coordination from '../src/adapters/plugin-coordination.js'
import * as plugins from '../src/adapters/managed-plugin-status.js'
import * as sessionModule from '../src/adapters/dsh-session.js'
import * as memberExperts from '../src/adapters/member-experts.js'
import { McpServices } from '../src/use-cases/mcp-services.js'
import { SkillLibrary } from '../src/use-cases/skill-library.js'
import { CommunityEnvironmentUpgrade } from '../src/use-cases/community-environment-upgrade.js'
import * as experts from '../src/adapters/expert-status.js'
import * as dshRpc from '../src/adapters/dsh-plugin-rpc.js'
import { FileCommunityUserSpaces } from '../src/adapters/community-user-spaces.js'
import { CommunityInstanceLifecycle } from '../src/use-cases/community-instance-lifecycle.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { assertPinnedDshRevision, runtimeSection } from './support/real-dsh-runtime.js'
import { measureResourceLimits } from './performance-resource-experiment.js'
import type { CommunityRuntimeConfig } from '../src/domain/community-config.js'
import type { CommunityModelGatewayAccess, CommunityUserInstance } from '../src/ports/community-runtime.js'

it.skipIf(!process.env.DSH_PHALANX_PERFORMANCE_OUTPUT)('records rootless performance and resource experiments without numerical gates', async () => {
  assertPinnedDshRevision(runtimeSettings)
  if (!runtimeSettings.containerImage || process.platform !== 'linux' || process.getuid?.() === 0) throw Error('A real rootless Linux image is required')
  const root = await mkdtemp(join(tmpdir(), 'performance-'))
  const output = process.env.DSH_PHALANX_PERFORMANCE_OUTPUT!
  const samples: { phase: string, name: string, ms: number }[] = []
  const commandFailures: { phase: string, operation: string, message: string }[] = []
  const results: Record<string, unknown> = { schema: 1, source: process.env.DSH_PHALANX_PERFORMANCE_SOURCE, dshImage: runtimeSettings.containerImage, samples, commandFailures }
  let phase = 'setup', instance: CommunityUserInstance | undefined, access: CommunityModelGatewayAccess | undefined
  const timed = async <T>(name: string, action: () => Promise<T>): Promise<T> => {
    const start = performance.now(), observedPhase = phase
    try { return await action() } finally { samples.push({ phase: observedPhase, name, ms: performance.now() - start }) }
  }
  let app: ReturnType<typeof createCommunityApplication> | undefined, browser: Browser | undefined
  let upstream: ReturnType<typeof createServer> | undefined
  let cleanupRuntime: CommunityRuntimeConfig | undefined
  let workloadError: unknown, cleanupErrors: unknown[] = []
  let passed = false
  try {
    // Observers call the original implementation; no production function is replaced with a fake.
    const observe = <A extends unknown[], R>(name: string, fn: (...args: A) => Promise<R>) => async (...args: A) => timed(name, () => fn(...args))
    const execute = runtimeCommand.execFileText
    vi.spyOn(runtimeCommand, 'execFileText').mockImplementation((command, args, options) => timed('container-' + (args[0] ?? 'unknown'), async () => {
      try { return await execute(command, args, options) }
      catch (error) {
        commandFailures.push({ phase, operation: args[0] ?? 'unknown', message: runtimeCommand.sanitize(String(error)) })
        throw error
      }
    }))
    const originalWaitForReady = runtimeProcess.waitForReady
    vi.spyOn(runtimeProcess, 'waitForReady').mockImplementation(observe('dsh-ready', originalWaitForReady))
    const originalPrepareCommunityProfile = profile.prepareCommunityProfile
    vi.spyOn(profile, 'prepareCommunityProfile').mockImplementation(observe('prepare-profile', originalPrepareCommunityProfile))
    const originalPrepareCommunityPlatformPlugin = platformPlugin.prepareCommunityPlatformPlugin
    vi.spyOn(platformPlugin, 'prepareCommunityPlatformPlugin').mockImplementation(observe('prepare-platform-plugin', originalPrepareCommunityPlatformPlugin))
    const originalPrepareManagedPlugins = managedPlugins.prepareManagedPlugins
    vi.spyOn(managedPlugins, 'prepareManagedPlugins').mockImplementation(observe('prepare-managed-plugins', originalPrepareManagedPlugins))
    const originalPrepareMemberSkills = skills.prepareMemberSkills
    vi.spyOn(skills, 'prepareMemberSkills').mockImplementation(observe('prepare-skills', originalPrepareMemberSkills))
    const originalPreparePluginCoordination = coordination.preparePluginCoordination
    vi.spyOn(coordination, 'preparePluginCoordination').mockImplementation(observe('prepare-coordination', originalPreparePluginCoordination))
    const originalManagedPluginFailures = plugins.managedPluginFailures
    vi.spyOn(plugins, 'managedPluginFailures').mockImplementation(observe('plugin-introspection', originalManagedPluginFailures))
    const originalPrepareMemberExperts = memberExperts.prepareMemberExperts
    vi.spyOn(memberExperts, 'prepareMemberExperts').mockImplementation(observe('prepare-experts', originalPrepareMemberExperts))
    const originalExpertPresetFailures = experts.expertPresetFailures
    vi.spyOn(experts, 'expertPresetFailures').mockImplementation(observe('expert-introspection', originalExpertPresetFailures))
    const originalDshPluginRequest = dshRpc.dshPluginRequest
    vi.spyOn(dshRpc, 'dshPluginRequest').mockImplementation(observe('introspection-http', originalDshPluginRequest))
    const Session = sessionModule.HttpDshSession
    vi.spyOn(sessionModule, 'HttpDshSession').mockImplementation(class extends Session {
      constructor() { super(); this.exchangeLaunchToken = observe('launch-token-exchange', this.exchangeLaunchToken) }
    })
    const mcpPrepare = McpServices.prototype.prepare, skillPrepare = SkillLibrary.prototype.prepare, upgradePrepare = CommunityEnvironmentUpgrade.prototype.prepare
    vi.spyOn(McpServices.prototype, 'prepare').mockImplementation(function (this: McpServices) { return timed('prepare-mcp', () => mcpPrepare.call(this)) })
    vi.spyOn(SkillLibrary.prototype, 'prepare').mockImplementation(function (this: SkillLibrary, ...args) { return timed('prepare-skill-projection', () => skillPrepare.apply(this, args)) })
    vi.spyOn(CommunityEnvironmentUpgrade.prototype, 'prepare').mockImplementation(function (this: CommunityEnvironmentUpgrade, ...args) { return timed('prepare-environment-upgrade', () => upgradePrepare.apply(this, args)) })
    const prepareSpaces = FileCommunityUserSpaces.prototype.prepare
    vi.spyOn(FileCommunityUserSpaces.prototype, 'prepare').mockImplementation(function (this: FileCommunityUserSpaces, ...args) { return timed('prepare-space', () => prepareSpaces.apply(this, args)) })
    const startDriver = CommunityRuntimeDriver.prototype.start
    vi.spyOn(CommunityRuntimeDriver.prototype, 'start').mockImplementation(async function (this: CommunityRuntimeDriver, ...args) {
      access = args[2]
      instance = await timed('driver-start', () => startDriver.apply(this, args))
      return instance
    })
    let lifecycle: CommunityInstanceLifecycle | undefined
    const ensure = CommunityInstanceLifecycle.prototype.ensure
    vi.spyOn(CommunityInstanceLifecycle.prototype, 'ensure').mockImplementation(function (this: CommunityInstanceLifecycle, ...args) {
      // eslint-disable-next-line @typescript-eslint/no-this-alias -- retain the real owner for a diagnostic reclaim
      lifecycle = this; return ensure.apply(this, args)
    })
    upstream = createServer(async (req, res) => {
      for await (const chunk of req) void chunk
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ id: 'fixture', type: 'message', role: 'assistant', model: 'deepseek-chat', content: [{ type: 'text', text: 'ready' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }))
    })
    await new Promise<void>(resolve => upstream!.listen(0, '127.0.0.1', resolve))
    const address = upstream.address(); if (!address || typeof address === 'string') throw Error('No fixture address')
    const upstreamOrigin = `http://127.0.0.1:${address.port}`
    const environment: Record<string, string> = { DSH_TELEMETRY_DISABLED: '1' }
    const limitsArgs: string[] = []
    const baseRuntime = runtimeSection(join(root, 'platform'), upstreamOrigin, runtimeSettings)
    if (!('container' in baseRuntime)) throw Error('Rootless runtime required')
    const runtime = { ...baseRuntime, container: { ...baseRuntime.container, extraArgs: limitsArgs }, environment }
    cleanupRuntime = runtime
    app = createCommunityApplication({ listen: { host: '127.0.0.1', port: 0 }, runtime, sessionSecret: 'performance-fixture-session-secret-32', idleReclaimSeconds: 0, modelGateway: { upstreamApiKey: 'fictional-model-key' } })
    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({ locale: 'en' }), page = await context.newPage()
    results.host = JSON.parse(await runtimeCommand.execFileText('podman', ['info', '--format', 'json'])) .host
    phase = 'cold-uid-mapping'
    await timed('first-keep-id', () => runtimeCommand.execFileText('podman', ['run', '--rm', '--userns=keep-id', '--entrypoint', 'true', runtimeSettings.containerImage!], { timeout: 600000 }))
    const origin = await app.start()
    const bootstrap = await fetch(origin + '/bootstrap', { method: 'POST', redirect: 'manual', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ credential: readBootstrapCredential(runtime.dataRoot)!.credential, username: 'admin', password: 'password' }) })
    expect(bootstrap.status).toBe(303)
    const admin = bootstrap.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    const created = await fetch(origin + '/admin/api/accounts', { method: 'POST', headers: { origin, cookie: admin, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'member', password: 'password', email: '' }) })
    expect(created.status).toBe(201)
    const memberAccount = await created.json() as { groupId: string }
    const login = async () => {
      await page.goto(origin + '/login')
      await page.getByLabel('Username', { exact: true }).fill('member')
      await page.getByLabel('Password', { exact: true }).fill('password')
      await timed('login-through-home', async () => {
        const submitted = page.waitForResponse(r => new URL(r.url()).pathname === '/login' && r.request().method() === 'POST', { timeout: 600000 })
        await page.getByRole('button', { name: 'Sign in', exact: true }).click({ noWaitAfter: true })
        const redirect = await submitted
        expect(redirect.status()).toBe(303)
        expect(redirect.headers().location, 'Login must enter the space; recovery is a failed measurement').toMatch(/^\/app\/[^/]+\/$/u)
        await page.waitForURL(/\/app\/[^/]+\/$/u, { timeout: 600000 })
        await page.locator('#root').waitFor({ state: 'attached', timeout: 600000 })
        await page.waitForLoadState('networkidle', { timeout: 120000 })
      })
    }
    phase = 'cold-login'; await login()
    expect(instance).toBeDefined(); expect(access).toBeDefined()
    // Empty managed inventories short-circuit in this baseline. Probe actual RPC separately.
    phase = 'inventory-probes'
    await timed('real-plugin-inventory', () => dshRpc.dshPluginRpc(instance!, new URL(origin), 'pluginManager/listPlugins', {}, AbortSignal.timeout(30000)))
    await timed('real-expert-inventory', () => dshRpc.dshPluginRpc(instance!, new URL(origin), 'agentPresets/list', {}, AbortSignal.timeout(30000)))
    phase = 'home'
    const requests: { status: number, kind: string }[] = []
    const recordResponse = (response: BrowserResponse) => { requests.push({ status: response.status(), kind: response.request().resourceType() }) }
    page.on('response', recordResponse)
    const homeStart = performance.now()
    await page.reload({ waitUntil: 'networkidle', timeout: 120000 })
    page.off('response', recordResponse)
    results.home = { requests: requests.length, ms: performance.now() - homeStart, responses: requests }
    phase = 'steady'
    for (let i = 0; i < 10; i++) await timed('podman-ps', () => runtimeCommand.execFileText('podman', ['ps', '--format', 'json']))
    const model: { directMs: number, gatewayMs: number, overheadMs: number }[] = []
    const body = JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'x'.repeat(16000) }], stream: false })
    for (let i = 0; i < 10; i++) {
      const directStart = performance.now()
      const direct = await fetch(upstreamOrigin + '/anthropic/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body }); await direct.text()
      const directMs = performance.now() - directStart, gatewayStart = performance.now()
      const response = await fetch(access!.url + '/v1/messages', { method: 'POST', headers: { 'x-api-key': access!.token, 'content-type': 'application/json' }, body })
      expect(response.status, await response.text()).toBe(200)
      const gatewayMs = performance.now() - gatewayStart
      model.push({ directMs, gatewayMs, overheadMs: gatewayMs - directMs })
    }
    results.model = { requestBytes: Buffer.byteLength(body), fixture: 'loopback nonstreaming upstream, 10 paired samples', samples: model }
    phase = 'reclaimed-entry'
    await context.clearCookies()
    expect(await lifecycle!.reclaim('member', async () => true)).toBe('reclaimed')
    await login()
    // Same durable member home, alternating controls and warmed cache to expose order bias.
    const cacheDirectory = '/dsh-phalanx/home/.cache/node-compile'
    for (const mode of ['disabled', 'first-cache', 'reuse-cache-attempt', 'disabled', 'reuse-cache-attempt', 'disabled', 'reuse-cache-attempt']) {
      phase = 'compile-' + mode
      await context.clearCookies()
      expect(await lifecycle!.reclaim('member', async () => true)).toBe('reclaimed')
      if (mode === 'disabled') { delete environment.NODE_COMPILE_CACHE; environment.NODE_DISABLE_COMPILE_CACHE = '1' }
      else { delete environment.NODE_DISABLE_COMPILE_CACHE; environment.NODE_COMPILE_CACHE = cacheDirectory }
      await login()
    }
    const cacheFacts = async (directory: string): Promise<{ files: number, bytes: number }> => {
      let files = 0, bytes = 0
      let entries
      try { entries = await readdir(directory, { withFileTypes: true }) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { files: 0, bytes: 0 }; throw error }
      for (const entry of entries) {
        const path = join(directory, entry.name)
        if (entry.isDirectory()) { const row = await cacheFacts(path); files += row.files; bytes += row.bytes }
        else { files++; bytes += (await stat(path)).size }
      }
      return { files, bytes }
    }
    // The durable key is platform-issued; obtain it from the owned carrier's mount facts.
    const mounts = JSON.parse(await runtimeCommand.execFileText('podman', ['inspect', instance!.containerName!]))[0].Mounts as { Destination: string, Source: string }[]
    const home = mounts.find(row => row.Destination === '/dsh-phalanx/home')!.Source
    results.compileCache = await cacheFacts(join(home, '.cache/node-compile'))
    // A startup-limited real DSH carrier exposes both kernel and platform symptoms.
    phase = 'dsh-oom'
    await context.clearCookies()
    expect(await lifecycle!.reclaim('member', async () => true)).toBe('reclaimed')
    const resourceEndpoint = origin + '/admin/api/instance-resources'
    const resourceHeaders = { origin, cookie: admin, 'content-type': 'application/json' }
    const settingsResponse = await fetch(resourceEndpoint, { headers: resourceHeaders })
    if (settingsResponse.status === 404) {
      expect(await settingsResponse.json()).toMatchObject({ code: 'not-found' })
      limitsArgs.push('--memory', '1536m')
      results.resourceConfiguration = 'legacy-container-args'
    } else {
      expect(settingsResponse.status).toBe(200)
      const settings = await settingsResponse.json() as { revision: number }
      expect(Number.isSafeInteger(settings.revision) && settings.revision >= 0).toBe(true)
      const saved = await fetch(resourceEndpoint, { method: 'POST', headers: resourceHeaders, body: JSON.stringify({ action: 'save-defaults', revision: settings.revision, limits: { cpus: null, memoryMiB: 1536, pids: null } }) })
      expect(saved.status, await saved.text()).toBe(200)
      results.resourceConfiguration = 'system-settings'
    }
    await login()
    const cgroup = async () => JSON.parse(await runtimeCommand.execFileText('podman', ['exec', instance!.containerName!, 'node', '-e', `const fs=require('fs');console.log(JSON.stringify(Object.fromEntries(['memory.max','memory.swap.max','memory.events'].map(n=>[n,fs.readFileSync('/sys/fs/cgroup/'+n,'utf8').trim()]))))`])) as Record<string, string>
    const beforeOom = await cgroup()
    expect(beforeOom['memory.max']).toBe(String(1536 * 1024 * 1024))
    let loadExit = 'completed'
    try { await runtimeCommand.execFileText('podman', ['exec', instance!.containerName!, 'node', '-e', 'const held=[];setInterval(()=>{held.push(Buffer.alloc(16*1024*1024,1))},20)'], { timeout: 30000 }) }
    catch (error) { loadExit = String(error) }
    const carrierState = JSON.parse(await runtimeCommand.execFileText('podman', ['inspect', instance!.containerName!]))[0].State
    const afterOom = carrierState.Running ? await cgroup() : undefined
    const kills = (value: string) => Number(/^oom_kill (\d+)$/mu.exec(value)?.[1] ?? 0)
    expect(carrierState.OOMKilled || !!afterOom && kills(afterOom['memory.events']!) > kills(beforeOom['memory.events']!)).toBe(true)
    const response = await page.request.get(page.url())
    results.dshOom = { before: beforeOom, after: afterOom, loadExit, carrierState, platformStatus: response.status(), platformFinalPath: new URL(response.url()).pathname }
    phase = 'limits'
    results.resources = await measureResourceLimits(runtimeSettings.containerImage!)
    phase = 'mcp'
    const post = (path: string, body: object) => fetch(origin + '/admin/api/' + path, { method: 'POST', headers: { cookie: admin, origin, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const service = { name: 'p-measurement', description: '', url: '', run: { location: 'shared', command: 'node', args: ['-e', `require('readline').createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l);if(m.id!==undefined){const result=m.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:m.method==='tools/list'?{tools:[{name:'ping',inputSchema:{type:'object'}}]}:{content:[{type:'text',text:'pong'}]};console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result}))}})`], env: [] } }
    expect((await post('mcp', { action: 'save', service })).status).toBe(200)
    expect((await post(`groups/${memberAccount.groupId}/mcp`, { names: [service.name] })).status).toBe(200)
    const call = async () => {
      const endpoint = new URL('/mcp/' + service.name, access!.url)
      const headers: Record<string, string> = { authorization: 'Bearer ' + access!.token, 'content-type': 'application/json' }
      const init = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'measurement', version: '1' } } }) })
      expect(init.status, await init.text()).toBe(200)
      const session = init.headers.get('mcp-session-id'); if (session) headers['mcp-session-id'] = session
      const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ping', arguments: {} } }) })
      expect(response.status).toBe(200); expect(await response.text()).toContain('pong')
    }
    await timed('shared-cold-call', call)
    await timed('shared-warm-call', call)
    const owner = createHash('sha256').update(runtime.dataRoot).digest('hex')
    const carriers = async () => (await runtimeCommand.execFileText('podman', ['ps', '--filter', `label=dsh-phalanx.mcp-shared=${owner}`, '--format', '{{.ID}}'])).trim().split(/\s+/u).filter(Boolean)
    const carrier = (await carriers())[0]!
    const carrierPid = JSON.parse(await runtimeCommand.execFileText('podman', ['inspect', carrier]))[0].State.Pid as number
    const unified = (await readFile(`/proc/${carrierPid}/cgroup`, 'utf8')).split('\n').find(line => line.startsWith('0::'))?.slice(3)
    if (!unified?.startsWith('/')) throw Error('No unified cgroup for shared MCP')
    const directory = '/sys/fs/cgroup' + unified
    // Read from the host; a Node exec probe would inflate the carrier's measured memory.
    const memory = { current: (await readFile(join(directory, 'memory.current'), 'utf8')).trim(), stat: await readFile(join(directory, 'memory.stat'), 'utf8') }
    results.sharedMcp = { memory, fixture: 'minimal Node stdio MCP through actual member gateway, includes platform bridge and initialize per call; not representative of every service' }
    await new Promise(resolve => setTimeout(resolve, 61000))
    results.sharedMcpRetainedAfter61Seconds = (await carriers()).length
    await timed('shared-after-61s-call', call)
    passed = true
  } catch (error) { workloadError = error } finally {
    const errors: unknown[] = []
    const actions = [
      async () => browser?.close(), async () => app?.stop(),
      async () => { if (cleanupRuntime) await new CommunityRuntimeDriver(cleanupRuntime).rebuild() },
      async () => { vi.restoreAllMocks() },
      async () => { if (upstream?.listening) await new Promise<void>((resolve, reject) => upstream!.close(error => error ? reject(error) : resolve())) },
      async () => {
        if (cleanupRuntime) {
          const owner = createHash('sha256').update(cleanupRuntime.dataRoot).digest('hex')
          const remaining = await runtimeCommand.execFileText('podman', ['ps', '-a', '--filter', `label=dsh-phalanx.community-root=${owner}`, '--format', '{{.ID}}'])
          if (remaining.trim()) throw Error('Owned carriers remain; preserving diagnostic data root ' + root)
        }
        await rm(root, { recursive: true, force: true })
      },
    ]
    for (const action of actions) { try { await action() } catch (error) { errors.push(error) } }
    results.passed = passed && errors.length === 0
    results.cleanup = { passed: errors.length === 0, errors: errors.map(String) }
    try { await writeFile(output, JSON.stringify(results, null, 2) + '\n', { mode: 0o600 }) } catch (error) { errors.push(error) }
    cleanupErrors = errors
  }
  if (cleanupErrors.length) throw new AggregateError([...(workloadError ? [workloadError] : []), ...cleanupErrors], 'Diagnostic workload or cleanup failed')
  if (workloadError) throw workloadError
}, 1200000)
