// Validation: T4 only; real credentials: required (provider keys or deployed account). Never selected by T2.
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { candidateApplication } from './support/candidate-application.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { ContainerExecutionProcess } from '../src/adapters/execution-container-process.js'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import { FileExecutionPreparations } from '../src/adapters/execution-preparation-store.js'
import { FileMcpStore } from '../src/adapters/mcp-store.js'
import { MemberMcpPreparer } from './fixtures/legacy-mcp/member-preparer.js'
import { SharedMcpPreparer } from './fixtures/legacy-mcp/shared-preparer.js'
import { memberMcpExecution, sharedMcpExecution } from './fixtures/legacy-mcp/execution.js'
import { mcpPresets } from '../src/domain/mcp-catalog.js'
import type { McpService } from '../src/domain/mcp-service.js'
import { bochaSample } from './support/real-mcp-samples.js'
import { readPrivateMcpCredential } from './support/real-mcp-credentials.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { assertPinnedDshRevision, runtimeSection } from './support/real-dsh-runtime.js'
import { createRealDshRpc } from './support/real-dsh-rpc.js'
import { latestHumanText, streamText, streamToolCall, hasToolResult } from './support/real-dsh-model.js'
import { downloadSourceEnvironment, resolveDownloadSources } from '../src/domain/download-source.js'
import { validationDownloadSelection } from './support/validation-downloads.js'

