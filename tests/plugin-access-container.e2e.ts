import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { candidateApplication } from './support/candidate-application.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import { execFileText } from '../src/adapters/runtime-command.js'
import { runtimeSection, assertPinnedDshRevision } from './support/real-dsh-runtime.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { cookieHeader, createRealDshRpc } from './support/real-dsh-rpc.js'
import { signInCommunity } from './fixtures/community-native-browser.js'
import type { CommunityGroupView, CommunityPluginAccessView, CommunityPluginView } from '../src/domain/admin-contract.js'

it.skipIf(!runtimeSettings.containerImage)('routes the actual AnySearch plugin through saved access settings for granted and self-selected members', async () => {
  assertPinnedDshRevision(runtimeSettings)
  const received: { authorization: string | undefined, path: string }[] = []
  const upstream = createServer(async (req, res) => {
    for await (const chunk of req) void chunk
    received.push({ authorization: req.headers.authorization, path: req.url! })
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ code: 0, message: 'ok', data: { metadata: { total_results: 1, search_time_ms: 1 }, results: [{ title: 'ACCESS_READY', url: 'https://example.test/ready', content: 'ACCESS_READY' }] } }))
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const address = upstream.address(); if (!address || typeof address === 'string') throw Error('No upstream address')
  const root = await mkdtemp(join(tmpdir(), 'plugin-access-'))
  const patch = join(root, 'probe.json')
  // A test-only public-service caller, never a replacement implementation of the sample.
  await writeFile(patch, JSON.stringify([{ id: 'web', config: { searchProvider: 'anysearch' } }, { insert: [{ id: 'access-probe', name: '/dsh-phalanx/home/access-probe.mjs' }] }]))
  const runtime = { ...runtimeSection(join(root, 'platform'), 'https://example.test', runtimeSettings), patches: [runtimeSettings.overlay, patch] }
  const app = candidateApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'plugin-access-container-fixture-secret', runtime })
  const browser = await chromium.launch({ headless: true }), page = await browser.newPage({ locale: 'en' })
  const packageName = '@anysearch/anysearch-dsh', query = '?packageName=' + encodeURIComponent(packageName)
  let origin = '', admin = ''
  const request = (path: string, body?: object) => fetch(origin + '/admin/api/' + path, { method: body ? 'POST' : 'GET', headers: { cookie: admin, origin, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
  try {
    origin = await app.start()
    const initialized = await fetch(origin + '/bootstrap', { method: 'POST', redirect: 'manual', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ credential: readBootstrapCredential(runtime.dataRoot)!.credential, username: 'admin', password: 'password' }) })
    expect(initialized.status).toBe(303); admin = initialized.headers.getSetCookie().map(row => row.split(';')[0]).join('; ')
    expect((await request('accounts', { username: 'member', password: 'password', email: '' })).status).toBe(201)
    const home = join(runtime.dataRoot, 'users/member/home'); await mkdir(home, { recursive: true, mode: 0o700 })
    await writeFile(join(home, 'access-probe.mjs'), await readFile(new URL('./fixtures/plugin-access-probe.mjs', import.meta.url), 'utf8'))
    expect((await request('plugins', { action: 'add', packageName, version: '0.1.7' })).status).toBe(202)
    await expect.poll(async () => ((await (await request('plugins')).json()) as CommunityPluginView[])[0]?.stage, { timeout: 180000 }).toBe('available')
    const upstreamInput = { name: 'search', baseUrl: `http://127.0.0.1:${address.port}/anysearch`, credential: 'fictional-platform-secret', headers: [{ name: 'Authorization', value: 'Bearer {credential}' }] }
    expect((await request('plugins/upstreams' + query, { action: 'save', upstream: upstreamInput })).status).toBe(200)
    const view = await (await request('plugins/access' + query)).json() as CommunityPluginAccessView
    expect(view.entryIds.length).toBeGreaterThan(0)
    const entry = view.entryIds.find(id => /anysearch/iu.test(id))!; expect(entry).toBeDefined()
    const config = { environment: [{ name: 'ANYSEARCH_API_KEY', value: '{access-token}' }], entriesYaml: JSON.stringify({ [entry]: { baseURL: '{upstream:search}', apiKeyEnv: 'ANYSEARCH_API_KEY' } }) }
    expect((await request('plugins/access' + query, config)).status).toBe(200)
    const group = ((await (await request('groups')).json()) as CommunityGroupView[]).find(row => row.isDefault)!
    expect((await request(`groups/${group.id}/plugins`, { action: 'save', packages: [packageName] })).status).toBe(200)
    const search = async () => {
      await signInCommunity(page, origin, 'member', 'password')
      const rpc = createRealDshRpc()
      await expect.poll(async () => (await rpc.remoteRpc<Array<{ moduleName: string, fiberPhase: string }>>(origin, await cookieHeader(page.context(), origin), 'pluginManager/listPlugins', {})).find(row => row.moduleName.endsWith('/access-probe.mjs'))?.fiberPhase, { timeout: 30000 }).toBe('active')
      const response = await page.request.get(new URL('access-probe', page.url()).href)
      expect(response.status(), await response.text()).toBe(200)
      expect(await response.text()).toContain('ACCESS_READY')
    }
    await search()
    expect(received.at(-1)?.authorization).toBe('Bearer fictional-platform-secret')
    const owner = createHash('sha256').update(runtime.dataRoot).digest('hex')
    const carrier = (await execFileText('podman', ['ps', '--filter', `label=dsh-phalanx.community-root=${owner}`, '--format', '{{.Names}}'])).trim()
    const observed = await execFileText('podman', ['exec', carrier, 'node', '-e', `const fs=require('fs');const dir='/dsh-phalanx/managed-config';console.log(JSON.stringify({token:process.env.ANYSEARCH_API_KEY,modelToken:process.env.DSH_PHALANX_MODEL_GATEWAY_ACCESS_TOKEN,configs:fs.readdirSync(dir).map(name=>fs.readFileSync(dir+'/'+name,'utf8'))}))`])
    const values = JSON.parse(observed) as { token: string, modelToken: string, configs: string[] }
    expect(values.token).toBe(values.modelToken); expect(values.token.length).toBeGreaterThan(20)
    expect(observed).not.toContain('fictional-platform-secret')
    expect(values.configs.join('')).toContain('/plugins/%40anysearch%2Fanysearch-dsh/search')
    expect((await request('plugins/publication', { action: 'publish', packageName, published: true })).status).toBe(409)
    expect((await request('plugins/publication', { action: 'publish', packageName, published: true, confirmed: true })).status).toBe(200)
    await request(`groups/${group.id}/plugins`, { action: 'save', packages: [] })
    expect((await page.request.post(origin + '/market/api/plugins', { headers: { origin }, data: { packageName, action: 'install' } })).status()).toBe(200)
    expect((await page.request.post(origin + '/recovery/restart', { headers: { origin }, data: { confirmed: true } })).status()).toBe(200)
    await search(); expect(received).toHaveLength(2)
    expect(received.every(row => row.authorization === 'Bearer fictional-platform-secret')).toBe(true)
    expect((await (await request(`groups/${group.id}/plugins`)).json()).pendingMembers).toEqual([])
    await request('plugins/upstreams' + query, { action: 'save', upstream: { ...upstreamInput, credential: 'rotated-platform-secret' } })
    expect((await (await request(`groups/${group.id}/plugins`)).json()).pendingMembers).toEqual([])
    await search(); expect(received.at(-1)?.authorization).toBe('Bearer rotated-platform-secret')
    await request('plugins/access' + query, { ...config, environment: [...config.environment, { name: 'SAMPLE_MODE', value: 'changed' }] })
    expect((await (await request(`groups/${group.id}/plugins`)).json()).pendingMembers).toEqual(['member'])
    const selections = await readFile(join(runtime.dataRoot, 'plugins/selections.json'), 'utf8'); expect(selections).toContain(packageName)
  } finally { await browser.close(); await app.stop(); await new CommunityRuntimeDriver(runtime).rebuild(); await new Promise<void>(resolve => upstream.close(() => resolve())); await rm(root, { recursive: true, force: true }) }
}, 360000)
