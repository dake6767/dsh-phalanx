// Validation: T2; real credentials: none; actual Linux rootless DSH. Missing inputs must fail the T2 report gate.
import { openCommunityHttpEntry } from './support/community-http-entry.js'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { candidateApplication } from './support/candidate-application.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { runtimeSection } from './support/real-dsh-runtime.js'
import { createRealDshRpc } from './support/real-dsh-rpc.js'
import { latestHumanText, streamText, streamToolCall, hasToolResult } from './support/real-dsh-model.js'

it('keeps native MCP tools callable on the first turn after each credential rotation', async () => {
  const results: Record<string, { failed: boolean, tools: string[], text: string }> = {}
  const model = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk
    const body = JSON.parse(text), marker = latestHumanText(body)
    response.setHeader('content-type', 'text/event-stream')
    if (hasToolResult(body, marker, false) || hasToolResult(body, marker, true)) {
      results[marker] = { failed: hasToolResult(body, marker, true), tools: (body.tools ?? []).map((row: { name: string }) => row.name), text }
      streamText(response, 'DONE')
    } else streamToolCall(response, marker, 'mcp__p-rotation__search', {})
  })
  model.listen(0, '127.0.0.1'); await once(model, 'listening')
  const modelOrigin = `http://127.0.0.1:${(model.address() as { port: number }).port}`
  const root = await mkdtemp(join(tmpdir(), 'mcp-refresh-')), runtime = runtimeSection(root, modelOrigin, runtimeSettings)
  const app = candidateApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'mcp-rotation-fixture-session-secret', runtime, modelGateway: { upstreamApiKey: 'fictional-model-key' } })
  const script = `import {createInterface} from 'node:readline';for await(const line of createInterface({input:process.stdin})){const m=JSON.parse(line);if(m.id===undefined)continue;const result=m.method==='initialize'?{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:m.method==='tools/list'?{tools:[{name:'search',inputSchema:{type:'object'}}]}:{content:[{type:'text',text:'rotation-'+process.env.API_KEY.slice(-1)}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n')}`
  try {
    const origin = await app.start()
    const bootstrap = await fetch(origin + '/bootstrap', { method: 'POST', redirect: 'manual', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ credential: readBootstrapCredential(root)!.credential, username: 'admin', password: 'password' }) })
    const cookie = bootstrap.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    const api = async (path: string, body?: unknown) => {
      const response = await fetch(origin + '/admin/api/' + path, { headers: { cookie, origin, 'content-type': 'application/json' }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) })
      expect(response.ok).toBe(true); return response.json()
    }
    const models = await api('models')
    await api('models', { revision: models.revision, action: 'save-provider', provider: { name: 'Fixture', baseUrl: modelOrigin + '/anthropic', apiFormat: 'anthropic-messages', apiKey: 'fictional-model-key', enabled: true, models: [{ name: 'fixture-model', enabled: true }] } })
    const service = { name: 'p-rotation', description: '', url: '', required: true, credential: 'fictional-key-0', run: { location: 'shared', command: 'node', args: ['--input-type=module', '-e', script], env: [{ name: 'API_KEY', value: '{credential}' }], runtimeDependencies: [] } }
    await api('mcp', { action: 'save', service: { ...service, name: 'p-unchanged' } })
    await api('mcp', { action: 'save', service })
    expect((await api('mcp/test', { name: service.name })).testStatus).toBe('passed')
    const entered = await fetch(origin + '/enter', { redirect: 'manual', headers: { cookie } })
    expect(entered.status).toBe(303)
    const memberCookie = (await openCommunityHttpEntry(origin, cookie, 300_000)).cookie
    const rpc = createRealDshRpc(), session = await rpc.remoteRpc<{ sessionId: string }>(origin, memberCookie, 'session/create', { request: { cwd: runtimeSettings.containerImage ? '/dsh-phalanx/workspace' : root } })
    for (let index = 0; index < 5; index++) {
      if (index) await api('mcp', { action: 'save', service: { ...service, credential: 'fictional-key-' + index } })
      const marker = 'CALL_' + index
      await rpc.remoteRpc(origin, memberCookie, 'session/prompt', { request: { requestId: randomUUID(), sessionId: session.sessionId, mode: 'queue', content: [{ type: 'text', text: marker }] } })
      await expect.poll(() => Boolean(results[marker]), { timeout: 30000 }).toBe(true)
      await expect.poll(async () => (await rpc.remoteRpc<{ items: { sessionId: string, running: boolean }[] }>(origin, memberCookie, 'session/list', { _request: {} })).items.find(row => row.sessionId === session.sessionId)?.running, { timeout: 30000 }).toBe(false)
      expect(results[marker]!.failed, JSON.stringify({marker, tools: results[marker]!.tools.filter(name => name.startsWith('mcp__')), error: results[marker]!.text.match(/unknown tool.{0,80}/u)?.[0]})).toBe(false)
      expect(results[marker]!.text).toContain('rotation-' + index)
    }
  } finally {
    await app.stop(); await new CommunityRuntimeDriver(runtime).rebuild()
    model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
}, 120000)
