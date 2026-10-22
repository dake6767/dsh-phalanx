// Validation: T2; real credentials: none; actual DSH through installed candidate CLI on Linux.
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readdir, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { candidateApplication } from './support/candidate-application.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { assertPinnedDshRevision, runtimeSection } from './support/real-dsh-runtime.js'
import { createBrowserDshRpc, cookieHeader } from './support/real-dsh-rpc.js'
import { latestHumanText, streamText } from './support/real-dsh-model.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import { signInCommunity, openCommunitySession } from './fixtures/community-native-browser.js'
import { skillZip } from './fixtures/skills/archive.js'

it('repairs partial experts, preserves restart semantics and history, restores summons after reset and previews deletion impact', async () => {
  assertPinnedDshRevision(runtimeSettings)
  const root = await realpath(await mkdtemp(join(tmpdir(), 'expert-lifecycle-'))), captured = new Map<string, string>()
  const model = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk
    const body = JSON.parse(text)
    if (body.tools?.length) captured.set(latestHumanText(body), text)
    response.setHeader('content-type', 'text/event-stream'); streamText(response, 'EXPERT_LIFECYCLE_READY')
  })
  const remote = createServer(async (request, response) => {
    if (request.method !== 'POST') { response.writeHead(405).end(); return }
    let raw = ''; for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw)
    if (body.id === undefined) { response.writeHead(202).end(); return }
    const result = body.method === 'initialize' ? { protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'lifecycle-fixture', version: '1' } } : body.method === 'tools/list' ? { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] } : { content: [{ type: 'text', text: 'MCP_READY' }] }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }))
  })
  for (const server of [model, remote]) { server.listen(0, '127.0.0.1'); await once(server, 'listening') }
  const address = (server: typeof model) => `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const runtime = runtimeSection(root, address(model), runtimeSettings)
  const app = candidateApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'expert-lifecycle-acceptance-fixture-secret', runtime })
  const browser = await chromium.launch({ headless: true })
  let primaryFailure: unknown
  const cleanupErrors: unknown[] = []
  try {
    const origin = await app.start(), admin = await browser.newPage({ locale: 'en' }); admin.setDefaultTimeout(30000)
    expect((await admin.request.post(origin + '/bootstrap', { headers: { origin }, form: { credential: readBootstrapCredential(root)!.credential, username: 'admin', password: 'password' }, maxRedirects: 0 })).status()).toBe(303)
    const api = async (path: string, input?: object) => {
      const response = input ? await admin.request.post(origin + '/admin/api/' + path, { headers: { origin }, data: input }) : await admin.request.get(origin + '/admin/api/' + path)
      expect(response.status(), await response.text()).toBeLessThan(300); return response.json()
    }
    await api('models', { revision: (await api('models')).revision, action: 'save-provider', provider: { name: 'Fixture', baseUrl: address(model) + '/anthropic', apiFormat: 'anthropic-messages', apiKey: 'fictional-lifecycle-key', enabled: true, models: [{ name: 'lifecycle', enabled: true }] } })
    const account = await api('accounts', { username: 'member', password: 'password', email: '' })
    for (const name of ['intact', 'vanishing']) {
      const response = await admin.request.post(origin + '/admin/api/skills/upload', { headers: { origin, 'content-type': 'application/zip' }, data: skillZip([{ path: 'SKILL.md', content: `---\nname: ${name}\ndescription: ${name}\n---\nUse ${name}.` }]) })
      expect(response.status()).toBe(200); const preview = await response.json()
      await api('skills/change', { action: 'confirm', token: preview.token, revision: preview.revision })
    }
    await api('skill-packs', { action: 'save', revision: (await api('skill-packs')).revision, pack: { name: 'methods', description: 'Methods', skills: ['vanishing'], instructions: 'Use the method.', published: false } })
    await api('mcp', { action: 'save', service: { name: 'p-vanishing', description: 'Temporary MCP', url: address(remote) } })
    const input = { name: 'Lifecycle expert', description: 'Lifecycle checks', icon: 'L', persona: 'EXPERT_ORIGINAL_PERSONA', skills: ['intact', 'vanishing'], skillPacks: ['methods'], mcp: ['p-vanishing'] }
    await api('experts', { revision: (await api('experts')).revision, expert: input })
    const expert = (await api('experts')).experts[0], preset = 'phalanx-expert-' + expert.id
    await api('experts', { action: 'publish', id: expert.id, published: true, revision: (await api('experts')).revision, confirmed: true })
    const member = await browser.newPage({ locale: 'en' }); member.setDefaultTimeout(30000)
    await signInCommunity(member, origin, 'member', 'password')
    const cookie = await cookieHeader(member.context(), origin), rpc = createBrowserDshRpc(member.context())
    const select = async (action: 'summon' | 'dismiss') => expect((await member.request.post(origin + '/market/api/experts', { headers: { origin }, data: { name: expert.id, action } })).status()).toBe(200)
    const restart = async () => { expect((await member.request.post(origin + '/recovery/restart', { headers: { origin }, data: { confirmed: true } })).status()).toBe(200); await member.reload() }
    const openMarket = async () => { await member.getByRole('button', { name: 'Platform App Center', exact: true }).click(); await member.getByRole('tab', { name: 'Experts', exact: true }).click() }
    await select('summon'); await restart()
    const workspace = await rpc.remoteRpc<{ workspace: { workspaceId: string } }>(origin, cookie, 'workspace/initializeDefault', {})
    expect(workspace.workspace.workspaceId).toBeTypeOf('string')
    const create = async () => (await rpc.remoteRpc<{ sessionId: string }>(origin, cookie, 'session/create', { request: { workspaceId: workspace.workspace.workspaceId, agentPreset: preset } })).sessionId
    const prompt = async (sessionId: string, marker: string, persona: string) => {
      await rpc.remoteRpc(origin, cookie, 'session/prompt', { request: { requestId: randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text: marker }] } })
      await expect.poll(() => captured.get(marker), { timeout: 30000 }).toContain(persona)
      await expect.poll(async () => (await rpc.remoteRpc<{ items: { sessionId: string, running: boolean }[] }>(origin, cookie, 'session/list', { _request: {} })).items.find(row => row.sessionId === sessionId)?.running, { timeout: 30000 }).toBe(false)
    }
    const originalSession = await create(); await prompt(originalSession, 'ORIGINAL_TASK', 'EXPERT_ORIGINAL_PERSONA')
    await admin.goto(origin + '/admin'); await admin.getByRole('link', { name: 'Expert library', exact: true }).click()
    await admin.getByRole('button', { name: 'Edit expert Lifecycle expert', exact: true }).click()
    await admin.getByLabel('Expert persona', { exact: true }).fill('EXPERT_UPDATED_PERSONA'); await admin.getByRole('button', { name: 'Save expert', exact: true }).click()
    await admin.getByRole('dialog').waitFor({ state: 'hidden' }); await admin.getByText('Expert changes take effect after members restart their instances.', { exact: true }).waitFor()
    await prompt(originalSession, 'BEFORE_RESTART', 'EXPERT_ORIGINAL_PERSONA'); expect(captured.get('BEFORE_RESTART')).not.toContain('EXPERT_UPDATED_PERSONA')
    await restart(); await prompt(originalSession, 'RESTORED_AFTER_EDIT', 'EXPERT_UPDATED_PERSONA')
    await prompt(await create(), 'NEW_AFTER_EDIT', 'EXPERT_UPDATED_PERSONA')
    await api('mcp', { action: 'remove', name: 'p-vanishing' })
    await api('skill-packs', { action: 'remove', name: 'methods', deleteSkills: false, revision: (await api('skill-packs')).revision })
    await api('skills/change', { action: 'remove', name: 'vanishing', revision: (await api('skills/detail?name=vanishing')).revision })
    await admin.reload(); await admin.getByText('Unavailable entries', { exact: true }).waitFor()
    for (const missing of ['skill:vanishing', 'skill-pack:methods', 'mcp:p-vanishing']) await admin.getByText(missing, { exact: true }).waitFor()
    await expect.poll(async () => (await api('experts')).experts.flatMap((row: { checking?: readonly string[] }) => row.checking ?? []), { timeout: 30000 }).toEqual([])
    await openMarket(); await member.getByText('Some capabilities are temporarily unavailable.', { exact: true }).waitFor()
    await restart(); await prompt(await create(), 'PARTIAL_EXPERT', 'EXPERT_UPDATED_PERSONA')
    expect(captured.get('PARTIAL_EXPERT')).toContain('intact'); expect(captured.get('PARTIAL_EXPERT')).not.toContain('mcp__p-vanishing__echo')
    // Missing saved references remain visible and removable in the editor.
    await admin.getByRole('button', { name: 'Edit expert Lifecycle expert', exact: true }).click()
    for (const name of ['vanishing', 'methods', 'p-vanishing']) {
      await admin.getByRole('dialog').getByText(name, { exact: true }).first().click()
      await expect.poll(() => admin.getByRole('dialog').getByRole('checkbox', { name, exact: true }).count()).toBe(0)
    }
    await admin.getByRole('button', { name: 'Save expert', exact: true }).click(); await admin.getByRole('dialog').waitFor({ state: 'hidden' })
    await restart(); await openMarket()
    await member.getByText('Dismissing an expert immediately withdraws its exclusive access. After restarting, its sessions cannot continue; history is retained.', { exact: true }).waitFor()
    await member.getByRole('button', { name: 'Dismiss expert', exact: true }).click(); await member.getByRole('button', { name: 'Summon expert', exact: true }).waitFor(); await restart()
    await openCommunitySession(member, originalSession)
    await member.getByText('ORIGINAL_TASK', { exact: true }).waitFor()
    const orphan = await rpc.remoteRpcResult(origin, cookie, 'session/prompt', { request: { requestId: randomUUID(), sessionId: originalSession, mode: 'queue', content: [{ type: 'text', text: 'ORPHAN_MUST_FAIL' }] } }); expect(orphan.ok).toBe(false)
    await openMarket(); await member.getByRole('button', { name: 'Summon expert', exact: true }).click(); await member.getByRole('button', { name: 'Dismiss expert', exact: true }).waitFor(); await restart()
    await prompt(originalSession, 'REVIVED_OLD_SESSION', 'EXPERT_UPDATED_PERSONA')
    await api('accounts/member/reset-environment', { confirmed: true }); await member.reload()
    expect((await api('experts')).experts[0].id).toBe(expert.id)
    expect((await member.request.get(origin + '/market/api/experts').then(response => response.json())).experts[0].status).toBe('summoned')
    await prompt(originalSession, 'AFTER_RESET', 'EXPERT_UPDATED_PERSONA')
    const groupPath = `groups/${account.groupId}/experts`
    await api(groupPath, { names: [expert.id], revision: (await api(groupPath)).revision, confirmed: true })
    await admin.reload(); await admin.getByRole('button', { name: 'Delete expert Lifecycle expert', exact: true }).click()
    const dialog = admin.getByRole('dialog', { name: 'Delete expert', exact: true })
    await dialog.getByText('member', { exact: true }).waitFor(); expect(await dialog.getByText('admin', { exact: true }).count()).toBe(0)
    await dialog.getByText((await api(groupPath)).group.name, { exact: true }).waitFor()
    expect((await member.request.get(origin + '/admin/api/experts?impact=' + expert.id)).status()).toBe(403)
    expect((await admin.request.post(origin + '/admin/api/experts', { headers: { origin }, data: { action: 'remove', id: expert.id, revision: (await api('experts')).revision } })).status()).toBe(400)
    await dialog.getByRole('button', { name: 'Delete expert', exact: true }).click(); await dialog.waitFor({ state: 'hidden' })
    expect((await api('experts')).experts).toEqual([]); expect((await api(groupPath)).experts).toEqual([])
    expect((await member.request.get(origin + '/market/api/experts').then(response => response.json())).experts).toEqual([])
    await restart()
    const roster = await rpc.remoteRpc<{ presets: { id: string }[] }>(origin, cookie, 'agentPresets/list', {}); expect(roster.presets.some(row => row.id === preset)).toBe(false)
  } catch (error) { primaryFailure = error }
  finally {
    const attempt = async (action: () => Promise<unknown>) => { try { await action(); return true } catch (error) { cleanupErrors.push(error); return false } }
    await attempt(() => browser.close())
    const stopped = await attempt(() => app.stop()), rebuilt = await attempt(() => new CommunityRuntimeDriver(runtime).rebuild())
    for (const server of [model, remote]) { server.closeAllConnections(); await attempt(() => new Promise<void>(resolve => server.close(() => resolve()))) }
    const writable = async (path: string): Promise<void> => { if ((await lstat(path)).isDirectory()) { await chmod(path, 0o700); for (const name of await readdir(path)) await writable(join(path, name)) } }
    if (stopped && rebuilt) await attempt(async () => { await mkdir(root, { recursive: true }); await writable(root); await rm(root, { recursive: true, force: true }) })
  }
  if (cleanupErrors.length) throw new AggregateError(primaryFailure ? [primaryFailure, ...cleanupErrors] : cleanupErrors, 'Expert lifecycle acceptance cleanup failed')
  if (primaryFailure) throw primaryFailure
}, 360000)
