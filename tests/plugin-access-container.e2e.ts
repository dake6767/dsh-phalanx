// Validation: T2; real credentials: none; actual Linux rootless DSH. Missing inputs must fail the T2 report gate.
import { assertLegacyNativeServiceCopy } from './support/legacy-native-service-copy.js'
import { showAppCenterForFixture } from './support/app-center-visibility.js'
import { memberSpacePath } from './support/real-dsh-runtime.js'
import { prepareAndConfirmNpmPlugin } from './support/plugin-intake.js'
import { removeCommunityFixture } from './fixtures/owned-cleanup.js'
import { pluginChoices } from './support/plugin-facts.js'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import { execFileText } from '../src/adapters/runtime-command.js'
import type { CommunityGroupView, CommunityPluginAccessView, CommunityPluginView } from '../src/domain/admin-contract.js'
import { declaredRuntimeRevision } from '../src/adapters/runtime-revision.js'
import { NativeMemberPluginManager } from '../src/adapters/member-plugin-manager.js'
import { PostgresCommunityAccountStore } from '../src/adapters/postgres-community-accounts.js'
import { PostgresPluginLibraryStore } from '../src/adapters/postgres-plugin-library.js'
import { PostgresPluginGrants } from '../src/adapters/postgres-plugin-grants.js'
import { PostgresPluginInstallations } from '../src/adapters/postgres-plugin-installations.js'
import { PostgresPluginAccessStore } from '../src/adapters/postgres-plugin-access-store.js'
import { PostgresSessionKey } from '../src/adapters/postgres-session-key.js'
import { MEMBER_PLUGIN_ARCHIVE_DIRECTORY } from '../src/dsh/native-plugin-replacement.js'
import { withSuiteCatalogContentHash } from '../src/domain/suite-catalog-document.js'
import type { CatalogPluginServiceSlot } from '../src/domain/suite-service-slots.js'
import type { CommunityRuntimeConfig } from '../src/domain/community-config.js'
import type { CommunityUserInstance } from '../src/ports/community-runtime.js'
import { documentSuiteCatalogFixture } from './fixtures/suite-catalog-server.js'
import { openTestDatabase, seedTestSecrets, withTestDatabase } from './support/community-application.js'
import { openCommunityHttpEntry } from './support/community-http-entry.js'
import { validationDownloadSelection } from './support/validation-downloads.js'

import { signInCommunity } from './fixtures/community-native-browser.js'
import { candidateApplication } from './support/candidate-application.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { cookieHeader, createRealDshRpc } from './support/real-dsh-rpc.js'
import { assertPinnedDshRevision, runtimeSection } from './support/real-dsh-runtime.js'

