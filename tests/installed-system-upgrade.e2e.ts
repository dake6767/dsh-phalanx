// Validation: T4 isolated host; real credentials: SSH access to the owned validation VM; no provider key. Never run on a live deployment.
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { execFileText } from '../src/adapters/runtime-command.js'
import { createRealDshRpc, cookieHeader } from './support/real-dsh-rpc.js'
import { latestHumanText, streamText, streamToolCall, hasToolResult } from './support/real-dsh-model.js'
import { signInCommunity } from './fixtures/community-native-browser.js'

it('upgrades the formal installed OS service while preserving manual MCP grants, selections and member data', async () => {
  const origin = process.env.DSH_PHALANX_OS_ORIGIN, address = process.env.DSH_PHALANX_OS_FIXTURE_ADDRESS
  const ssh = JSON.parse(process.env.DSH_PHALANX_OS_SSH_ARGS ?? 'null') as string[] | null
  const bundle = process.env.DSH_PHALANX_OS_BUNDLE, installer = process.env.DSH_PHALANX_OS_INSTALLER
  const candidate = process.env.DSH_PHALANX_CANDIDATE_SHA, tag = process.env.DSH_PHALANX_CANDIDATE_TAG
  if (!origin || !address || !ssh?.length || !candidate || !tag || !/^v0\.1\.13-rc\.[1-9]\d*$/u.test(tag) || !bundle || !installer || ![bundle, installer].every(path => /^\/[a-zA-Z0-9/_.-]+$/u.test(path))) throw Error('Requires an isolated formal baseline VM, exact candidate bundle and protected SSH configuration')
  const remote = (command: string, timeout = 120000, acceptedExitCodes = [0]) => execFileText('ssh', [...ssh, command], { timeout, maxBuffer: 4 * 1024 * 1024, acceptedExitCodes })
  const calls: Record<string, { failed: boolean, valid: boolean, tools: string[] }> = {}
  let exposed = false, passed = false, credential = ''
  const fixture = createServer(async (request, response) => {
    if (request.method !== 'POST') { response.writeHead(405); response.end(); return }
    let text = ''; for await (const chunk of request) text += chunk
    const body = JSON.parse(text)
    if (request.url === '/mcp') {
      if (request.headers.authorization !== 'Bearer fictional-upgrade-mcp-key') { response.writeHead(401); response.end(); return }
      response.setHeader('content-type', 'application/json')
      if (body.id === undefined) { response.writeHead(202); response.end(); return }
      const result = body.method === 'initialize' ? { protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'upgrade-fixture', version: '1' } }
        : body.method === 'tools/list' ? { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] }
          : { content: [{ type: 'text', text: 'MANUAL_MCP_PRESERVED' }] }
      response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result })); return
    }
    const marker = latestHumanText(body); exposed ||= text.includes('fictional-upgrade-mcp-key')
    response.setHeader('content-type', 'text/event-stream')
    if (hasToolResult(body, marker, false) || hasToolResult(body, marker, true)) {
      calls[marker] = { failed: hasToolResult(body, marker, true), valid: text.includes('MANUAL_MCP_PRESERVED'), tools: (body.tools ?? []).map((tool: { name: string }) => tool.name).filter((name: string) => name.startsWith('mcp__')).sort() }
      streamText(response, 'UPGRADE_QUERY_DONE')
    } else streamToolCall(response, marker, 'mcp__p-selected__echo', {})
  })
  fixture.listen(0, '0.0.0.0'); await once(fixture, 'listening')
  const upstream = `http://${address}:${(fixture.address() as { port: number }).port}`
  const browser = await chromium.launch({ headless: true }), admin = await browser.newPage({ locale: 'en' }), member = await browser.newPage({ locale: 'en' })
  admin.setDefaultTimeout(120000); member.setDefaultTimeout(120000)
  const get = async (path: string) => { const response = await admin.request.get(origin + '/admin/api/' + path); expect(response.status()).toBe(200); return response.json() }
  const post = (path: string, data: object) => admin.request.post(origin + '/admin/api/' + path, { headers: { origin }, data })
  let upgrade: unknown, insufficient: unknown
  try {
    const before = JSON.parse(await remote('sudo cat /opt/dsh-phalanx/current/build-info.json'))
    expect(before.commit).toBe('e0c46eab400c96a40db3f8a42e68d77016d50356')
    expect(before.versions.dsh.revision).toBe('d743267388641bc76f17c45ce8b4c231aed1d32c')
    credential = (await remote('sudo cat /var/lib/dsh-phalanx/data/bootstrap-credential')).trim().split(/\s/u)[0]!
    expect((await admin.request.post(origin + '/bootstrap', { headers: { origin }, form: { credential, username: 'admin', password: 'password' }, maxRedirects: 0 })).status()).toBe(303)
    const settings = await get('models')
    expect((await post('models', { revision: settings.revision, action: 'save-provider', provider: { name: 'Upgrade fixture', baseUrl: upstream + '/anthropic', apiFormat: 'anthropic-messages', apiKey: 'fictional-model-key', enabled: true, models: [{ name: 'fixture-model', enabled: true }] } })).status()).toBe(200)
    const account = await post('accounts', { username: 'member', password: 'password', email: '' }); expect(account.status()).toBe(201)
    const { groupId } = await account.json()
    for (const name of ['p-managed', 'p-selected']) {
      expect((await post('mcp', { action: 'save', service: { name, description: 'Manual retained service', url: upstream + '/mcp', credential: 'fictional-upgrade-mcp-key', headers: [{ name: 'Authorization', value: 'Bearer {credential}' }], disabledTools: [] } })).status()).toBe(200)
      expect((await (await post('mcp/test', { name })).json()).testStatus).toBe('passed')
      expect((await post('mcp', { action: 'publish', name, published: true })).status()).toBe(200)
    }
    expect((await post(`groups/${groupId}/mcp`, { names: ['p-managed'] })).status()).toBe(200)
    await signInCommunity(member, origin, 'member', 'password')
    expect((await member.request.post(origin + '/market/api/mcp', { headers: { origin }, data: { name: 'p-selected', action: 'enable' } })).status()).toBe(200)
    const memberEntry = new URL(member.url()).pathname
    const beforeAccounts = await get('accounts'), beforeLibrary = await get('mcp'), beforeGrants = await get(`groups/${groupId}/mcp`)
    const beforeSelection = await (await member.request.get(origin + '/market/api/mcp')).json()
    const rpc = createRealDshRpc(), call = async (marker: string) => {
      const cookie = await cookieHeader(member.context(), origin)
      const session = await rpc.remoteRpc<{ sessionId: string }>(origin, cookie, 'session/create', { request: { cwd: '/dsh-phalanx/workspace' } })
      await rpc.remoteRpc(origin, cookie, 'session/prompt', { request: { requestId: randomUUID(), sessionId: session.sessionId, mode: 'queue', content: [{ type: 'text', text: marker }] } })
      await expect.poll(() => calls[marker], { timeout: 300000 }).toEqual({ failed: false, valid: true, tools: ['mcp__p-managed__echo', 'mcp__p-selected__echo'] })
    }
    await call('BEFORE_OS_UPGRADE')
    await remote("sudo -u dsh-phalanx sh -c 'printf MEMBER_DATA_PRESERVED > /var/lib/dsh-phalanx/data/users/member/home/upgrade-owned.txt'")
    const pidCommand = 'sudo -u dsh-phalanx env XDG_RUNTIME_DIR=/run/user/$(id -u dsh-phalanx) systemctl --user show dsh-phalanx.service -p MainPID --value'
    const originalPid = (await remote(pidCommand)).trim(); expect(Number(originalPid)).toBeGreaterThan(0)
    await remote('sudo mkdir -p /var/cache/dsh-phalanx; sudo mount -t tmpfs -o size=8m,mode=700 candidate-capacity /var/cache/dsh-phalanx')
    try {
      insufficient = JSON.parse(await remote(`sudo bash ${installer} --version ${tag} --upgrade prepare --output json`, 1800000, [1]))
      expect(insufficient).toMatchObject({ status: 'upgrade', operation: { phase: 'prepare-failed', space: { sufficient: false } } })
      expect((await remote(pidCommand)).trim()).toBe(originalPid)
      await remote('sudo test ! -e /etc/dsh-phalanx/maintenance')
    } finally { await remote('sudo umount /var/cache/dsh-phalanx') }
    // The public installer owns source verification, backup, stop, apply and readiness.
    // Bundle bytes have already been verified against the immutable CI manifest.
    const output = await remote(`sudo bash ${installer} --bundle-dir ${bundle} --version ${tag} --yes --output json`, 1800000)
    upgrade = JSON.parse(output)
    expect(upgrade).toMatchObject({ status: 'upgrade', operation: { phase: 'succeeded', sourceVersion: '0.1.12', targetVersion: '0.1.13', targetCommit: candidate, cleanup: { status: 'succeeded' } } })
    const after = JSON.parse(await remote('sudo cat /opt/dsh-phalanx/current/build-info.json'))
    expect(after.commit).toBe(candidate); expect(after.versions.dsh.revision).toBe(before.versions.dsh.revision)
    await admin.context().clearCookies(); await member.context().clearCookies()
    expect((await admin.request.post(origin + '/login', { headers: { origin }, form: { username: 'admin', password: 'password' }, maxRedirects: 0 })).status()).toBe(303)
    await signInCommunity(member, origin, 'member', 'password'); expect(new URL(member.url()).pathname).toBe(memberEntry)
    expect(await get('accounts')).toEqual(beforeAccounts)
    expect(await get('mcp')).toEqual(beforeLibrary)
    expect(await get(`groups/${groupId}/mcp`)).toEqual(beforeGrants)
    expect(await (await member.request.get(origin + '/market/api/mcp')).json()).toEqual(beforeSelection)
    expect(await remote('sudo cat /var/lib/dsh-phalanx/data/users/member/home/upgrade-owned.txt')).toBe('MEMBER_DATA_PRESERVED')
    await call('AFTER_OS_UPGRADE')
    expect(await member.getByRole('button', { name: 'Service preview', exact: true }).count()).toBe(0)
    expect(exposed).toBe(false)
    expect((await get('mcp/catalog')).map((row: { id: string }) => row.id).sort()).toEqual(['12306', 'amap'])
    passed = true
  } catch (error) {
    throw new Error(credential ? String(error).replaceAll(credential, '[redacted]') : String(error))
  } finally {
    await browser.close(); fixture.closeAllConnections(); await new Promise<void>(resolve => fixture.close(() => resolve()))
    if (process.env.DSH_PHALANX_E2E_EVIDENCE_DIR) await writeFile(join(process.env.DSH_PHALANX_E2E_EVIDENCE_DIR, 'installed-system-upgrade-result.json'), JSON.stringify({ passed, candidate, baseline: 'e0c46eab400c96a40db3f8a42e68d77016d50356', insufficient, upgrade, exposed, calls }) + '\n')
  }
}, 3600000)
