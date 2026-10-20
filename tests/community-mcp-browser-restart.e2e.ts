// Validation: T2; real credentials: none; actual Linux rootless DSH. Missing inputs must fail the T2 report gate.
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createHash, randomUUID } from 'node:crypto'
import { execFileText } from '../src/adapters/runtime-command.js'
import { mkdtemp, writeFile, rm, chmod, readdir, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { candidateApplication } from './support/candidate-application.js'
import { runtimeSection } from './support/real-dsh-runtime.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { createRealDshRpc } from './support/real-dsh-rpc.js'
import { latestHumanText, streamText, streamToolCall, hasToolResult } from './support/real-dsh-model.js'
import { playwrightSample } from './support/real-mcp-samples.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'

type BrowserResult = { waiting: boolean; failed: boolean }
type Dependency = { name: string; stage: string; current: { id: string } }

it('keeps a persistent member browser usable after dependency replacement and platform restart', async () => {
  const results = new Map<string, BrowserResult>()
  const requests: { marker: string; tools: string[]; toolResult: boolean }[] = []
  const diagnostics: unknown[] = []
  const model = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk
    const body = JSON.parse(text) as { tools?: { name: string }[] }
    const marker = latestHumanText(body), failed = hasToolResult(body, marker, true)
    requests.push({ marker, tools: (body.tools ?? []).map(tool => tool.name), toolResult: hasToolResult(body, marker, false) || failed })
    response.setHeader('content-type', 'text/event-stream')
    if (hasToolResult(body, marker, false) || failed) {
      results.set(marker, { waiting: false, failed }); streamText(response, 'DONE')
    } else if ((body.tools ?? []).some(tool => tool.name === 'mcp__p-browser__browser_navigate')) {
      streamToolCall(response, marker, 'mcp__p-browser__browser_navigate', { url: 'file:///dsh-phalanx/workspace/input.html' })
    } else { results.set(marker, { waiting: true, failed: false }); streamText(response, 'WAIT') }
  })
  model.listen(0, '127.0.0.1'); await once(model, 'listening')
  const modelOrigin = `http://127.0.0.1:${(model.address() as { port: number }).port}`
  const root = await mkdtemp(join(tmpdir(), 'browser-restart-'))
  const runtime = runtimeSection(root, modelOrigin, runtimeSettings)
  const config = { listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'browser-restart-fictional-session-secret', runtime, modelGateway: { upstreamApiKey: 'fictional-key' } }
  let app = candidateApplication(config, 120000), origin = '', cookie = ''
  const rpc = createRealDshRpc(), phases: string[] = []
  const api = async <T>(path: string, body?: unknown): Promise<T> => {
    const response = await fetch(origin + '/admin/api/' + path, { headers: { cookie, origin, 'content-type': 'application/json' }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) })
    expect(response.ok).toBe(true); return await response.json() as T
  }
  const cookies = (response: Response) => response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  const enter = async () => {
    const response = await fetch(origin + '/enter', { redirect: 'manual', headers: { cookie } })
    expect(response.status, await response.text()).toBe(303); cookie += '; ' + cookies(response)
  }
  const capture = async (phase: string, sessionId?: string) => {
    try {
      const sessions = await rpc.remoteRpcResult<{ items: { sessionId: string; projections?: { asOfSeq?: number } }[] }>(origin, cookie, 'session/list', { _request: {} })
      const throughSeq = sessions.ok ? sessions.value.items.find(row => row.sessionId === sessionId)?.projections?.asOfSeq : undefined
      const history = sessionId && throughSeq !== undefined ? await rpc.remoteRpcResult<{ records: { event: { type: string; seq: number; data: unknown } }[] }>(origin, cookie, 'session/page', {
        request: { address: { kind: 'session', sessionId }, throughSeq, maxMessages: 10 },
      }) : undefined
      const terminal = history?.ok ? history.value.records.map(row => row.event).filter(event => ['turn/end', 'step/start', 'step/end'].includes(event.type)) : history
      const dependencyRows = await api<{ name: string }[]>('runtime-dependencies')
      const dependencies = await Promise.all(dependencyRows.map(row => api<unknown>('runtime-dependencies?name=' + encodeURIComponent(row.name))))
      const mcp = (await api<{ name: string; preparation?: unknown }[]>('mcp')).map(row => ({ name: row.name, preparation: row.preparation }))
      const logs: string[] = [], values: string[] = []
      const owner = createHash('sha256').update(runtime.dataRoot).digest('hex')
      const carriers = (await execFileText(runtimeSettings.containerRuntimeCli, ['ps', '-a', '--filter', `label=dsh-phalanx.community-root=${owner}`, '--format', '{{.Names}}'])).trim().split('\n').filter(Boolean)
      for (const carrier of carriers) {
        const inspected = JSON.parse(await execFileText(runtimeSettings.containerRuntimeCli, ['inspect', carrier])) as { Config: { Env: string[] } }[]
        values.push(...inspected.flatMap(row => row.Config.Env.map(value => value.slice(value.indexOf('=') + 1))).filter(value => value.length >= 8))
        const output = spawnSync(runtimeSettings.containerRuntimeCli, ['logs', '--tail', '100', carrier], { encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024 })
        logs.push(String(output.stdout ?? '') + String(output.stderr ?? ''))
      }
      let record = JSON.stringify({ phase, sessionId, sessions, terminal, dependencies, mcp, logs }).replace(/([?&]token=)[^\s&"\\]+/gu, '$1<REDACTED>')
      for (const value of values.sort((left, right) => right.length - left.length)) record = record.split(JSON.stringify(value).slice(1, -1)).join('<REDACTED>')
      diagnostics.push(JSON.parse(record))
    } catch { diagnostics.push({ phase, diagnosticUnavailable: true }) }
  }
  const navigate = async (phase: string) => {
    const session = await rpc.remoteRpc<{ sessionId: string }>(origin, cookie, 'session/create', { request: { cwd: '/dsh-phalanx/workspace' } })
    const deadline = Date.now() + 30000
    let result: BrowserResult
    do {
      const marker = randomUUID()
      await rpc.remoteRpc(origin, cookie, 'session/prompt', { request: { requestId: randomUUID(), sessionId: session.sessionId, mode: 'queue', content: [{ type: 'text', text: marker }] } })
      try { await expect.poll(() => results.has(marker), { timeout: 30000 }).toBe(true) }
      catch (error) {
        await capture(phase, session.sessionId)
        throw error
      }
      result = results.get(marker)!
      await expect.poll(async () => (await rpc.remoteRpc<{ items: { sessionId: string; running: boolean }[] }>(origin, cookie, 'session/list', { _request: {} })).items.find(row => row.sessionId === session.sessionId)?.running, { timeout: 30000 }).toBe(false)
      if (!result.waiting) break
    } while (Date.now() < deadline)
    expect(result, phase).toEqual({ waiting: false, failed: false }); phases.push(phase)
  }
  try {
    origin = await app.start()
    const bootstrap = await fetch(origin + '/bootstrap', { method: 'POST', redirect: 'manual', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ credential: readBootstrapCredential(root)!.credential, username: 'admin', password: 'password' }) })
    expect(bootstrap.status).toBe(303); cookie = cookies(bootstrap)
    const settings = await api<{ revision: string }>('models')
    await api('models', { revision: settings.revision, action: 'save-provider', provider: { name: 'Fixture', baseUrl: modelOrigin + '/anthropic', apiFormat: 'anthropic-messages', apiKey: 'fictional-key', enabled: true, models: [{ name: 'fixture-model', enabled: true }] } })
    await enter(); await writeFile(join(root, 'users/admin/workspace/input.html'), '<h1>BROWSER_RESTART_OK</h1>')
    const downloadHost = process.env.DSH_PHALANX_PLAYWRIGHT_DOWNLOAD_HOST
    await api('mcp', { action: 'save', service: { ...playwrightSample, required: true, run: { ...playwrightSample.run!, env: [...playwrightSample.run!.env, ...(downloadHost ? [{ name: 'PLAYWRIGHT_DOWNLOAD_HOST', value: downloadHost }] : [])] } } })
    await expect.poll(async () => (await api<{ name: string; preparation?: { stage: string } }[]>('mcp')).find(row => row.name === 'p-browser')?.preparation?.stage, { timeout: 660000 }).toBe('ready')
    await navigate('prepared')
    const [dependency] = await api<Dependency[]>('runtime-dependencies'); expect(dependency).toBeDefined()
    await api('runtime-dependencies', { action: 'prepare', name: dependency!.name })
    try {
      await expect.poll(async () => { const row = await api<Dependency>('runtime-dependencies?name=' + dependency!.name); return row.stage === 'ready' && row.current.id !== dependency!.current.id }, { timeout: 660000 }).toBe(true)
    } catch (error) { await capture('reprepare'); throw error }
    await navigate('reprepared')
    await app.stop(); app = candidateApplication(config, 120000); origin = await app.start()
    const login = await fetch(origin + '/login', { method: 'POST', redirect: 'manual', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: 'admin', password: 'password' }) })
    expect(login.status).toBe(303); cookie = cookies(login); await enter()
    await navigate('restarted')
  } finally {
    const evidence = process.env.DSH_PHALANX_E2E_EVIDENCE_DIR
    if (evidence) await writeFile(join(evidence, 'browser-restart.json'), JSON.stringify({ phases, requests, diagnostics }, null, 2))
    await app.stop(); await new CommunityRuntimeDriver(runtime).rebuild()
    model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve()))
    const writable = async (path: string): Promise<void> => { if ((await lstat(path)).isDirectory()) { await chmod(path, 0o700); for (const name of await readdir(path)) await writable(join(path, name)) } }
    await writable(root); await rm(root, { recursive: true, force: true })
  }
}, 1500000)