it.skipIf(!runtimeSettings.containerImage)(
  'routes both controlled and adapted native plugins through their authorized platform credentials',
  async () => {
    assertPinnedDshRevision(runtimeSettings)
    const received: { authorization: string | undefined; path: string }[] = []
    const upstream = createServer(async (req, res) => {
      for await (const chunk of req) void chunk
      received.push({ authorization: req.headers.authorization, path: req.url! })
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({
          code: 0,
          message: 'ok',
          data: {
            metadata: { total_results: 1, search_time_ms: 1 },
            results: [{ title: 'ACCESS_READY', url: 'https://example.test/ready', content: 'ACCESS_READY' }],
          },
        }),
      )
    })
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
    const address = upstream.address()
    if (!address || typeof address === 'string') throw Error('No upstream address')
    const root = await mkdtemp(join(tmpdir(), 'plugin-access-'))
    const patch = join(root, 'probe.json')
    // A test-only public-service caller, never a replacement implementation of the sample.
    await writeFile(
      patch,
      JSON.stringify([
        { id: 'web', config: { searchProvider: 'anysearch' } },
        { insert: [{ id: 'access-probe', name: '/dsh-phalanx/home/access-probe.mjs' }] },
      ]),
    )
    const runtime = { ...runtimeSection(join(root, 'platform'), 'https://example.test', runtimeSettings), patches: [runtimeSettings.overlay, patch] }
    const app = candidateApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'plugin-access-container-fixture-secret', runtime })
    const browser = await chromium.launch({ headless: true }),
      page = await browser.newPage({ locale: 'en' })
    const packageName = '@anysearch/anysearch-dsh',
      query = '?packageName=' + encodeURIComponent(packageName)
    let origin = '',
      admin = ''
    const request = (path: string, body?: object) =>
      fetch(origin + '/admin/api/' + path, {
        method: body ? 'POST' : 'GET',
        headers: { cookie: admin, origin, 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
    try {
      origin = await app.start()
      const initialized = await fetch(origin + '/bootstrap', {
        method: 'POST',
        redirect: 'manual',
        headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ credential: readBootstrapCredential(runtime.dataRoot)!.credential, username: 'admin', password: 'password' }),
      })
      expect(initialized.status).toBe(303)
      admin = initialized.headers
        .getSetCookie()
        .map(row => row.split(';')[0])
        .join('; ')
      expect((await request('accounts', { username: 'member', password: 'password', email: '' })).status).toBe(201)
      const home = join(await memberSpacePath(runtime.dataRoot, 'member'), 'home')
      await mkdir(home, { recursive: true, mode: 0o700 })
      await writeFile(join(home, 'access-probe.mjs'), await readFile(new URL('./fixtures/plugin-access-probe.mjs', import.meta.url), 'utf8'))
      await prepareAndConfirmNpmPlugin(request, `${packageName}@0.1.8`)
      await expect
        .poll(async () => ((await (await request('plugins')).json()) as CommunityPluginView[])[0]?.stage, { timeout: 180000 })
        .toMatch(/^(available|failed)$/u)
      expect(((await (await request('plugins')).json()) as CommunityPluginView[])[0]).toMatchObject({ stage: 'available' })
      const upstreamInput = {
        name: 'search',
        baseUrl: `http://127.0.0.1:${address.port}/anysearch`,
        credential: 'fictional-platform-secret',
        headers: [{ name: 'Authorization', value: 'Bearer {credential}' }],
      }
      expect((await request('plugins/upstreams' + query, { action: 'save', upstream: upstreamInput })).status).toBe(200)
      const view = (await (await request('plugins/access' + query)).json()) as CommunityPluginAccessView
      expect(view.entryIds.length).toBeGreaterThan(0)
      const entry = view.entryIds.find(id => /anysearch/iu.test(id))!
      expect(entry).toBeDefined()
      const config = {
        environment: [{ name: 'ANYSEARCH_API_KEY', value: '{access-token}' }],
        entriesYaml: JSON.stringify({ [entry]: { baseURL: '{upstream:search}', apiKeyEnv: 'ANYSEARCH_API_KEY' } }),
      }
      expect((await request('plugins/access' + query, config)).status).toBe(200)
      const group = ((await (await request('groups')).json()) as CommunityGroupView[]).find(row => row.isDefault)!
      await showAppCenterForFixture(origin, 'admin', 'password')
      expect(
        (
          await request(`groups/${group.id}/plugins`, {
            action: 'save',
            packages: [packageName],
            preinstalls: [],
            revision: (await (await request(`groups/${group.id}/plugins`)).json()).revision,
          })
        ).status,
      ).toBe(200)
      const search = async () => {
        await signInCommunity(page, origin, 'member', 'password')
        const rpc = createRealDshRpc()
        await expect
          .poll(
            async () =>
              (
                await rpc.remoteRpc<Array<{ moduleName: string; fiberPhase: string }>>(
                  origin,
                  await cookieHeader(page.context(), origin),
                  'pluginManager/listPlugins',
                  {},
                )
              ).find(row => row.moduleName.endsWith('/access-probe.mjs'))?.fiberPhase,
            { timeout: 30000 },
          )
          .toBe('active')
        const response = await page.request.get(new URL('access-probe', page.url()).href)
        expect(response.status(), await response.text()).toBe(200)
        expect(await response.text()).toContain('ACCESS_READY')
      }
      await search()
      expect(received.at(-1)?.authorization).toBe('Bearer fictional-platform-secret')
      // Stored references outrank launch environment; removing them restores platform routing.
      const credentialRpc = createRealDshRpc(),
        memberCookie = await cookieHeader(page.context(), origin)
      const credentialFacts = async () => await (await page.request.get(new URL('credential-probe', page.url()).href)).json()
      const refs = ['ANYSEARCH_API_KEY', 'DSH_PHALANX_MODEL_GATEWAY_ACCESS_TOKEN']
      for (const ref of refs) expect((await credentialFacts())[ref]).toEqual({ source: 'env', matchesEnvironment: true })
      for (const ref of [...refs, 'PERSONAL_FIXTURE_KEY'])
        await credentialRpc.remoteRpc(origin, memberCookie, 'credentials/set', { ref, value: 'fictional-member-override' })
      for (const ref of refs) expect((await credentialFacts())[ref]).toEqual({ source: 'file', matchesEnvironment: false })
      const denied = await page.request.get(new URL('access-probe', page.url()).href)
      expect(denied.status()).toBe(500)
      expect(received).toHaveLength(1)
      for (const ref of refs) await credentialRpc.remoteRpc(origin, memberCookie, 'credentials/unset', { ref })
      await search()
      expect(received).toHaveLength(2)
      expect((await credentialFacts()).PERSONAL_FIXTURE_KEY.source).toBe('file')
      const owner = createHash('sha256').update(runtime.dataRoot).digest('hex')
      const carrier = (await execFileText('podman', ['ps', '--filter', `label=dsh-phalanx.community-root=${owner}`, '--format', '{{.Names}}'])).trim()
      const observed = await execFileText('podman', [
        'exec',
        carrier,
        'node',
        '-e',
        `const fs=require('fs'),vm=require('node:vm');const dir='/dsh-phalanx/managed-config';const configs=fs.readdirSync(dir).map(name=>fs.readFileSync(dir+'/'+name,'utf8'));const evaluate=value=>Array.isArray(value)?value.map(evaluate):value&&typeof value==='object'?'__jsExpr' in value?vm.runInNewContext(value.__jsExpr,{process:{env:process.env}}):Object.fromEntries(Object.entries(value).map(([key,item])=>[key,evaluate(item)])):value;const token=process.env.ANYSEARCH_API_KEY;console.log(JSON.stringify({tokenMatchesModel:token===process.env.DSH_PHALANX_MODEL_GATEWAY_ACCESS_TOKEN,tokenLength:token?.length??0,configs,containsToken:configs.some(text=>token&&text.includes(token)),resolvedUpstream:configs.some(text=>JSON.stringify(evaluate(JSON.parse(text))).includes('/plugins/%40anysearch%2Fanysearch-dsh/search'))}))`,
      ])
      const values = JSON.parse(observed) as {
        tokenMatchesModel: boolean
        tokenLength: number
        configs: string[]
        containsToken: boolean
        resolvedUpstream: boolean
      }
      expect(values.tokenMatchesModel).toBe(true)
      expect(values.tokenLength).toBeGreaterThan(20)
      expect(observed).not.toContain('fictional-platform-secret')
      expect(values.containsToken).toBe(false)
      expect(values.configs.join('')).toContain('__jsExpr')
      expect(values.resolvedUpstream).toBe(true)
      expect((await request('plugins/publication', { action: 'publish', packageName, published: true })).status).toBe(409)
      expect((await request('plugins/publication', { action: 'publish', packageName, published: true, confirmed: true })).status).toBe(200)
      await request(`groups/${group.id}/plugins`, {
        action: 'save',
        packages: [],
        preinstalls: [],
        revision: (await (await request(`groups/${group.id}/plugins`)).json()).revision,
      })
      expect((await page.request.post(origin + '/market/api/plugins', { headers: { origin }, data: { packageName, action: 'install' } })).status()).toBe(200)
      expect((await page.request.post(origin + '/recovery/restart', { headers: { origin }, data: { confirmed: true } })).status()).toBe(200)
      await search()
      expect(received).toHaveLength(3)
      await page.getByRole('button', { name: 'Platform App Center', exact: true }).click()
      await page.getByRole('region', { name: 'Platform App Center', exact: true }).getByText('Platform shared KEY', { exact: true }).waitFor()
      const nativeProfile = JSON.parse(await readFile(join(home, '.dsh/profiles/web/package.json'), 'utf8'))
      expect(nativeProfile.dependencies?.[packageName]).toBeUndefined()
      expect((await credentialFacts()).PERSONAL_FIXTURE_KEY.source).toBe('file')
      for (const ref of refs) expect((await credentialFacts())[ref]).toEqual({ source: 'env', matchesEnvironment: true })
      expect(received.every(row => row.authorization === 'Bearer fictional-platform-secret')).toBe(true)
      expect((await (await request(`groups/${group.id}/plugins`)).json()).pendingMembers).toEqual([])
      await request('plugins/upstreams' + query, { action: 'save', upstream: { ...upstreamInput, credential: 'rotated-platform-secret' } })
      expect((await (await request(`groups/${group.id}/plugins`)).json()).pendingMembers).toEqual([])
      await search()
      expect(received.at(-1)?.authorization).toBe('Bearer rotated-platform-secret')
      await request('plugins/access' + query, { ...config, environment: [...config.environment, { name: 'SAMPLE_MODE', value: 'changed' }] })
      expect((await (await request(`groups/${group.id}/plugins`)).json()).pendingMembers).toEqual(['member'])
      const selections = JSON.stringify(await pluginChoices(runtime.dataRoot))
      expect(selections).toContain(packageName)
    } finally {
      await browser.close()
      await app.stop()
      await new CommunityRuntimeDriver(runtime).rebuild()
      await new Promise<void>(resolve => upstream.close(() => resolve()))
      await removeCommunityFixture(root)
    }
    await verifyNativePluginServiceGateway()
  },
  720000,
)

