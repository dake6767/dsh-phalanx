// Validation: T2; real credentials: none; actual Linux rootless DSH. Missing inputs must fail the T2 report gate.
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser } from 'playwright'
import { expect, it } from 'vitest'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import { execFileText } from '../src/adapters/runtime-command.js'
import type { CommunityRuntimeConfig } from '../src/domain/community-config.js'
import { DSH_CONTAINER_PROFILE } from '../src/dsh/profile-layout.js'
import { signInCommunity } from './fixtures/community-native-browser.js'
import { removeCommunityFixture } from './fixtures/owned-cleanup.js'
import { candidateApplication } from './support/candidate-application.js'
import { openCommunityHttpEntry } from './support/community-http-entry.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { hasToolResult, latestHumanText, streamText, streamToolCall } from './support/real-dsh-model.js'
import { createRealDshRpc } from './support/real-dsh-rpc.js'
import { assertPinnedDshRevision, runtimeSection } from './support/real-dsh-runtime.js'
import { readUsageRecords } from './support/usage-records.js'

it('calls context7 through granted platform MCP and removes it on the next request in the same Linux DSH session', async () => {
  assertPinnedDshRevision(runtimeSettings)
  const root = await mkdtemp(join(tmpdir(), 'mcp-runtime-'))
  const observations: { marker: string; tools: string[]; result: boolean }[] = []
  const model = createServer(async (req, res) => {
    let text = ''
    for await (const chunk of req) text += chunk
    const body = JSON.parse(text) as { tools?: { name: string }[] },
      marker = latestHumanText(body)
    const result = hasToolResult(body, marker === 'CALL_CREDENTIAL' ? 'credential-call' : 'mcp-call', false)
    observations.push({ marker, tools: (body.tools ?? []).map(tool => tool.name), result })
    res.setHeader('content-type', 'text/event-stream')
    if (marker === 'CALL_CONTEXT7' && !result)
      streamToolCall(res, 'mcp-call', 'mcp__p-context7__resolve-library-id', { libraryName: 'React', query: 'React useState hook documentation' })
    else if (marker === 'CALL_CREDENTIAL' && !result) streamToolCall(res, 'credential-call', 'mcp__p-context7__replacement_echo', {})
    else streamText(res, 'DONE_' + marker)
  })
  model.listen(0, '127.0.0.1')
  await once(model, 'listening')
  const modelOrigin = `http://127.0.0.1:${(model.address() as { port: number }).port}`
  let credentialCalls = 0,
    healthyStarts = 0,
    retryAttempts = 0,
    retryReady = false
  const upstreamCredentials: boolean[] = []
  const replacement = createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405)
      res.end()
      return
    }
    const retry = new URL(req.url!, 'http://localhost').pathname === '/retry'
    if (retry && !retryReady) {
      retryAttempts++
      res.writeHead(503)
      res.end()
      return
    }
    if (!retry)
      upstreamCredentials.push(
        req.headers['x-secondary-key'] === 'fictional-secondary-{credential}' &&
          req.headers.authorization === 'Bearer fictional-platform-mcp-key' &&
          new URL(req.url!, 'http://localhost').searchParams.get('key') === 'fictional-platform-mcp-key',
      )
    let data = ''
    for await (const chunk of req) data += chunk
    const body = JSON.parse(data) as { id?: number; method: string; params?: { protocolVersion?: string } }
    if (body.id === undefined) {
      res.writeHead(202)
      res.end()
      return
    }
    if (!retry && body.method === 'initialize') healthyStarts++
    if (body.method === 'tools/call') credentialCalls++
    const result =
      body.method === 'initialize'
        ? { protocolVersion: body.params?.protocolVersion ?? '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'replacement', version: '1.0.0' } }
        : body.method === 'tools/list'
          ? {
              tools: [
                { name: 'replacement_echo', description: 'Replacement tool', inputSchema: { type: 'object', properties: {} } },
                { name: 'write_record', description: 'Write tool', inputSchema: { type: 'object', properties: {} } },
              ],
            }
          : { content: [{ type: 'text', text: 'Replacement result fictional-platform-mcp-key fictional-secondary-{credential}' }] }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }))
  })
  replacement.listen(0, '127.0.0.1')
  await once(replacement, 'listening')
  const replacementOrigin = `http://127.0.0.1:${(replacement.address() as { port: number }).port}`
  const baseRuntime: CommunityRuntimeConfig = runtimeSection(join(root, 'platform'), modelOrigin, runtimeSettings)
  const runtime = {
    ...baseRuntime,
  }
  const app = candidateApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'mcp-runtime-fixture-session-secret', runtime })
  const rpc = createRealDshRpc()
  let carrier = '',
    passed = false,
    browser: Browser | undefined
  const cookies = (res: Response) =>
    res.headers
      .getSetCookie()
      .map(value => value.split(';')[0])
      .join('; ')
  try {
    const origin = await app.start()
    const bootstrap = await fetch(origin + '/bootstrap', {
      method: 'POST',
      redirect: 'manual',
      headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ credential: readBootstrapCredential(runtime.dataRoot)!.credential, username: 'admin', password: 'password' }),
    })
    expect(bootstrap.status).toBe(303)
    const admin = cookies(bootstrap)
    const post = (path: string, body: object) =>
      fetch(origin + '/admin/api/' + path, {
        method: 'POST',
        headers: { cookie: admin, origin, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    const settings = await (await fetch(origin + '/admin/api/models', { headers: { cookie: admin } })).json()
    expect(
      (
        await post('models', {
          revision: settings.revision,
          action: 'save-provider',
          provider: {
            name: 'Fixture',
            baseUrl: modelOrigin + '/anthropic',
            apiFormat: 'anthropic-messages',
            apiKey: 'fictional-fixture-key',
            enabled: true,
            models: [{ name: 'fixture-model', enabled: true }],
          },
        })
      ).status,
    ).toBe(200)
    const created = await post('accounts', { username: 'member', password: 'password', email: '' })
    expect(created.status).toBe(201)
    const account = (await created.json()) as { groupId: string; spaceId: string }
    expect(
      (await post('mcp', { action: 'save', service: { name: 'p-context7', description: 'Documentation', url: 'https://mcp.context7.com/mcp' } })).status,
    ).toBe(200)
    const login = await fetch(origin + '/login', {
      method: 'POST',
      redirect: 'manual',
      headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'member', password: 'password' }),
    })
    expect(login.status).toBe(303)
    expect(login.headers.get('location')).not.toBe('/recovery')
    const member = (await openCommunityHttpEntry(origin, cookies(login), 300_000)).cookie
    const owner = createHash('sha256').update(runtime.dataRoot).digest('hex')
    carrier = (await execFileText('podman', ['ps', '--filter', `label=dsh-phalanx.community-root=${owner}`, '--format', '{{.Names}}'])).trim()
    expect(carrier).not.toBe('')
    const exec = (code: string) => execFileText('podman', ['exec', carrier, 'node', '-e', code])
    const before = JSON.parse(await execFileText('podman', ['inspect', carrier]))[0]
    const session = await rpc.remoteRpc<{ sessionId: string }>(origin, member, 'session/create', { request: { cwd: '/dsh-phalanx/workspace' } })
    const prompt = async (marker: string) => {
      await rpc.remoteRpc(origin, member, 'session/prompt', {
        request: { requestId: randomUUID(), sessionId: session.sessionId, mode: 'queue', content: [{ type: 'text', text: marker }] },
      })
      await expect.poll(() => observations.some(row => row.marker === marker && (!marker.startsWith('CALL_') || row.result)), { timeout: 90000 }).toBe(true)
      await expect
        .poll(
          async () =>
            (await rpc.remoteRpc<{ items: { sessionId: string; running: boolean }[] }>(origin, member, 'session/list', { _request: {} })).items.find(
              item => item.sessionId === session.sessionId,
            )?.running,
          { timeout: 30000 },
        )
        .toBe(false)
      return observations.findLast(row => row.marker === marker && (!marker.startsWith('CALL_') || row.result))!
    }
    expect((await prompt('BEFORE_GRANT')).tools.filter(name => name.startsWith('mcp__p-context7__'))).toEqual([])
    expect((await post('groups/' + account.groupId + '/mcp', { names: ['p-context7'] })).status).toBe(200)
    expect((await prompt('CALL_CONTEXT7')).tools).toContain('mcp__p-context7__resolve-library-id')
    const inventory = await rpc.remoteRpc<{ moduleName: string; entryId: string; readOnlyReason: string }[]>(origin, member, 'pluginManager/listPlugins', {})
    const managed = inventory.find(row => row.moduleName.includes('/dsh-mcp-client/'))!
    expect(managed.readOnlyReason).toBe('unaddressable')
    expect(await rpc.remoteRpc(origin, member, 'pluginManager/setPluginEnabled', { id: managed.entryId, enabled: false })).toMatchObject({
      application: 'failed',
      changed: false,
    })
    expect(await rpc.remoteRpc(origin, member, 'pluginManager/removeBundle', { name: managed.moduleName })).toMatchObject({ application: 'failed' })
    expect(
      await exec(
        "try{require('fs').writeFileSync('/dsh-phalanx/member-mcp/entries.json','[]');process.stdout.write('writable')}catch(e){process.stdout.write(e.code)}",
      ),
    ).toBe('EROFS')
    const projection = await readFile(join(runtime.dataRoot, 'mcp', 'members', account.spaceId, 'entries.json'), 'utf8')
    expect(projection).not.toContain('mcp.context7.com')
    expect(projection).not.toContain('fictional-fixture-key')
    expect(
      (
        await post('mcp', {
          action: 'save',
          service: {
            name: 'p-context7',
            description: 'Replacement',
            url: replacementOrigin + '/mcp',
            credential: 'fictional-platform-mcp-key',
            credentials: { secondary: 'fictional-secondary-{credential}' },
            headers: [
              { name: 'Authorization', value: 'Bearer {credential}' },
              { name: 'X-Secondary-Key', value: '{credential:secondary}' },
            ],
            query: [{ name: 'key', value: '{credential}' }],
            disabledTools: ['write_record'],
          },
        })
      ).status,
    ).toBe(200)
    const updated = await prompt('CHANGED_ENDPOINT')
    expect(updated.tools).toContain('mcp__p-context7__replacement_echo')
    expect(updated.tools).not.toContain('mcp__p-context7__resolve-library-id')
    expect(updated.tools).not.toContain('mcp__p-context7__write_record')
    await prompt('CALL_CREDENTIAL')
    expect(credentialCalls).toBe(1)
    expect(upstreamCredentials.every(Boolean)).toBe(true)
    const blocked = await exec(
      "fetch(new URL('/mcp/p-context7',process.env.DSH_PHALANX_MODEL_GATEWAY_URL),{method:'POST',headers:{authorization:'Bearer '+process.env.DSH_PHALANX_MODEL_GATEWAY_ACCESS_TOKEN,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:8,method:'tools/call',params:{name:'write_record'}})}).then(r=>r.json()).then(r=>process.stdout.write(String(r.error.code)))",
    )
    expect(blocked).toBe('-32602')
    expect(credentialCalls).toBe(1)
    expect(await exec('process.stdout.write(JSON.stringify(process.env))')).not.toContain('fictional-')
    const memberFiles = await exec(
      "const fs=require('fs');const paths=['/dsh-phalanx/member-mcp'," +
        JSON.stringify(DSH_CONTAINER_PROFILE) +
        "];for(const dir of paths){for(const f of fs.readdirSync(dir)){const p=dir+'/'+f;if(fs.statSync(p).isFile())process.stdout.write(fs.readFileSync(p,'utf8'))}}",
    )
    expect(memberFiles).not.toContain('fictional-')
    const processList = await exec(
      "const fs=require('fs');for(const p of fs.readdirSync('/proc').filter(p=>/^\\d+$/.test(p))){try{process.stdout.write(fs.readFileSync('/proc/'+p+'/cmdline'))}catch{}}",
    )
    expect(processList).not.toContain('fictional-')
    const usage = await readUsageRecords(origin, admin)
    expect(usage.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          username: 'member',
          groupId: account.groupId,
          capability: { kind: 'mcp', id: 'p-context7', operation: 'replacement_echo' },
          outcome: 'succeeded',
        }),
        expect.objectContaining({ capability: { kind: 'mcp', id: 'p-context7', operation: 'write_record' }, outcome: 'denied' }),
      ]),
    )
    expect(JSON.stringify(usage)).not.toContain('fictional-')
    expect(usage.items.every(row => row.capability.kind === 'mcp' && !['initialize', 'tools/list'].includes(row.capability.operation))).toBe(true)
    await expect(readFile(join(runtime.dataRoot, 'mcp', 'audit.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    browser = await chromium.launch({ headless: true })
    const usagePage = await browser.newPage({ locale: 'en' })
    usagePage.setDefaultTimeout(30000)
    await signInCommunity(usagePage, origin, 'admin', 'password', true)
    await usagePage.goto(origin + '/admin/usage-records')
    const usageGrid = usagePage.getByRole('grid', { name: 'Tool usage records', exact: true })
    await usageGrid.getByText('replacement_echo', { exact: true }).waitFor()
    await usageGrid.getByText('Usage denied', { exact: true }).waitFor()
    // A failed platform client must retry unchanged configuration without remounting its healthy sibling.
    expect(
      (await post('mcp', { action: 'save', service: { name: 'p-retry', description: 'Temporary unavailable fixture', url: replacementOrigin + '/retry' } }))
        .status,
    ).toBe(200)
    expect((await post('groups/' + account.groupId + '/mcp', { names: ['p-context7', 'p-retry'] })).status).toBe(200)
    const failed = await prompt('RETRY_FAILED_FIRST')
    expect(failed.tools).toContain('mcp__p-context7__replacement_echo')
    expect(failed.tools).not.toContain('mcp__p-retry__replacement_echo')
    const healthyBeforeRetry = healthyStarts,
      attemptsBeforeRetry = retryAttempts
    const again = await prompt('RETRY_FAILED_AGAIN')
    expect(again.tools).toContain('mcp__p-context7__replacement_echo')
    expect(retryAttempts).toBeGreaterThan(attemptsBeforeRetry)
    expect(healthyStarts).toBe(healthyBeforeRetry)
    retryReady = true
    expect((await prompt('RETRY_RECOVERED')).tools).toContain('mcp__p-retry__replacement_echo')
    expect(healthyStarts).toBe(healthyBeforeRetry)
    expect((await post('groups/' + account.groupId + '/mcp', { names: [] })).status).toBe(200)
    const direct = await exec(
      "fetch(new URL('/mcp/p-context7',process.env.DSH_PHALANX_MODEL_GATEWAY_URL),{method:'POST',headers:{authorization:'Bearer '+process.env.DSH_PHALANX_MODEL_GATEWAY_ACCESS_TOKEN,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:7,method:'tools/list'})}).then(r=>process.stdout.write(String(r.status)))",
    )
    expect(direct).toBe('403')
    expect((await prompt('AFTER_REVOKE')).tools.filter(name => name.startsWith('mcp__p-context7__'))).toEqual([])
    const after = JSON.parse(await execFileText('podman', ['inspect', carrier]))[0]
    expect(after.Id).toBe(before.Id)
    expect(after.State.StartedAt).toBe(before.State.StartedAt)
    expect(after.RestartCount).toBe(before.RestartCount)
    passed = true
  } finally {
    const evidence = process.env.DSH_PHALANX_E2E_EVIDENCE_DIR
    if (evidence)
      await writeFile(
        join(evidence, 'mcp-runtime-result.json'),
        JSON.stringify({ passed, observations: observations.map(row => ({ ...row, tools: row.tools.filter(name => name.startsWith('mcp__')) })) }, null, 2),
      )
    if (!passed && evidence && carrier)
      await writeFile(join(evidence, 'mcp-runtime-container.log'), await execFileText('podman', ['logs', carrier]).catch(() => 'unavailable'))
    await browser?.close()
    await app.stop()
    await new CommunityRuntimeDriver(runtime).rebuild()
    replacement.closeAllConnections()
    await new Promise<void>(resolve => replacement.close(() => resolve()))
    model.closeAllConnections()
    await new Promise<void>(resolve => model.close(() => resolve()))
    await removeCommunityFixture(root)
  }
}, 300000)
