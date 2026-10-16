// Validation: T4 integration; real credentials: none; exact historical amd64 artifacts required. Not part of the approved T2 batch.
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
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
import { latestHumanText, streamText, streamToolCall, hasToolResult } from './support/real-dsh-model.js'
import type { McpState } from '../src/domain/mcp-service.js'
import type { RuntimeDependency } from '../src/domain/runtime-dependency.js'

const oldImage = process.env.DSH_PHALANX_019_CONTAINER_IMAGE
it.skipIf(!oldImage || !runtimeSettings.containerImage)('regenerates persisted MCP entries after a DSH image upgrade and loads both run locations in real DSH', async () => {
  assertPinnedDshRevision(runtimeSettings)
  expect((await execFileText('podman', ['image', 'inspect', oldImage!, '--format', '{{index .Config.Labels "dsh.revision"}}'])).trim()).toBe('5badb15009ae1756c3afe0ae0cef1faafc290ccc')
  const results: string[] = []
  const model = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk
    const body = JSON.parse(text), marker = latestHumanText(body), id = marker.toLowerCase()
    response.setHeader('content-type', 'text/event-stream')
    if (hasToolResult(body, id, false)) { if (text.includes('REVISION_READY')) results.push(marker); streamText(response, 'DONE') }
    else if (hasToolResult(body, id, true)) streamText(response, 'FAILED')
    else streamToolCall(response, id, `mcp__p-${marker}__echo`, {})
  })
  model.listen(0, '127.0.0.1'); await once(model, 'listening')
  const modelOrigin = `http://127.0.0.1:${(model.address() as { port: number }).port}`
  const root = await mkdtemp(join(tmpdir(), 'mcp-image-upgrade-')), runtime = runtimeSection(root, modelOrigin, runtimeSettings)
  if (!('container' in runtime)) throw Error('Container acceptance required')
  const config = { listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'image-upgrade-fixture-session-secret', runtime }
  let app = candidateApplication({ ...config, runtime: { ...runtime, container: { ...runtime.container, image: oldImage! } } }), origin = '', admin = '', passed = false
  const cookie = (response: Response) => response.headers.getSetCookie().map(row => row.split(';')[0]).join('; ')
  const post = (path: string, body: object) => fetch(origin + '/admin/api/' + path, { method: 'POST', headers: { cookie: admin, origin, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const get = async (path: string) => await (await fetch(origin + '/admin/api/' + path, { headers: { cookie: admin } })).json()
  const prepared = async () => { await expect.poll(async () => (await get('mcp')).filter((row: { preparation?: { stage: string } }) => row.preparation?.stage === 'ready').length, { timeout: 120000 }).toBe(2) }
  try {
    origin = await app.start()
    const bootstrap = await fetch(origin + '/bootstrap', { method: 'POST', redirect: 'manual', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ credential: readBootstrapCredential(root)!.credential, username: 'admin', password: 'password' }) })
    expect(bootstrap.status).toBe(303); admin = cookie(bootstrap)
    const created = await post('accounts', { username: 'member', password: 'password', email: '' }); expect(created.status).toBe(201)
    const account = await created.json() as { spaceId: string, groupId: string }
    const fixture = "require('readline').createInterface({input:process.stdin}).on('line',s=>{const b=JSON.parse(s);if(b.id===undefined)return;const result=b.method==='initialize'?{protocolVersion:b.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'revision',version:'1'}}:b.method==='tools/list'?{tools:[{name:'echo',inputSchema:{type:'object'}}]}:{content:[{type:'text',text:'REVISION_READY'}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:b.id,result})+'\\n')})"
    for (const location of ['member', 'shared']) {
      const prepareCommand = `node -e 'require("fs").writeFileSync("server.cjs",Buffer.from("${Buffer.from(fixture).toString('base64')}","base64"))'`
      expect((await post('mcp', { action: 'save', service: { name: 'p-' + location, description: '', url: '', run: { location, command: 'node', args: ['{dependencies}/server.cjs'], env: [], prepareCommand } } })).status).toBe(200)
    }
    await prepared(); expect((await post(`groups/${account.groupId}/mcp`, { names: ['p-member', 'p-shared'] })).status).toBe(200)
    const entriesPath = join(root, 'mcp/members', account.spaceId, 'entries.json')
    const beforeEntries = await readFile(entriesPath, 'utf8'), beforeState = await readFile(join(root, 'mcp/library.json'), 'utf8')
    const versions = async () => {
      const library = JSON.parse(await readFile(join(root, 'mcp/library.json'), 'utf8')) as McpState
      const state = JSON.parse(await readFile(join(root, 'runtime-dependencies/library.json'), 'utf8')) as { dependencies: RuntimeDependency[] }
      return ['p-member', 'p-shared'].map(name => {
        const service = library.services.find(row => row.name === name)!
        const dependency = state.dependencies.find(row => row.name === service.dependencyName)!
        expect(dependency.stage).toBe('ready'); expect(dependency.current).toBeDefined()
        return dependency.current!
      })
    }
    const beforeVersions = await versions()
    await app.stop(); app = candidateApplication(config); origin = await app.start()
    await prepared()
    const afterVersions = await versions()
    for (let index = 0; index < 2; index++) expect(afterVersions[index]!.identity).not.toBe(beforeVersions[index]!.identity)
    expect(await readFile(join(root, 'mcp/library.json'), 'utf8')).toBe(beforeState)
    await expect.poll(async () => {
      const entries = await readFile(entriesPath, 'utf8')
      return entries !== beforeEntries && entries.includes('p-member') && entries.includes('p-shared') && entries.includes(afterVersions[0]!.id)
    }, { timeout: 15000 }).toBe(true)
    expect((await post('models', { revision: (await get('models')).revision, action: 'save-provider', provider: { name: 'Fixture', baseUrl: modelOrigin + '/anthropic', apiFormat: 'anthropic-messages', apiKey: 'fictional-model-key', enabled: true, models: [{ name: 'fixture-model', enabled: true }] } })).status).toBe(200)
    const login = await fetch(origin + '/login', { method: 'POST', redirect: 'manual', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: 'member', password: 'password' }) })
    expect(login.status).toBe(303); const member = cookie(login), rpc = createRealDshRpc()
    for (const marker of ['member', 'shared']) {
      const session = await rpc.remoteRpc<{ sessionId: string }>(origin, member, 'session/create', { request: { cwd: '/dsh-phalanx/workspace' } })
      await rpc.remoteRpc(origin, member, 'session/prompt', { request: { requestId: randomUUID(), sessionId: session.sessionId, mode: 'queue', content: [{ type: 'text', text: marker }] } })
      await expect.poll(() => results.includes(marker), { timeout: 60000 }).toBe(true)
    }
    passed = true
  } finally {
    await app.stop(); await new CommunityRuntimeDriver(runtime).rebuild()
    model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve()))
    const writable = async (path: string): Promise<void> => { if ((await lstat(path)).isDirectory()) { await chmod(path, 0o700); for (const name of await readdir(path)) await writable(join(path, name)) } }
    await writable(root); await rm(root, { recursive: true, force: true })
    if (process.env.DSH_PHALANX_E2E_EVIDENCE_DIR) await writeFile(join(process.env.DSH_PHALANX_E2E_EVIDENCE_DIR, 'mcp-image-upgrade-result.json'), JSON.stringify({ passed, results }) + '\n')
  }
}, 300000)