it.skipIf(!runtimeSettings.containerImage || !process.env.DSH_PHALANX_BOCHA_API_KEY_FILE)('migrates persisted 12306 member and Bocha shared services and rotates only running Bocha credentials', async () => {
  assertPinnedDshRevision(runtimeSettings)
  const key = await readPrivateMcpCredential(process.env.DSH_PHALANX_BOCHA_API_KEY_FILE!)
  const results: Record<string, { valid: boolean, error: boolean }> = {}, diagnostics: Record<string, string> = {}
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + 86400000))
  const model = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk
    const body = JSON.parse(text), marker = latestHumanText(body)
    response.setHeader('content-type', 'text/event-stream')
    if (hasToolResult(body, marker, false) || hasToolResult(body, marker, true)) {
      const content = JSON.stringify((body.messages ?? []).flatMap((row: { content?: unknown }) => Array.isArray(row.content) ? row.content : []).filter((row: { type?: string, tool_use_id?: string }) => row.type === 'tool_result' && row.tool_use_id === marker))
      results[marker] = { valid: marker.startsWith('TRAIN') ? /[GC]\d{2,5}/u.test(content) && content.includes(date) : content.includes('Title:') && content.includes('URL:'), error: hasToolResult(body, marker, true) }
      if (content.includes(key)) throw Error('Credential exposed in sample result')
      diagnostics[marker] = content.replaceAll(key, '[redacted]').replaceAll(encodeURIComponent(key), '[redacted]').replace(/Bearer [A-Za-z0-9_-]+/gu, 'Bearer [redacted]').slice(0, 1500)
      streamText(response, 'MIGRATION_DONE')
    } else if (marker.startsWith('TRAIN')) streamToolCall(response, marker, 'mcp__p-train__get-tickets', { date, fromStation: '北京南', toStation: '天津', trainFilterFlags: 'G', limitedNum: 2, format: 'json' })
    else streamToolCall(response, marker, 'mcp__p-bocha__bocha_web_search', { query: 'Python official documentation', count: 1 })
  })
  model.listen(0, '127.0.0.1'); await once(model, 'listening')
  const modelOrigin = `http://127.0.0.1:${(model.address() as { port: number }).port}`
  const root = await mkdtemp(join(tmpdir(), 'mcp-dependency-migration-')), base = runtimeSection(root, modelOrigin, runtimeSettings)
  if (!('container' in base)) throw Error('Container acceptance required')
  const pythonInput = process.env.DSH_PHALANX_PYTHON312_ARCHIVE
  if (!pythonInput) throw Error('Verified Python archive is required for the existing Bocha migration exception')
  expect(createHash('sha256').update(await readFile(pythonInput)).digest('hex')).toBe('c74addcd1b033a6e4d60ead3ab47fcc995569027e01d3061c4a934f363c4a0cf')
  const wrapper = join(root, 'podman-verified-input')
  await writeFile(wrapper, `#!/usr/bin/python3\nimport os,sys\nargs=sys.argv[1:]\nif args[0]=='run' and any(v.startswith('dsh-phalanx.execution=') for v in args): args[1:1]=['--volume',${JSON.stringify(pythonInput + ':/acceptance-python.tgz:ro')}]\nos.execvp('podman',['podman',*args])\n`, { mode: 0o700 })
  const runtime = { ...base, container: { ...base.container, runtime: wrapper } }, execution = new ContainerExecutionProcess(runtime)
  const member = new MemberMcpPreparer(runtime, execution), shared = new SharedMcpPreparer(runtime, execution)
  const bochaPrepare = bochaSample.run!.prepareCommand!
    .replace('UV_PYTHON_INSTALL_DIR=', `mkdir python-runtime && cp /acceptance-python.tgz python.tgz && echo 'c74addcd1b033a6e4d60ead3ab47fcc995569027e01d3061c4a934f363c4a0cf  python.tgz' | sha256sum -c - && tar xzf python.tgz -C python-runtime && rm python.tgz && UV_PYTHON_INSTALL_DIR=`)
    .replace('--python 3.12.12', '--python "$PWD/python-runtime/python/bin/python3.12"')
  const trainPreset = mcpPresets.find(row => row.entry.id === '12306')!
  const services: McpService[] = [
    { ...trainPreset.configuration, name: 'p-train', generation: 1, required: true, catalog: { id: '12306', version: trainPreset.entry.version, status: 'ready' }, run: { ...trainPreset.configuration.run!, location: 'member' } },
    { ...bochaSample, generation: 2, required: true, credential: key, run: { ...bochaSample.run!, prepareCommand: bochaPrepare } },
  ]
  let app: ReturnType<typeof candidateApplication> | undefined
  try {
    await member.recover(); await shared.recover()
    const downloadVariables = Object.entries(downloadSourceEnvironment(resolveDownloadSources(validationDownloadSelection()), process.arch))
      .map(([name, value]) => ({ name, value, secret: false }))
    for (const service of services) {
      const memberRun = service.run!.location === 'member', input = (memberRun ? memberMcpExecution : sharedMcpExecution)(service)!
      const configuration = { ...input.configuration, variables: [...downloadVariables.filter(row => !input.configuration.variables.some(existing => existing.name === row.name)), ...input.configuration.variables] }
      const artifact = await (memberRun ? member : shared).prepare(input.owner, configuration, new AbortController().signal)
      new FileExecutionPreparations(join(root, 'mcp', memberRun ? 'preparations.json' : 'shared-preparations.json')).save(input.owner.id, { identity: input.owner.version, stage: 'ready', updatedAt: Date.now(), log: artifact.log, artifact })
    }
    new FileMcpStore(join(root, 'mcp/library.json')).write({ services, grants: {}, revision: 2 })
    app = candidateApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'mcp-migration-fixture-session-secret-32', runtime, modelGateway: { upstreamApiKey: 'fictional-model-key' } })
    let origin = await app.start()
    const bootstrap = await fetch(origin + '/bootstrap', { method: 'POST', redirect: 'manual', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ credential: readBootstrapCredential(root)!.credential, username: 'admin', password: 'password' }) })
    const cookie = bootstrap.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    const api = async (path: string, body?: unknown) => {
      const response = await fetch(origin + '/admin/api/' + path, { headers: { cookie, origin, 'content-type': 'application/json' }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) })
      if (!response.ok) throw Error(`Sample API ${path}: ${response.status}`)
      return response.json()
    }
    const models = await api('models')
    await api('models', { revision: models.revision, action: 'save-provider', provider: { name: 'Fixture', baseUrl: modelOrigin + '/anthropic', apiFormat: 'anthropic-messages', apiKey: 'fictional-model-key', enabled: true, models: [{ name: 'fixture-model', enabled: true }] } })
    await expect.poll(async () => (await api('runtime-dependencies')).filter((row: { stage: string }) => row.stage === 'ready').length, { timeout: 600000 }).toBe(2)
    const dependencies = await api('runtime-dependencies')
    expect(dependencies.map((row: { source: string }) => row.source).sort()).toEqual(['manual', 'mcp-catalog'])
    expect(JSON.stringify(dependencies).includes(key)).toBe(false)
    expect((await api('mcp')).every((row: McpService) => row.run?.prepareCommand === undefined)).toBe(true)
    for (const service of services) expect((await api('mcp/test', { name: service.name })).testStatus).toBe('passed')
    const entered = await fetch(origin + '/enter', { redirect: 'manual', headers: { cookie } })
    expect(entered.status).toBe(303)
    const memberCookie = [cookie, ...entered.headers.getSetCookie().map(value => value.split(';')[0])].join('; ')
    const rpc = createRealDshRpc(), session = await rpc.remoteRpc<{ sessionId: string }>(origin, memberCookie, 'session/create', { request: { cwd: '/dsh-phalanx/workspace' } })
    const call = async (marker: string) => {
      await rpc.remoteRpc(origin, memberCookie, 'session/prompt', { request: { requestId: randomUUID(), sessionId: session.sessionId, mode: 'queue', content: [{ type: 'text', text: marker }] } })
      await expect.poll(() => Boolean(results[marker]), { timeout: 90000 }).toBe(true)
      await expect.poll(async () => (await rpc.remoteRpc<{ items: { sessionId: string, running: boolean }[] }>(origin, memberCookie, 'session/list', { _request: {} })).items.find(row => row.sessionId === session.sessionId)?.running, { timeout: 30000 }).toBe(false)
      return results[marker]!
    }
    expect(await call('TRAIN_MIGRATED'), diagnostics.TRAIN_MIGRATED).toEqual({ valid: true, error: false })
    expect(await call('BOCHA_MIGRATED'), diagnostics.BOCHA_MIGRATED).toEqual({ valid: true, error: false })
    const bocha = (await api('mcp')).find((row: McpService) => row.name === 'p-bocha')
    await api('mcp', { action: 'save', service: { ...bocha, credential: 'invalid-rotation-fixture' } })
    expect((await call('BOCHA_INVALID')).valid).toBe(false)
    expect(diagnostics.BOCHA_INVALID).not.toContain('unknown tool')
    await api('mcp', { action: 'save', service: { ...bocha, credential: key } })
    expect(await call('BOCHA_RESTORED'), diagnostics.BOCHA_RESTORED).toEqual({ valid: true, error: false })
    expect((await api('runtime-dependencies')).map((row: { current: { id: string } }) => row.current.id)).toEqual(dependencies.map((row: { current: { id: string } }) => row.current.id))
    await app.stop()
    app = candidateApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'mcp-migration-fixture-session-secret-32', runtime, modelGateway: { upstreamApiKey: 'fictional-model-key' } })
    origin = await app.start()
    expect((await api('runtime-dependencies')).map((row: { current: { id: string } }) => row.current.id)).toEqual(dependencies.map((row: { current: { id: string } }) => row.current.id))
    for (const service of services) expect((await api('mcp/test', { name: service.name })).testStatus).toBe('passed')
  } finally {
    await app?.stop(); await new CommunityRuntimeDriver(runtime).rebuild(); await execution.stop()
    model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve()))
    const writable = async (path: string): Promise<void> => { if ((await lstat(path)).isDirectory()) { await chmod(path, 0o700); for (const name of await readdir(path)) await writable(join(path, name)) } }
    await writable(root); await rm(root, { recursive: true, force: true })
  }
}, 900000)
