// Validation: T2; real credentials: none; installed rootless DSH calls a fixture plugin upstream through a native session.
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { candidateApplication } from './support/candidate-application.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { assertPinnedDshRevision, runtimeSection } from './support/real-dsh-runtime.js'
import { cookieHeader, createBrowserDshRpc } from './support/real-dsh-rpc.js'
import { hasToolResult, latestHumanText, streamText, streamToolCall } from './support/real-dsh-model.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import { signInCommunity } from './fixtures/community-native-browser.js'
import { expertFixturePackage, packExpertPlugin } from './fixtures/expert-plugin.js'
import type { CommunityUsageRecords } from '../src/domain/admin-contract.js'

it.skipIf(!runtimeSettings.containerImage)('records native plugin upstream use with starting groups, filters, retention and durable administrator views', async () => {
  assertPinnedDshRevision(runtimeSettings)
  const root = await mkdtemp(join(tmpdir(), 'usage-records-')), completed = new Set<string>(), secret = randomUUID()
  let release!: () => void, entered!: () => void, waiting = false, status = 200
  const arrived = new Promise<void>(resolve => { entered = resolve }), released = new Promise<void>(resolve => { release = resolve })
  const model = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw), marker = latestHumanText(body)
    response.setHeader('content-type', 'text/event-stream')
    if (marker.startsWith('USE_UPSTREAM_') && body.tools?.length) {
      if (!hasToolResult(body, marker, false) && !hasToolResult(body, marker, true)) { streamToolCall(response, marker, 'expert_fixture_remote', {}); return }
      completed.add(marker)
    }
    streamText(response, 'USAGE_COMPLETE')
  })
  const upstream = createServer(async (request, response) => {
    expect(request.headers.authorization === 'Bearer ' + secret).toBe(true)
    for await (const chunk of request) void chunk
    if (waiting) { entered(); await released }
    response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify({ marker: 'PRIVATE_UPSTREAM_OUTPUT' }))
  })
  for (const server of [model, upstream]) { server.listen(0, '127.0.0.1'); await once(server, 'listening') }
  const address = (server: typeof model) => `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const runtime = runtimeSection(join(root, 'platform'), address(model), runtimeSettings)
  const overlay = join(root, 'native-tools.json')
  await writeFile(overlay, JSON.stringify([{ id: 'tools', config: { mode: 'native' } }]))
  runtime.patches.push(overlay)
  const config = { listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'usage-records-installed-fixture-secret', runtime }
  let app = candidateApplication(config)
  const browser = await chromium.launch({ headless: true })
  let failure: unknown
  const cleanupErrors: unknown[] = []
  try {
    let origin = await app.start()
    const admin = await browser.newPage({ locale: 'en' }); admin.setDefaultTimeout(30000)
    await admin.goto(origin + '/bootstrap#credential=' + readBootstrapCredential(runtime.dataRoot)!.credential)
    await admin.getByLabel('Username', { exact: true }).fill('admin'); await admin.getByLabel('Password', { exact: true }).fill('password')
    await admin.getByRole('button', { name: 'Create administrator', exact: true }).click(); await admin.waitForURL(origin + '/admin')
    const api = async (path: string, data?: object) => {
      const result = data ? await admin.request.post(origin + '/admin/api/' + path, { headers: { origin }, data }) : await admin.request.get(origin + '/admin/api/' + path)
      expect(result.ok(), await result.text()).toBe(true); return result.json()
    }
    const models = await api('models')
    await api('models', { revision: models.revision, action: 'save-provider', provider: { name: 'Fixture', baseUrl: address(model) + '/anthropic', apiFormat: 'anthropic-messages', apiKey: 'fictional-model-key', enabled: true, models: [{ name: 'usage-model', enabled: true }] } })
    const account = await api('accounts', { username: 'member', password: 'password', email: '' })
    const packed = await packExpertPlugin(root, 'healthy')
    const uploaded = await admin.request.post(origin + '/admin/api/plugins/upload', { headers: { origin, 'content-type': 'application/gzip', 'x-plugin-filename': 'fixture.tgz' }, data: await readFile(packed.archive) })
    expect(uploaded.status(), await uploaded.text()).toBe(202)
    await expect.poll(async () => (await api('plugins')).find((row: { packageName: string }) => row.packageName === packed.packageName)?.stage, { timeout: 240000 }).toMatch(/^(available|failed)$/u)
    expect((await api('plugins')).find((row: { packageName: string }) => row.packageName === packed.packageName)).toMatchObject({ stage: 'available' })
    const query = '?packageName=' + encodeURIComponent(expertFixturePackage)
    await api('plugins/upstreams' + query, { action: 'save', upstream: { name: 'search', baseUrl: address(upstream), credential: secret, headers: [{ name: 'Authorization', value: 'Bearer {credential}' }] } })
    await api('plugins/access' + query, { environment: [], entriesYaml: JSON.stringify({ consumer: { endpoint: '{upstream:search}', apiKey: '{access-token}' } }) })
    await api(`groups/${account.groupId}/plugins`, { action: 'save', packages: [expertFixturePackage] })
    const member = await browser.newPage({ locale: 'en' }); await signInCommunity(member, origin, 'member', 'password')
    const rpc = createBrowserDshRpc(member.context()), cookie = await cookieHeader(member.context(), origin)
    const prompt = async (label: string) => {
      const session = await rpc.remoteRpc<{ sessionId: string }>(origin, cookie, 'session/create', { request: { cwd: '/dsh-phalanx/workspace', agentPreset: 'standard' } })
      const marker = 'USE_UPSTREAM_' + label
      await rpc.remoteRpc(origin, cookie, 'session/prompt', { request: { requestId: randomUUID(), sessionId: session.sessionId, mode: 'queue', content: [{ type: 'text', text: marker }] } })
      await expect.poll(() => completed.has(marker), { timeout: 30000 }).toBe(true)
      await expect.poll(async () => (await rpc.remoteRpc<{ items: { sessionId: string, running: boolean }[] }>(origin, cookie, 'session/list', { _request: {} })).items.find(row => row.sessionId === session.sessionId)?.running, { timeout: 30000 }).toBe(false)
    }
    waiting = true
    const first = prompt('FIRST'); await Promise.race([arrived, first.then(() => { throw Error('Native session did not call the configured plugin upstream') })])
    const groups = await api('groups', { action: 'create', name: 'New usage group' })
    const newGroup = groups.find((row: { name: string }) => row.name === 'New usage group')
    await api(`groups/${newGroup.id}/plugins`, { action: 'save', packages: [expertFixturePackage] })
    await api('accounts/member/actions', { action: 'set-email', email: '', groupId: newGroup.id })
    release(); await first; waiting = false
    let records = await api('usage-records') as CommunityUsageRecords
    expect(records.items).toMatchObject([{ username: 'member', groupId: account.groupId, capability: { kind: 'plugin-upstream', id: expertFixturePackage, operation: 'search' }, outcome: 'succeeded', httpStatus: 200 }])
    expect(records.summaries.members).toEqual([{ key: 'member', count: 1 }]); expect(records.summaries.groups).toEqual([{ key: account.groupId, count: 1 }])
    status = 503; await prompt('FAILED')
    await api(`groups/${newGroup.id}/plugins`, { action: 'save', packages: [] }); await prompt('DENIED')
    records = await api('usage-records')
    expect(records.items.map(row => row.outcome)).toEqual(['denied', 'failed', 'succeeded'])
    expect(JSON.stringify(records)).not.toMatch(/PRIVATE_UPSTREAM_OUTPUT|fictional-model-key|Bearer/)
    expect(JSON.stringify(records).includes(secret)).toBe(false)
    expect((await member.request.get(origin + '/admin/api/usage-records')).status()).toBe(403)
    await admin.getByRole('link', { name: 'Usage records', exact: true }).click()
    const table = admin.getByRole('grid', { name: 'Tool usage records', exact: true })
    await table.getByText('Usage denied', { exact: true }).waitFor()
    await admin.getByLabel('Filter by member', { exact: true }).fill('member')
    await admin.getByLabel('Filter by capability', { exact: true }).fill(expertFixturePackage)
    await admin.getByLabel('Filter by operation', { exact: true }).fill('search')
    await admin.getByLabel('Filter by result', { exact: true }).click(); await admin.getByRole('option', { name: 'Usage succeeded', exact: true }).click()
    await admin.getByLabel('From (local time)', { exact: true }).fill(new Date(records.items.at(-1)!.startedAt - 1000).toISOString())
    await admin.getByLabel('Until (exclusive, local time)', { exact: true }).fill(new Date(records.items[0]!.startedAt + 1000).toISOString())
    await admin.getByRole('button', { name: 'Apply filters', exact: true }).click()
    await expect.poll(() => table.getByRole('row').count()).toBe(2)
    await table.getByText('Usage succeeded', { exact: true }).waitFor()
    await admin.getByLabel('Filter by group', { exact: true }).click(); await admin.getByRole('option', { name: 'New usage group', exact: true }).click()
    await admin.getByRole('button', { name: 'Apply filters', exact: true }).click(); await table.getByText('No usage records match these filters.', { exact: true }).waitFor()
    await admin.getByRole('link', { name: 'System settings', exact: true }).click()
    await expect.poll(() => admin.getByLabel('Retention days', { exact: true }).inputValue()).toBe('180')
    await admin.getByLabel('Retention days', { exact: true }).fill('7')
    await admin.getByRole('region', { name: 'Usage record retention', exact: true }).getByRole('button', { name: 'Save changes', exact: true }).click()
    await expect.poll(async () => (await api('usage-settings')).retentionDays).toBe(7)
    await app.stop(); app = candidateApplication(config); origin = await app.start()
    await admin.goto(origin + '/login'); await admin.getByLabel('Username', { exact: true }).fill('admin'); await admin.getByLabel('Password', { exact: true }).fill('password'); await admin.getByRole('button', { name: 'Sign in', exact: true }).click(); await admin.waitForURL(origin + '/admin')
    expect((await api('usage-settings')).retentionDays).toBe(7); expect((await api('usage-records')).total).toBe(3)
    await admin.getByRole('button', { name: 'Edit member', exact: true }).click()
    await admin.getByRole('dialog').getByRole('link', { name: 'View usage records', exact: true }).click(); await admin.waitForURL(origin + '/admin/usage-records?username=member')
    expect(await admin.getByLabel('Filter by member', { exact: true }).inputValue()).toBe('member')
    await admin.getByRole('button', { name: /^Platform language:/u }).click(); await admin.getByRole('menuitemradio', { name: '简体中文', exact: true }).click()
    await admin.getByRole('heading', { name: '使用记录', exact: true }).waitFor()
    expect((await admin.request.get(origin + '/admin/usage-records')).status()).toBe(200)
  } catch (error) { failure = error }
  finally {
    release()
    for (const cleanup of [() => browser.close(), () => app.stop(), () => new CommunityRuntimeDriver(runtime).rebuild(), ...[model, upstream].map(server => async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }), () => rm(root, { recursive: true, force: true })]) try { await cleanup() } catch (error) { cleanupErrors.push(error) }
  }
  if (failure || cleanupErrors.length) throw new AggregateError([...(failure ? [failure] : []), ...cleanupErrors], 'Usage records acceptance or cleanup failed')
}, 360000)