const packageName = 'qiaomu-cover-design-dsh'
const integrity = 'sha512-Lq31kbA5Dv3HijBh9jgTxvXYL7nwb0/vVHh7kSdC9mL6dP1FL8iwcPG0UQqUHIzUUzh+8sRHko+kbCXVQ51Yxw=='
const label = { en: 'Gateway fixture', 'zh-CN': '网关夹具' }
const imageUrl = 'https://127.0.0.1:49993/result.png'
const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVQIW2NgAAIAAAUAAWMrDaUAAAAASUVORK5CYII='
const backend = (id: string, protocol: CatalogPluginServiceSlot['backends'][number]['protocol'], mode: string) =>
  ({
    id,
    label,
    protocol,
    mode,
    upstream: { endpoint: 'endpoint', key: 'key', model: 'model' },
    fields: [
      { name: 'endpoint', type: 'url', required: true },
      { name: 'key', type: 'secret', required: true },
      { name: 'model', type: 'text', required: true },
    ],
  }) as const
const slots: CatalogPluginServiceSlot[] = [
  {
    id: 'chat',
    label,
    binding: {
      kind: 'revisioned-rpc',
      service: 'qiaomuCoverDesign',
      active: ['settings', 'ai'],
      selection: ['settings', 'ai', 'chatId'],
      profiles: ['settings', 'ai', 'chats'],
      idKey: 'id',
      snapshotKey: 'snap',
      maxProfiles: 100,
      fields: { endpoint: 'baseUrl', key: 'apiKey', model: 'model', mode: 'protocol' },
      empty: { preset: 'openai', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini', apiKey: '' },
    },
    backends: [{ ...backend('openai', 'openai-chat', 'openai'), profile: { preset: 'custom' } }],
  },
  {
    id: 'image',
    label,
    binding: {
      kind: 'revisioned-rpc',
      service: 'qiaomuCoverDesign',
      active: ['settings', 'ai'],
      selection: ['settings', 'ai', 'imageId'],
      profiles: ['settings', 'ai', 'images'],
      idKey: 'id',
      snapshotKey: 'snap',
      maxProfiles: 100,
      fields: { endpoint: 'imageBaseUrl', key: 'imageKey', model: 'imageModel', mode: 'imageEngine', enabled: 'imageOn' },
      empty: { imageEngine: 'api', imageBaseUrl: '', imageKey: '', imageModel: 'gpt-image-1', imageOn: false },
    },
    backends: [backend('openai', 'openai-image', 'api'), backend('seedream', 'seedream-image', 'ark')],
  },
]

async function verifyNativePluginServiceGateway() {
  assertPinnedDshRevision(runtimeSettings)
  const installed = process.env.DSH_PHALANX_INSTALL_ROOT
  if (!installed || !runtimeSettings.containerImage) throw Error('The installed candidate and real rootless container are required')
  const build = JSON.parse(await readFile(join(installed, 'build-info.json'), 'utf8'))
  expect(build).toMatchObject({ commit: process.env.DSH_PHALANX_CANDIDATE_SHA, platform: `linux/${process.arch === 'arm64' ? 'arm64' : 'amd64'}` })
  const modulePath = (path: string) => pathToFileURL(join(installed, 'dist', path + '.js')).href
  const { createCommunityApplication } = (await import(
    modulePath('composition/community-application')
  )) as typeof import('../src/composition/community-application.js')
  const { NativePluginServiceAccess } = (await import(
    modulePath('use-cases/native-plugin-service-access')
  )) as typeof import('../src/use-cases/native-plugin-service-access.js')
  const root = await mkdtemp(join(tmpdir(), 'native-service-gateway-'))
  const owned: {
    app?: ReturnType<typeof createCommunityApplication>
    runtime?: CommunityRuntimeConfig
    fixture?: Awaited<ReturnType<typeof documentSuiteCatalogFixture>>
    database?: Awaited<ReturnType<typeof openTestDatabase>>
    savedServices?: PostgresPluginAccessStore
    signingKey?: PostgresSessionKey
  } = {}
  const observed: { path: string | undefined; auth: string | undefined; body: unknown }[] = []
  const upstream = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    observed.push({ path: request.url, auth: request.headers.authorization, body })
    response.setHeader('content-type', 'application/json')
    const payload =
      request.url === '/v1/chat/completions'
        ? { choices: [{ message: { content: 'CHAT_READY' } }] }
        : body.response_format === 'url'
          ? { data: [{ url: imageUrl }] }
          : { data: [{ b64_json: image }] }
    response.end(JSON.stringify(payload))
  })
  onTestFinished(async () => {
    const outcomes = await Promise.allSettled([
      owned.app?.stop(),
      owned.fixture?.close(),
      owned.savedServices?.close(),
      owned.signingKey?.close(),
      new Promise<void>(resolve => {
        upstream.closeAllConnections()
        upstream.close(() => resolve())
      }),
    ])
    const failures = outcomes.flatMap(row => (row.status === 'rejected' ? [row.reason] : []))
    for (const clean of [
      () => owned.database?.close(),
      () => owned.runtime && new CommunityRuntimeDriver(owned.runtime).rebuild(),
      () => removeCommunityFixture(root),
    ]) {
      try {
        await clean()
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length) throw new AggregateError(failures, 'Native gateway fixture cleanup failed')
  })
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  const provider = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`
  const patch = join(root, 'tls-overlay.json')
  await writeFile(patch, JSON.stringify([{ insert: [{ id: 'native-service-tls', name: '/dsh-phalanx/home/native-service-tls.mjs' }] }]))
  const runtime: CommunityRuntimeConfig = {
    ...runtimeSection(join(root, 'platform'), provider, runtimeSettings),
    patches: [runtimeSettings.overlay, patch],
  }
  owned.runtime = runtime
  const fixture = await documentSuiteCatalogFixture(
    [
      withSuiteCatalogContentHash({
        kind: 'plugin',
        id: 'gateway-fixture',
        version: '1.0.0',
        engines: { platform: '>=0.1.35' },
        adapters: [],
        title: label,
        description: label,
        identity: label,
        source: label,
        dependencies: [],
        items: [
          {
            kind: 'plugin',
            packageName,
            version: '0.1.3',
            integrity,
            archive: { url: 'https://github.com/joeseesun/qiaomu-cover-design-dsh/releases/download/v0.1.3/qiaomu-cover-design-dsh-0.1.3.tgz' },
            runtimeDependencies: [],
            catalogDependencies: [],
            access: { environment: [], entriesYaml: '' },
            serviceSlots: slots,
          },
        ],
      }),
    ],
    new Map(),
  )
  owned.fixture = fixture
  const instances = new Map<string, CommunityUserInstance>()
  const config = withTestDatabase({
    listen: { host: '127.0.0.1', port: 0 },
    runtime,
    downloadSources: validationDownloadSelection(),
    network: { hostPublicAddresses: (process.env.DSH_PHALANX_E2E_HOST_PUBLIC_ADDRESSES ?? '').split(',').filter(Boolean) },
  })
  await seedTestSecrets({ ...config, modelGateway: { upstreamApiKey: 'fictional-default-model-key' } }, installed)
  const app = createCommunityApplication(config, {
    suiteCatalog: { address: fixture.address, trustedKeys: fixture.trustedKeys },
    pluginManager: manager => ({
      list: manager.list.bind(manager),
      remove: manager.remove.bind(manager),
      install: async (...args) => {
        instances.set(args[0].userId, args[0])
        return await manager.install(...args)
      },
    }),
  })
  owned.app = app
  let origin = '',
    admin = ''
  const form = async (path: string, fields: Record<string, string>) => {
    const response = await fetch(origin + path, {
      method: 'POST',
      redirect: 'manual',
      headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields),
    })
    expect(response.status, await response.clone().text()).toBe(303)
    return response.headers
      .getSetCookie()
      .map(value => value.split(';')[0])
      .join('; ')
  }
  const api = async (path: string, body?: object) => {
    const response = await fetch(origin + '/admin/api/' + path, {
      method: body ? 'POST' : 'GET',
      headers: { cookie: admin, origin, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    expect(response.ok, await response.clone().text()).toBe(true)
    return response.json()
  }
  origin = await app.start()
  admin = await form('/bootstrap', { credential: readBootstrapCredential(runtime.dataRoot)!.credential, username: 'admin', password: 'password' })
  const member = await api('accounts', { username: 'member', password: 'password', email: '' })
  const features = `groups/${member.groupId}/native-features`
  const nativeFeatures = await api(features)
  await api(features, {
    revision: nativeFeatures.revision,
    disabledIds: [],
    showAppCenter: true,
  })
  const catalog = await api('suites')
  expect(catalog.source).toMatchObject({ status: 'ok' })
  expect(catalog.entries).toContainEqual(expect.objectContaining({ id: 'gateway-fixture', available: true }))
  await api('suites', { action: 'install', input: { id: 'gateway-fixture', requestId: 'native-gateway-fixture-install', publish: false } })
  const installation = async () => (await api('suites')).installations.find((row: { id: string }) => row.id === 'gateway-fixture')
  await expect.poll(async () => (await installation())?.status, { timeout: 240000 }).toMatch(/^(installed|failed)$/u)
  const installedSuite = await installation()
  expect(installedSuite.status, JSON.stringify({ code: installedSuite.failureCode, log: installedSuite.log })).toBe('installed')
  await api('plugins/publication', { action: 'publish', packageName, published: true, confirmed: true })
  const services = 'plugins/services?packageName=' + packageName
  const configure = async (change: object) => {
    const current = await api(services)
    return await api(services, { revision: current.revision, change })
  }
  for (const [slot, name, suffix] of [
    ['chat', 'openai', 'v1'],
    ['image', 'openai', 'v1'],
    ['image', 'seedream', 'v3'],
  ] as const) {
    await configure({
      action: 'save',
      slot,
      backend: name,
      values: { endpoint: provider + '/' + suffix, key: `fictional-${slot}-${name}`, model: `fixture-${slot}-${name}` },
    })
  }
  const home = join(await memberSpacePath(runtime.dataRoot, 'member'), 'home')
  await mkdir(home, { recursive: true, mode: 0o700 })
  const tlsKey = join(home, 'native-service-key.pem'),
    tlsCert = join(home, 'native-service-cert.pem')
  await execFileText('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '1',
    '-subj',
    '/CN=127.0.0.1',
    '-addext',
    'subjectAltName=IP:127.0.0.1',
    '-keyout',
    tlsKey,
    '-out',
    tlsCert,
  ])
  await writeFile(
    join(home, 'native-service-tls.mjs'),
    `
import { createServer } from 'node:https'
import { readFileSync } from 'node:fs'
import { getCACertificates, setDefaultCACertificates } from 'node:tls'
const cert = readFileSync(new URL('./native-service-cert.pem', import.meta.url), 'utf8')
const key = readFileSync(new URL('./native-service-key.pem', import.meta.url), 'utf8')
export const name = 'native-service-tls'
export function apply(ctx) {
  setDefaultCACertificates([...getCACertificates('default'), cert])
  const server = createServer({ cert, key }, (request, response) => {
    if (request.method !== 'GET' || request.url !== '/result.png' || request.headers.authorization || request.headers.cookie) return response.writeHead(403).end()
    response.writeHead(200, { 'content-type': 'image/png' }).end(Buffer.from(${JSON.stringify(image)}, 'base64'))
  }).listen(49993, '127.0.0.1')
  ctx.effect(() => () => server.close())
}
`,
  )
  const platformCookie = await form('/login', { username: 'member', password: 'password' })
  let { cookie } = await openCommunityHttpEntry(origin, platformCookie, 180000)
  const market = await fetch(origin + '/market/api/plugins', {
    method: 'POST',
    headers: { cookie, origin, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'install', packageName, requestId: 'fixture-native-copy' }),
  })
  expect(market.status, await market.clone().text()).toBe(202)
  const database = await openTestDatabase(runtime.dataRoot, installed)
  owned.database = database
  const accounts = new PostgresCommunityAccountStore(database),
    records = new PostgresPluginInstallations(database)
  const savedServices = new PostgresPluginAccessStore(database),
    signingKey = new PostgresSessionKey(database)
  owned.savedServices = savedServices
  owned.signingKey = signingKey
  await savedServices.initialize()
  await signingKey.initialize()
  const actor = (await accounts.get('member'))!
  await expect
    .poll(async () => (await records.get(actor.spaceId)).find(row => row.packageName === packageName), { timeout: 180000 })
    .toMatchObject({ source: 'selected', integrity, serviceOrigin: expect.any(String) })
  const instance = instances.get('member')!
  const access = new NativePluginServiceAccess({
    accounts,
    installations: records,
    services: savedServices,
    signingKey,
    library: new PostgresPluginLibraryStore(database),
    grants: new PostgresPluginGrants(database),
    manager: new NativeMemberPluginManager(runtime),
    runtime: { status: () => ({ state: 'ready', instance }) },
    origin: () => new URL(origin),
    gatewayOrigin: () => new URL(`http://127.0.0.1:${runtime.container!.gatewayPort}`),
    runtimeRevision: declaredRuntimeRevision(),
    revision: () => 'fixture-read',
  })
  const rpc = createRealDshRpc()
  const request = (url: string, init: object = {}) =>
    rpc.remoteRpc<{ status: number; base64: string }>(origin, cookie, 'qiaomuCoverDesign/request', { request: { url, ...init } })
  const setupView = async () => (await fetch(origin + '/market/api/plugins/setup', { headers: { cookie } })).json()
  const retrySetup = async () => {
    const response = await fetch(origin + '/market/api/plugins/setup', {
      method: 'POST',
      headers: { cookie, origin, 'content-type': 'application/json' },
      body: JSON.stringify({ packageName, action: 'retry-settings' }),
    })
    expect(response.status, await response.clone().text()).toBe(200)
  }
  const load = () =>
    rpc.remoteRpc<{ revision: number; data: { settings: { ai: Record<string, unknown> }; workspace: { activeFile: string } } }>(
      origin,
      cookie,
      'qiaomuCoverDesign/load',
      {},
    )
  await expect.poll(setupView, { timeout: 120000 }).toMatchObject({
    nativeServices: [
      {
        packageName,
        bindings: [
          { slot: 'chat', status: 'inactive' },
          { slot: 'image', status: 'inactive' },
        ],
      },
    ],
  })
  const blank = await load()
  const originalDefaults: Record<string, unknown> = {
    ...slots[0]!.binding.empty,
    ...slots[1]!.binding.empty,
    chats: [],
    chatId: '',
    images: [],
    imageId: '',
  }
  const save = (revision: number, ai: Record<string, unknown>) =>
    rpc.remoteRpc(origin, cookie, 'qiaomuCoverDesign/save', {
      request: { revision, data: { settings: { ai }, workspace: { activeFile: 'kept.cover', openFiles: ['kept.cover'] } } },
    })
  await save(blank.revision, { ...originalDefaults, model: 'unprofiled-personal-model' })
  await configure({ action: 'enable', slot: 'chat', backend: 'openai' })
  await configure({ action: 'enable', slot: 'image', backend: 'openai' })
  await retrySetup()
  expect(await setupView()).toMatchObject({
    nativeServices: [
      {
        packageName,
        bindings: [
          { slot: 'chat', status: 'conflict' },
          { slot: 'image', status: 'applied' },
        ],
      },
    ],
  })
  const conflicted = await load()
  expect(conflicted.data).toMatchObject({ settings: { ai: { model: 'unprofiled-personal-model' } }, workspace: { activeFile: 'kept.cover' } })
  expect((await records.get(actor.spaceId)).filter(row => row.packageName === packageName)).toHaveLength(1)
  await save(conflicted.revision, { ...conflicted.data.settings.ai, model: originalDefaults.model })
  await retrySetup()
  await expect.poll(setupView, { timeout: 120000 }).toMatchObject({
    nativeServices: [
      {
        packageName,
        bindings: [
          { slot: 'chat', status: 'applied' },
          { slot: 'image', status: 'applied' },
        ],
      },
    ],
  })
  const initial = await load()
  const ai = initial.data.settings.ai
  expect(ai).toMatchObject({
    chatId: expect.stringMatching(/^platform-/u),
    imageId: expect.stringMatching(/^platform-/u),
    apiKey: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
    imageKey: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
    model: 'fixture-chat-openai',
    imageModel: 'fixture-image-openai',
    imageOn: true,
  })
  expect(JSON.stringify(ai)).not.toContain('fictional-')
  const personal = { baseUrl: 'https://personal.example/v1', apiKey: 'personal-test-key', model: 'personal-model', protocol: 'openai', preset: 'custom' }
  const profiles = ai.chats as unknown[]
  const data = {
    ...initial.data,
    settings: {
      ...initial.data.settings,
      ai: { ...ai, ...personal, chatId: 'member-personal', chats: [...profiles, { id: 'member-personal', snap: personal }] },
    },
    workspace: { ...initial.data.workspace, activeFile: 'personal.cover' },
  }
  await rpc.remoteRpc(origin, cookie, 'qiaomuCoverDesign/save', { request: { revision: initial.revision, data } })
  const grants = new Map<string, Awaited<ReturnType<typeof access.issue>>>()
  const issue = async (slot: string, name: string) => {
    grants.set(`${slot}-${name}`, await access.issue(actor, instance, packageName, slot, name, AbortSignal.timeout(15000)))
  }
  await issue('chat', 'openai')
  await issue('image', 'openai')
  const call = (slot: string, name: string, extra: object) => {
    const grant = grants.get(`${slot}-${name}`)!
    return request(grant.url + (slot === 'chat' ? '/chat/completions' : '/images/generations'), {
      method: 'POST',
      headers: { authorization: 'Bearer ' + grant.token },
      contentType: 'application/json',
      body: JSON.stringify({ model: grant.model, ...extra }),
    })
  }
  const json = ({ base64 }: { base64: string }) => JSON.parse(Buffer.from(base64, 'base64').toString())
  const chat = await call('chat', 'openai', { messages: [{ role: 'user', content: 'ping' }] })
  expect(chat.status).toBe(200)
  expect(json(chat)).toEqual({ choices: [{ message: { content: 'CHAT_READY' } }] })
  const base64 = await call('image', 'openai', { prompt: 'draw', n: 1, size: '1024x1024' })
  expect(json(base64)).toEqual({ data: [{ b64_json: image }] })
  await configure({ action: 'enable', slot: 'image', backend: 'seedream' })
  expect(await setupView()).toMatchObject({ nativeServices: [{ bindings: [expect.anything(), { slot: 'image', status: 'pending' }] }] })
  await retrySetup()
  expect((await load()).data).toMatchObject({
    settings: { ai: { ...personal, chatId: 'member-personal', imageEngine: 'ark', imageModel: 'fixture-image-seedream' } },
    workspace: { activeFile: 'personal.cover' },
  })
  expect((await call('image', 'openai', { prompt: 'inactive backend' })).status).toBe(503)
  await issue('image', 'seedream')
  expect(json(await call('image', 'seedream', { prompt: 'draw from text', response_format: 'b64_json' }))).toEqual({ data: [{ b64_json: image }] })
  const reference = `data:image/png;base64,${image}`
  const generated = await call('image', 'seedream', { prompt: 'draw with reference', image: [reference], response_format: 'url' })
  expect(generated.status).toBe(200)
  const downloaded = await request(json(generated).data[0].url)
  expect(downloaded).toMatchObject({ status: 200, base64: image })
  expect(observed).toMatchObject([
    { path: '/v1/chat/completions', auth: 'Bearer fictional-chat-openai', body: { model: 'fixture-chat-openai' } },
    { path: '/v1/images/generations', auth: 'Bearer fictional-image-openai', body: { model: 'fixture-image-openai' } },
    { path: '/v3/images/generations', auth: 'Bearer fictional-image-seedream', body: { prompt: 'draw from text' } },
    { path: '/v3/images/generations', auth: 'Bearer fictional-image-seedream', body: { image: [reference] } },
  ])
  await configure({ action: 'save', slot: 'image', backend: 'seedream', values: { key: 'fictional-image-seedream-rotated' } })
  expect((await call('image', 'seedream', { prompt: 'same instance after rotation' })).status).toBe(200)
  expect(observed.at(-1)).toMatchObject({ auth: 'Bearer fictional-image-seedream-rotated' })
  const previousGrant = grants.get('image-seedream')!
  const restart = await fetch(origin + '/recovery/restart', {
    method: 'POST',
    headers: { cookie, origin, 'content-type': 'application/json' },
    body: JSON.stringify({ confirmed: true }),
  })
  expect(restart.status, await restart.clone().text()).toBe(200)
  cookie = (await openCommunityHttpEntry(origin, platformCookie, 180000)).cookie
  const afterRestart = await load()
  expect(afterRestart.data).toMatchObject({
    settings: { ai: { ...personal, chatId: 'member-personal', imageEngine: 'ark', imageModel: previousGrant.model } },
    workspace: { activeFile: 'personal.cover' },
  })
  const refreshed = afterRestart.data.settings.ai
  expect(refreshed.imageKey).toEqual(expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u))
  expect(refreshed.imageKey).not.toBe(previousGrant.token)
  expect((await call('image', 'seedream', { prompt: 'retired carrier token' })).status).toBe(401)
  grants.set('image-seedream', { ...previousGrant, token: String(refreshed.imageKey), url: String(refreshed.imageBaseUrl) })
  expect((await call('image', 'seedream', { prompt: 'refreshed carrier token' })).status).toBe(200)
  expect(observed.at(-1)).toMatchObject({ auth: 'Bearer fictional-image-seedream-rotated' })

  // An installed catalog can move to another exact archive before the member chooses an update.
  const currentServices = (await savedServices.installedServices(packageName))!
  const { serviceOrigin } = (await records.get(actor.spaceId)).find(row => row.packageName === packageName)!
  expect(serviceOrigin).toMatch(/^suite:/u)
  const nextIntegrity = 'sha512-' + createHash('sha512').update('different-checked-archive').digest('base64')
  await savedServices.saveInstalledServices(
    packageName,
    serviceOrigin!,
    { ...currentServices.configuration, ownerVersion: nextIntegrity },
    currentServices.revision,
  )
  await retrySetup()
  expect(await setupView()).toMatchObject({ nativeServices: [{ bindings: [{ status: 'unsupported' }] }] })
  expect((await load()).data).toEqual(afterRestart.data)
  const changedServices = (await savedServices.installedServices(packageName))!
  await savedServices.saveInstalledServices(packageName, serviceOrigin!, currentServices.configuration, changedServices.revision)
  await retrySetup()
  const group = `groups/${member.groupId}/plugins`
  const preinstall = async (preinstalls: string[]) => await api(group, { action: 'save', revision: (await api(group)).revision, packages: [], preinstalls })
  await preinstall([packageName])
  await api('plugins/publication', { action: 'publish', packageName, published: false, confirmed: true, selectedMembers: 0 })
  expect((await call('image', 'seedream', { prompt: 'preinstall source remains' })).status).toBe(200)
  await preinstall([])
  expect(await setupView()).toMatchObject({
    nativeServices: [
      {
        bindings: [
          { slot: 'chat', status: 'inactive' },
          { slot: 'image', status: 'inactive' },
        ],
      },
    ],
  })
  expect((await load()).data.settings.ai).toMatchObject(personal)
  expect((await call('image', 'seedream', { prompt: 'all sources withdrawn' })).status).toBe(403)
  expect(observed).toHaveLength(7)
  const removed = await rpc.remoteRpc<{ application: string }>(origin, cookie, 'pluginManager/removeBundle', { name: packageName })
  expect(['applied', 'restart-required']).toContain(removed.application)
  const cachedArchive = `${MEMBER_PLUGIN_ARCHIVE_DIRECTORY}/${Buffer.from(integrity.slice(7), 'base64').toString('hex')}.tgz`
  expect(await rpc.remoteRpcResult(origin, cookie, 'pluginManager/installBundle', { spec: cachedArchive })).toMatchObject({
    ok: false,
    error: { code: 'remote-access/denied', message: 'Install this platform archive through the App Center.' },
  })

  await preinstall([packageName])
  const next = await api('accounts', { username: 'preinstalled-member', password: 'password', email: '' })
  expect(next.groupId).toBe(member.groupId)
  await api(features, { revision: (await api(features)).revision, disabledIds: [], showAppCenter: false })
  const nextHome = join(await memberSpacePath(runtime.dataRoot, 'preinstalled-member'), 'home')
  await mkdir(nextHome, { recursive: true, mode: 0o700 })
  for (const name of ['native-service-tls.mjs', 'native-service-key.pem', 'native-service-cert.pem']) await copyFile(join(home, name), join(nextHome, name))
  const groupSession = await form('/login', { username: 'preinstalled-member', password: 'password' })
  const [entry, parallel] = await Promise.all([openCommunityHttpEntry(origin, groupSession, 180000), openCommunityHttpEntry(origin, groupSession, 180000)])
  for (const { cookie } of [entry, parallel]) {
    const state = await rpc.remoteRpc<{ data: { settings: { ai: object } } }>(origin, cookie, 'qiaomuCoverDesign/load', {})
    expect(state.data.settings.ai).toMatchObject({
      chatId: expect.stringMatching(/^platform-/u),
      imageId: expect.stringMatching(/^platform-/u),
      model: 'fixture-chat-openai',
      imageModel: 'fixture-image-seedream',
    })
    const setup = await fetch(origin + '/market/api/plugins/setup', { headers: { cookie } })
    expect(await setup.json()).toMatchObject({
      nativeServices: [
        {
          packageName,
          bindings: [
            { slot: 'chat', status: 'applied' },
            { slot: 'image', status: 'applied' },
          ],
        },
      ],
    })
  }
  const nextAccount = (await accounts.get('preinstalled-member'))!
  expect((await records.get(nextAccount.spaceId)).filter(row => row.packageName === packageName)).toMatchObject([
    { source: 'preinstall', integrity, serviceOrigin: expect.any(String) },
  ])
  await assertLegacyNativeServiceCopy({ origin, nextAccount, packageName, integrity, records, entry, groupSession, preinstall, api })
}
