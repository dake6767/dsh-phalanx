import { createServer } from 'node:http'
import { once } from 'node:events'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
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
import { streamText, streamToolCall, hasToolResult } from './support/real-dsh-model.js'
import type { CommunityMcpSettings } from '../src/domain/admin-contract.js'

const keyFile = process.env.DSH_PHALANX_GITHUB_MCP_PAT_FILE

it.skipIf(!keyFile || !runtimeSettings.containerImage)('calls real GitHub MCP with a private PAT and blocks disabled write tools through the installed member gateway', async () => {
  assertPinnedDshRevision(runtimeSettings)
  const info = await stat(keyFile!)
  if (!info.isFile() || (info.mode & 0o077)) throw Error('The GitHub MCP PAT must be in a private regular file')
  const secret = (await readFile(keyFile!, 'utf8')).trim()
  if (!secret || /\s/u.test(secret)) throw Error('The GitHub MCP PAT file must contain one token')
  let called = false, exposed = false, tools: string[] = [], passed = false
  const model = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk
    exposed ||= text.includes(secret)
    const body = JSON.parse(text)
    tools = (body.tools ?? []).map((row: { name: string }) => row.name).filter((name: string) => name.startsWith('mcp__p-github__'))
    response.setHeader('content-type', 'text/event-stream')
    if (hasToolResult(body, 'github-read', false)) { called = true; streamText(response, 'GITHUB_READ_DONE') }
    else if (hasToolResult(body, 'github-read', true)) streamText(response, 'GITHUB_READ_FAILED')
    else streamToolCall(response, 'github-read', 'mcp__p-github__get_me', {})
  })
  model.listen(0, '127.0.0.1'); await once(model, 'listening')
  const modelOrigin = `http://127.0.0.1:${(model.address() as { port: number }).port}`
  const root = await mkdtemp(join(tmpdir(), 'real-github-mcp-'))
  const runtime = runtimeSection(root, modelOrigin, runtimeSettings)
  const app = candidateApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'real-github-fixture-session-secret', runtime })
  const rpc = createRealDshRpc()
  const cookie = (response: Response) => response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  let count = 0, blocked = ''
  try {
    const origin = await app.start()
    const bootstrap = await fetch(origin + '/bootstrap', { method: 'POST', redirect: 'manual', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ credential: readBootstrapCredential(root)!.credential, username: 'admin', password: 'password' }) })
    expect(bootstrap.status).toBe(303); const admin = cookie(bootstrap)
    // Do not include request bodies, response bodies or credential values in assertion diagnostics.
    const post = (path: string, body: object) => fetch(origin + '/admin/api/' + path, { method: 'POST', headers: { cookie: admin, origin, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const settings = await (await fetch(origin + '/admin/api/models', { headers: { cookie: admin } })).json()
    expect((await post('models', { revision: settings.revision, action: 'save-provider', provider: { name: 'Fixture', baseUrl: modelOrigin + '/anthropic', apiFormat: 'anthropic-messages', apiKey: 'fictional-model-key', enabled: true, models: [{ name: 'fixture-model', enabled: true }] } })).status).toBe(200)
    const created = await post('accounts', { username: 'member', password: 'password', email: '' }); expect(created.status).toBe(201)
    const account = await created.json() as { spaceId: string, groupId: string }
    const service = { name: 'p-github', description: 'Real remote PAT acceptance', url: 'https://api.githubcopilot.com/mcp/', headers: [{ name: 'Authorization', value: 'Bearer {credential}' }] }
    expect((await post('mcp', { action: 'save', service: { ...service, credential: secret } })).status).toBe(200)
    const tested = await post('mcp/test', { name: service.name }); expect(tested.status).toBe(200)
    const discovered = await tested.json() as CommunityMcpSettings
    expect(discovered.testStatus).toBe('passed'); count = discovered.tools.length
    expect(discovered.tools.some(tool => tool.name === 'get_me')).toBe(true)
    blocked = discovered.tools.find(tool => /^(issue_write|create_issue|create_or_update_file|push_files|create_pull_request)$/u.test(tool.name))?.name ?? ''
    expect(Boolean(blocked)).toBe(true)
    expect(JSON.stringify(discovered).includes(secret)).toBe(false)
    expect((await post('mcp', { action: 'save', service: { ...service, disabledTools: discovered.tools.filter(tool => tool.name !== 'get_me').map(tool => tool.name) } })).status).toBe(200)
    expect((await post(`groups/${account.groupId}/mcp`, { names: [service.name] })).status).toBe(200)
    const login = await fetch(origin + '/login', { method: 'POST', redirect: 'manual', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: 'member', password: 'password' }) })
    expect(login.status).toBe(303); const member = cookie(login)
    const session = await rpc.remoteRpc<{ sessionId: string }>(origin, member, 'session/create', { request: { cwd: '/dsh-phalanx/workspace' } })
    await rpc.remoteRpc(origin, member, 'session/prompt', { request: { requestId: randomUUID(), sessionId: session.sessionId, mode: 'queue', content: [{ type: 'text', text: 'CALL_GITHUB_READ' }] } })
    await expect.poll(() => called, { timeout: 90000 }).toBe(true)
    expect(tools).toEqual(['mcp__p-github__get_me']); expect(exposed).toBe(false)
    const owner = createHash('sha256').update(root).digest('hex')
    const carrier = (await execFileText('podman', ['ps', '--filter', `label=dsh-phalanx.community-root=${owner}`, '--format', '{{.Names}}'])).trim()
    expect(Boolean(carrier) && !carrier.includes('\n')).toBe(true)
    const exec = (code: string) => execFileText('podman', ['exec', carrier, 'node', '-e', code]).catch(() => { throw Error('Member inspection command failed; output suppressed') })
    const direct = await exec(`fetch(new URL('/mcp/p-github',process.env.DSH_PHALANX_MODEL_GATEWAY_URL),{method:'POST',headers:{authorization:'Bearer '+process.env.DSH_PHALANX_MODEL_GATEWAY_ACCESS_TOKEN,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:77,method:'tools/call',params:{name:${JSON.stringify(blocked)},arguments:{}}})}).then(async r=>process.stdout.write(JSON.stringify({status:r.status,body:await r.json()})))`)
    const denied = JSON.parse(direct)
    expect(denied.status).toBe(200); expect(denied.body.error?.code).toBe(-32602)
    expect(denied.body.error?.message === 'An administrator has disabled a requested tool. This request was not forwarded.').toBe(true)
    const audit = JSON.parse(await readFile(join(root, 'mcp/audit.json'), 'utf8')) as { username: string, service: string, method: string, tool?: string, status: string }[]
    expect(audit.some(row => row.username === 'member' && row.service === 'p-github' && row.method === 'tools/call' && row.tool === blocked && row.status === 'denied')).toBe(true)
    const visible = await exec(`const fs=require('fs'),path=require('path'),chunks=[JSON.stringify(process.env)];
const required=['/dsh-phalanx/member-mcp/entries.json','/dsh-phalanx/home/.dsh/profiles/web/cordis.patch.yml'];
for(const file of required) chunks.push(fs.readFileSync(file,'utf8'));
function scan(dir,depth=0){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isDirectory()&&depth<3&&!['node_modules','.git'].includes(entry.name))scan(file,depth+1);else if(entry.isFile()&&(/\\.(?:json|ya?ml)$/i.test(entry.name)||entry.name==='.env'||entry.name.startsWith('.env.')))chunks.push(fs.readFileSync(file,'utf8'))}}
scan('/dsh-phalanx/home/.dsh');
for(const pid of fs.readdirSync('/proc').filter(p=>/^\\d+$/.test(p))){for(const name of ['cmdline','environ']){try{chunks.push(fs.readFileSync('/proc/'+pid+'/'+name,'utf8'))}catch(e){if(!['ENOENT','EACCES','EPERM','ESRCH'].includes(e.code))throw e}}}
process.stdout.write(chunks.join('\\n'))`)
    expect(visible.includes(secret)).toBe(false)
    expect((await readFile(join(root, 'mcp/audit.json'), 'utf8')).includes(secret)).toBe(false)
    expect((await post(`groups/${account.groupId}/mcp`, { names: [] })).status).toBe(200)
    const revoked = await exec("fetch(new URL('/mcp/p-github',process.env.DSH_PHALANX_MODEL_GATEWAY_URL),{method:'POST',headers:{authorization:'Bearer '+process.env.DSH_PHALANX_MODEL_GATEWAY_ACCESS_TOKEN,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:78,method:'tools/list'})}).then(r=>process.stdout.write(String(r.status)))")
    expect(revoked).toBe('403'); passed = true
  } finally {
    await app.stop(); await new CommunityRuntimeDriver(runtime).rebuild()
    model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
    if (process.env.DSH_PHALANX_E2E_EVIDENCE_DIR) await writeFile(join(process.env.DSH_PHALANX_E2E_EVIDENCE_DIR, 'github-pat-result.json'), JSON.stringify({ passed, discoveredTools: count, disabledWriteTool: blocked, called, credentialExposed: exposed }) + '\n')
  }
}, 240000)
