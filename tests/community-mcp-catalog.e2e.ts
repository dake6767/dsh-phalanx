// Validation: T1; real credentials: none; controlled browser/process fixtures. CI selects its explicit public-entry subset.
import { createProxyServer } from 'http-proxy-3'
import { mkdtemp } from 'node:fs/promises'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { loopbackPort } from '../src/adapters/loopback-port.js'
import { NodePluginUpstreamTransport } from '../src/adapters/plugin-upstream-transport.js'
import { withSuiteCatalogContentHash } from '../src/domain/suite-catalog-document.js'
import { onlineCatalogEntries } from './fixtures/suite-catalog-online.js'
import { signedMcpEntries } from './fixtures/mcp-catalog-online.js'
import { createCatalogSigningKey, signRawCatalog } from './fixtures/suite-catalog-signing.js'
import { removeCommunityFixture } from './fixtures/owned-cleanup.js'
import { createCommunityApplication, modelAccessToken, openTestAccounts } from './support/community-application.js'
import { selectBuiltinDatabase } from './support/community-bootstrap-browser.js'

it('imports optional credentials and applies their edits and catalog updates to real HTTP requests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-optional-ui-'))
  const observed: { path: string; authorization?: string; key: string | null }[] = []
  let holdProbe: Promise<void> | undefined
  let probeStarted = false
  const upstream = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const authorization = request.headers.authorization
    observed.push({ path: url.pathname, ...(authorization === undefined ? {} : { authorization }), key: url.searchParams.get('key') })
    const chunks: Uint8Array[] = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { method: string; id?: number }
    if (holdProbe && body.method === 'initialize') {
      probeStarted = true
      await holdProbe
    }
    if (body.id === undefined) {
      response.writeHead(202).end()
      return
    }
    const result =
      body.method === 'initialize'
        ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'optional-fixture', version: '1' } }
        : body.method === 'tools/list'
          ? { tools: [{ name: 'read', inputSchema: { type: 'object' } }] }
          : { echo: authorization ?? url.searchParams.get('key') ?? 'anonymous' }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }))
  })
  const signingKey = createCatalogSigningKey()
  let optionalVersion = '1.0.0'
  const keyLabel = { en: 'Docs key', 'zh-CN': '文档密钥' }
  const header = { label: keyLabel, in: 'headers', name: 'Authorization', template: 'Bearer {credential}' }
  const entry = (id: string, name: string, version: string, url: string, credential?: object) => {
    const title = { en: name, 'zh-CN': name }
    return withSuiteCatalogContentHash({
      kind: 'mcp',
      id,
      version,
      engines: { platform: '>=0.1.44' },
      title,
      description: title,
      source: title,
      documentation: 'https://docs.example.test/manual',
      adapters: [{ name: 'mcp-remote-http', params: { url, ...(credential ? { credential } : {}) } }],
    })
  }
  const catalog = createServer((_request, response) =>
    response.end(
      signRawCatalog(
        {
          format: 1,
          publishedAt: '2026-11-25T00:00:00Z',
          entries: [
            entry('public-docs', 'Public Docs', '1.0.0', 'https://docs.example.test/public'),
            entry('required-docs', 'Required Docs', '1.0.0', 'https://docs.example.test/required', header),
            entry(
              'optional-docs',
              'Optional Docs',
              optionalVersion,
              optionalVersion === '2.0.0' ? 'https://updated.example.test/docs/2.0.0' : `https://docs.example.test/docs/${optionalVersion}`,
              optionalVersion === '2.0.0'
                ? { label: keyLabel, in: 'query', name: 'key', template: '{credential}', optional: true }
                : { ...header, optional: true },
            ),
          ],
        },
        signingKey,
      ),
    ),
  )
  const listen = async (server: typeof upstream) => {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    return `http://127.0.0.1:${(server.address() as { port: number }).port}`
  }
  const upstreamOrigin = await listen(upstream)
  const catalogOrigin = await listen(catalog)
  const transport = new NodePluginUpstreamTransport('idle')
  const app = createCommunityApplication(
    {
      listen: { host: '127.0.0.1', port: 0 },
      sessionSecret: 'optional-mcp-fixture-session-secret',
      runtime: {
        command: '/unavailable',
        args: [],
        dataRoot: root,
        defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'https://example.test' } },
      },
    },
    {
      suiteCatalog: { address: catalogOrigin + '/catalog.json', trustedKeys: [signingKey] },
      mcpTransport: {
        send: input => {
          const url = new URL(input.upstream.baseUrl)
          if (!['docs.example.test', 'updated.example.test'].includes(url.hostname)) throw new Error('Unexpected fixture upstream')
          return transport.send({ ...input, upstream: { ...input.upstream, baseUrl: upstreamOrigin + url.pathname + url.search } })
        },
      },
    },
  )
  const browser = await chromium.launch({ headless: true })
  try {
    const accounts = await openTestAccounts(root)
    const spaceId = await (async () => {
      try {
        await accounts.createFirstAdmin({ username: 'admin', email: 'admin@example.test', password: 'password' })
        return (await accounts.create({ username: 'member', email: 'member@example.test', password: 'password' })).spaceId
      } finally {
        await accounts.close()
      }
    })()
    const token = await modelAccessToken(root, 'member', spaceId)
    const origin = await app.start()
    const page = await browser.newPage({ locale: 'en' })
    page.setDefaultTimeout(15000)
    const login = (browserPage: typeof page, username: string) =>
      browserPage.request.post(origin + '/login', { headers: { origin }, form: { username, password: 'password' }, maxRedirects: 0 })
    expect((await login(page, 'admin')).status()).toBe(303)
    await page.goto(origin + '/admin/mcp')
    const openCatalog = () => page.getByRole('tab', { name: 'MCP catalog', exact: true }).click()
    const openEntry = async (title: string) => {
      await page.getByRole('button', { name: `View MCP service ${title}`, exact: true }).click()
      return page.getByRole('dialog', { name: title, exact: true })
    }
    const importButton = () => page.getByRole('button', { name: 'Import MCP service', exact: true })
    const row = (name: string) => page.locator('.mcp-service-card').filter({ has: page.getByText(name, { exact: true }) })
    const ready = (name: string) => row(name).getByText('Import ready', { exact: true }).waitFor()
    const edit = async (name: string) => {
      await row(name).getByRole('button', { name: 'Edit', exact: true }).click()
      await page.getByRole('tab', { name: 'Access settings', exact: true }).click()
    }
    const platformKey = () => page.getByLabel('Platform credential', { exact: true })
    await openCatalog()
    for (const label of ['Docs key (Optional)', 'Docs key (Required)', 'No credential required']) await page.getByText(label, { exact: true }).waitFor()
    const required = await openEntry('Required Docs')
    expect(await importButton().isDisabled()).toBe(true)
    await required.getByRole('button', { name: 'Cancel', exact: true }).click()
    const open = await openEntry('Public Docs')
    await open.getByText('No credential required', { exact: true }).waitFor()
    await importButton().click()
    await ready('p-public-docs')
    await edit('p-public-docs')
    expect(await platformKey().count()).toBe(0)
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()

    const name = 'p-optional-docs'
    await openCatalog()
    const optional = await openEntry('Optional Docs')
    await optional.getByText('You can import without a credential and add one later in Access settings.', { exact: true }).waitFor()
    expect(await importButton().isEnabled()).toBe(true)
    await importButton().click()
    await ready(name)
    expect(observed.at(-1)).toEqual({ path: '/docs/1.0.0', key: null })
    await openCatalog()
    await openEntry('Optional Docs')
    await page.getByLabel('MCP service name', { exact: true }).fill('p-optional-keyed')
    await page.getByLabel('Docs key', { exact: true }).fill('fictional-import-key')
    await importButton().click()
    await ready('p-optional-keyed')
    expect(observed.at(-1)).toEqual({ path: '/docs/1.0.0', authorization: 'Bearer fictional-import-key', key: null })

    const publish = async (target: string) => {
      await row(target).getByRole('button', { name: 'Edit', exact: true }).click()
      await page.getByRole('button', { name: 'Publish MCP service', exact: true }).click()
      await page.getByRole('dialog', { name: 'Confirm MCP publication', exact: true }).getByRole('button', { name: 'Confirm', exact: true }).click()
      await page.getByRole('button', { name: 'Unpublish MCP service', exact: true }).waitFor()
      await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    }
    await publish(name)
    const member = await browser.newPage({ locale: 'en' })
    expect((await login(member, 'member')).status()).toBe(303)
    const enable = async (target: string) => {
      expect((await member.request.post(origin + '/market/api/mcp', { headers: { origin }, data: { name: target, action: 'enable' } })).status()).toBe(200)
    }
    await enable(name)
    const ping = async (target = name) => {
      const result = await member.request.post(origin + '/mcp/' + target, {
        headers: { authorization: `Bearer ${token}` },
        data: { jsonrpc: '2.0', id: 1, method: 'ping' },
      })
      expect(result.status()).toBe(200)
      return await result.json()
    }
    const preview = async (version: string, target = name) => {
      optionalVersion = version
      await page.reload()
      await row(target).getByRole('button', { name: 'Review catalog update', exact: true }).click()
      return page.getByRole('dialog', { name: 'Review catalog update', exact: true })
    }
    const saveUpdate = async (version: string, target = name, published = true) => {
      await page.getByRole('button', { name: 'Validate and update', exact: true }).click()
      await page.getByRole('dialog', { name: 'Review catalog update', exact: true }).waitFor({ state: 'hidden' })
      await expect
        .poll(
          async () => {
            const settings = (await (
              await page.request.get(origin + '/admin/api/mcp')
            ).json()) as import('../src/domain/admin-contract.js').CommunityMcpSettings[]
            const current = settings.find(service => service.name === target)
            return [current?.catalog?.version, current?.catalogUpdate?.status, current?.published]
          },
          { timeout: 15000 },
        )
        .toEqual([version, 'applied', published])
      await row(target).getByText('Catalog update applied', { exact: true }).waitFor()
    }
    const sameBinding = await preview('1.1.0')
    await sameBinding.getByText('Leave blank to continue without a credential.', { exact: true }).waitFor()
    await saveUpdate('1.1.0')
    expect(await ping()).toMatchObject({ result: { echo: 'anonymous' } })
    expect(observed.at(-1)).toEqual({ path: '/docs/1.1.0', key: null })
    const saveKey = async (value: string) => {
      await edit(name)
      if (value) await platformKey().fill(value)
      else await page.getByRole('button', { name: 'Clear saved credential', exact: true }).click()
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      await platformKey().waitFor({ state: 'hidden' })
    }
    for (const key of ['fictional-later-key', 'fictional-rotated-key']) {
      await saveKey(key)
      expect(await ping()).toMatchObject({ result: { echo: '[redacted]' } })
      expect(observed.at(-1)).toEqual({ path: '/docs/1.1.0', authorization: `Bearer ${key}`, key: null })
    }
    await saveKey('')
    expect(await ping()).toMatchObject({ result: { echo: 'anonymous' } })
    expect(observed.at(-1)).toEqual({ path: '/docs/1.1.0', key: null })
    await saveKey('fictional-retired-key')
    const changedBinding = await preview('2.0.0')
    await changedBinding
      .getByText('The saved credential cannot be reused with the updated connection. Leave blank to continue without it.', { exact: true })
      .waitFor()
    await saveUpdate('2.0.0')
    expect(await ping()).toMatchObject({ result: { echo: 'anonymous' } })
    expect(observed.at(-1)).toEqual({ path: '/docs/2.0.0', key: null })
    await saveKey('fictional-query-key')
    expect(await ping()).toMatchObject({ result: { echo: '[redacted]' } })
    expect(observed.at(-1)).toEqual({ path: '/docs/2.0.0', key: 'fictional-query-key' })

    const keyed = await preview('2.0.0', 'p-optional-keyed')
    await keyed.getByText('The saved credential cannot be reused with the updated connection. Leave blank to continue without it.', { exact: true }).waitFor()
    await platformKey().fill('fictional-update-key')
    await saveUpdate('2.0.0', 'p-optional-keyed', false)
    expect(observed.at(-1)).toEqual({ path: '/docs/2.0.0', key: 'fictional-update-key' })
    await publish('p-optional-keyed')
    await enable('p-optional-keyed')
    expect(await ping('p-optional-keyed')).toMatchObject({ result: { echo: '[redacted]' } })
    expect(observed.at(-1)).toEqual({ path: '/docs/2.0.0', key: 'fictional-update-key' })

    await edit(name)
    await page.getByRole('button', { name: 'Clear saved credential', exact: true }).click()
    await page.getByRole('tab', { name: 'MCP tools', exact: true }).click()
    let releaseProbe!: () => void
    holdProbe = new Promise<void>(resolve => {
      releaseProbe = resolve
    })
    const test = page.getByRole('button', { name: 'Test connection', exact: true })
    try {
      await test.click()
      await expect.poll(() => probeStarted, { timeout: 5000 }).toBe(true)
      expect(await ping()).toMatchObject({ result: { echo: 'anonymous' } })
      expect(observed.at(-1)).toEqual({ path: '/docs/2.0.0', key: null })
    } finally {
      holdProbe = undefined
      releaseProbe()
    }
    await test.waitFor()
    await page.getByText('MCP connection passed.', { exact: true }).waitFor()
  } finally {
    await browser.close()
    await app.stop()
    for (const server of [catalog, upstream]) {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
    await removeCommunityFixture(root)
  }
}, 120000)

it('imports a preset through the skill-pack style market, persists failure, retries and locks connection settings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-catalog-ui-'))
  const port = await loopbackPort(),
    origin = `http://phalanx.example.test:${port}`
  const signingKey = createCatalogSigningKey()
  let entryVersion = '1.0.0',
    catalogOnline = true
  const suite = onlineCatalogEntries.find(row => row.id === 'wecom')!
  const label = { en: 'Fixture plugin', 'zh-CN': '夹具插件' }
  const plugin = withSuiteCatalogContentHash({
    kind: 'plugin',
    id: 'fixture-plugin',
    version: '1.0.0',
    engines: { platform: '>=0.1.37' },
    adapters: [],
    dependencies: [],
    title: label,
    description: label,
    source: label,
    identity: label,
    items: [],
  })
  let classified = true,
    includeTravel = true
  const tags = {
    tags: [
      { id: 'travel', label: { en: 'Travel', 'zh-CN': '出行' } },
      { id: 'maps', label: { en: 'Maps', 'zh-CN': '地图' } },
      { id: 'collaboration', label: { en: 'Collaboration', 'zh-CN': '协作' } },
      { id: 'editing', label: { en: 'Editing', 'zh-CN': '编辑' } },
    ],
    assignments: [
      { kind: 'mcp', id: 'amap', tags: ['maps', 'travel'] },
      { kind: 'suite', id: suite.id, tags: ['collaboration'] },
      { kind: 'plugin', id: plugin.id, tags: ['editing'] },
    ],
  }
  const catalogServer = createServer((_request, response) => {
    if (!catalogOnline) {
      response.writeHead(503).end()
      return
    }
    response.end(
      signRawCatalog(
        {
          format: 1,
          publishedAt: '2026-11-17T00:00:00Z',
          entries: [...signedMcpEntries(entryVersion), suite, plugin],
          ...(classified
            ? {
                galleryTags: includeTravel
                  ? tags
                  : {
                      tags: tags.tags.filter(tag => tag.id !== 'travel'),
                      assignments: tags.assignments.map(row => ({ ...row, tags: row.tags.filter(tag => tag !== 'travel') })),
                    },
              }
            : {}),
        },
        signingKey,
      ),
    )
  })
  await new Promise<void>(resolve => catalogServer.listen(0, '127.0.0.1', resolve))
  const catalogPort = (catalogServer.address() as { port: number }).port
  let fail = true,
    authenticated = true
  const app = createCommunityApplication(
    {
      listen: { host: '127.0.0.1', port, publicOrigin: origin },
      sessionSecret: 'catalog-fixture-session-secret-32',
      runtime: {
        command: '/unavailable',
        args: [],
        dataRoot: root,
        defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'https://example.test' } },
      },
    },
    {
      suiteCatalog: { address: `http://127.0.0.1:${catalogPort}/catalog.json`, trustedKeys: [signingKey] },
      mcpTransport: {
        send: async input => {
          const target = new URL(input.upstream.baseUrl)
          authenticated &&= target.origin === 'https://mcp.amap.com' && target.searchParams.get('key') === 'fixture-key'
          if (input.method === 'DELETE') return new Response(null, { status: 204 })
          const body = await new Response(input.body).json()
          if (body.method === 'notifications/initialized') return new Response(null, { status: 202 })
          if (fail) return new Response('private upstream failure', { status: 403 })
          const result =
            body.method === 'initialize'
              ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
              : { tools: [{ name: 'maps_weather', inputSchema: { type: 'object' } }] }
          return Response.json({ jsonrpc: '2.0', id: body.id, result })
        },
      },
    },
  )
  const proxy = createProxyServer({ target: `http://127.0.0.1:${port}` })
  proxy.on('error', (_error, _request, response) => response.destroy())
  const forwarder = createServer((request, response) => proxy.web(request, response))
  forwarder.on('connect', (_request, socket, head) => {
    const target = connect(port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      target.write(head)
      socket.pipe(target)
      target.pipe(socket)
    })
    target.on('error', () => socket.destroy())
    socket.on('error', () => target.destroy())
    socket.on('close', () => target.destroy())
  })
  await new Promise<void>(resolve => forwarder.listen(0, '127.0.0.1', resolve))
  const address = forwarder.address()
  if (!address || typeof address === 'string') throw new Error('HTTP fixture did not listen')
  const browser = await chromium.launch({ headless: true, proxy: { server: `http://127.0.0.1:${address.port}` } })
  try {
    await app.start()
    const page = await browser.newPage({ locale: 'en', viewport: { width: 1440, height: 1000 } })
    if (process.env.DSH_PHALANX_E2E_CPU_THROTTLE)
      await (await page.context().newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.DSH_PHALANX_E2E_CPU_THROTTLE) })
    page.setDefaultTimeout(15000)
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`${origin}/bootstrap#credential=${readBootstrapCredential(root)!.credential}`)
    await selectBuiltinDatabase(page)
    expect(await page.evaluate(() => ({ secure: isSecureContext, uuid: typeof crypto.randomUUID }))).toEqual({ secure: false, uuid: 'undefined' })
    await page.getByLabel('Username', { exact: true }).fill('admin')
    await page.getByLabel('Password', { exact: true }).fill('password')
    await page.getByRole('button', { name: 'Create administrator' }).click()
    await page.getByRole('button', { name: /^(Skip for now and finish installation|暂时跳过，完成安装)$/u }).click()
    await page.waitForURL(`${origin}/admin`)
    for (const gallery of [
      { path: 'skills', label: 'Collaboration', excluded: 'Editing', name: 'WeCom' },
      { path: 'plugins', label: 'Editing', excluded: 'Collaboration', name: 'Fixture plugin' },
    ]) {
      await page.goto(`${origin}/admin/${gallery.path}`)
      const reply = page.waitForResponse(response => response.url() === origin + '/admin/api/suites')
      await page.getByRole('tab', { name: gallery.path === 'skills' ? 'Skill catalog' : 'Plugin catalog', exact: true }).click()
      const loaded = await reply
      expect(loaded.status()).toBe(200)
      expect(await loaded.json()).toMatchObject({ source: { status: 'ok' }, galleryTags: tags })
      const galleryFilters = page.getByRole('group', { name: 'Filter by tag', exact: true })
      await galleryFilters.getByRole('button', { name: 'All entries', pressed: true }).waitFor()
      expect(await galleryFilters.getByRole('button', { name: gallery.excluded, exact: true }).count()).toBe(0)
      await galleryFilters.getByRole('button', { name: gallery.label, exact: true }).click()
      expect(await galleryFilters.getByRole('button', { pressed: true }).allTextContents()).toEqual([gallery.label])
      const hit = page.getByRole('button', { name: `View catalog entry ${gallery.name}`, exact: true })
      await hit.waitFor()
      await page.getByLabel('Search catalog').fill('unmatched fixture')
      await page.getByText('No matching catalog entries.').waitFor()
      await page.getByRole('button', { name: 'Clear filters' }).click()
      await hit.waitFor()
    }
    await page.getByRole('link', { name: 'MCP library', exact: true }).click()
    await page.getByRole('tab', { name: 'MCP catalog', exact: true }).click()
    const preset = page.getByRole('button', { name: 'View MCP service Amap', exact: true })
    const trains = page.getByRole('button', { name: 'View MCP service 12306', exact: true })
    const mcpCatalog = page.getByRole('region', { name: 'MCP catalog', exact: true })
    const tagsGroup = mcpCatalog.getByRole('group', { name: 'Filter by tag', exact: true })
    const tag = (name: string) => tagsGroup.getByRole('button', { name, exact: true })
    const search = page.getByLabel('Search catalog')
    await tag('Travel').focus()
    expect(await tagsGroup.getByRole('button').allTextContents()).toEqual(['All entries', 'Maps', 'Travel', 'Unclassified'])
    await page.keyboard.press('Enter')
    expect(await tagsGroup.getByRole('button', { pressed: true }).allTextContents()).toEqual(['Travel'])
    await preset.waitFor()
    expect(await trains.count()).toBe(0)
    await search.fill('train')
    await page.getByText('No matching catalog entries.').waitFor()
    expect(await mcpCatalog.locator('.panel-item-count').textContent()).toBe('0')
    await tag('All entries').click()
    await trains.waitFor()
    expect(await search.inputValue()).toBe('train')
    expect(await mcpCatalog.locator('.panel-item-count').textContent()).toBe('1')
    await tag('Unclassified').click()
    await trains.waitFor()
    expect(await preset.count()).toBe(0)
    expect(await search.inputValue()).toBe('train')
    await tag('Travel').click()
    await search.fill('')
    await preset.waitFor()
    expect(await tagsGroup.getByRole('button', { pressed: true }).allTextContents()).toEqual(['Travel'])
    includeTravel = false
    await page.getByRole('button', { name: 'Reload the MCP catalog' }).click()
    await tagsGroup.getByRole('button', { name: 'All entries', pressed: true }).waitFor()
    await trains.waitFor()
    await preset.waitFor()
    await preset.focus()
    await page.keyboard.press('Enter')
    const drawer = page.getByRole('dialog', { name: 'Amap', exact: true })
    expect(await drawer.locator('.catalog-install-sections > .plugin-detail-section h2').allTextContents()).toEqual([
      'Source',
      'This entry will install',
      'Service backends',
      'Access and publication',
    ])
    const source = drawer.getByRole('link', { name: 'Service documentation', exact: true })
    await source.waitFor()
    expect(await source.getAttribute('href')).toBe('https://lbs.amap.com/api/mcp-server/gettingstarted')
    const plan = drawer.getByRole('listitem').filter({ has: page.getByText('p-amap', { exact: true }) })
    await plan.getByText('MCP service ·', { exact: true }).waitFor()
    expect(await plan.getByText(/Catalog version/u).count()).toBe(0)
    await page.getByLabel('MCP service name', { exact: true }).fill('p-map')
    expect(await page.getByLabel('Display name', { exact: true }).inputValue()).toBe('Amap')
    await page.getByLabel('Display name', { exact: true }).fill('地图助手')
    await page.getByLabel('Amap Web Service Key', { exact: true }).fill('fixture-key')
    await page.getByRole('button', { name: 'Import MCP service', exact: true }).click()
    const row = page.locator('.mcp-service-card').filter({ hasText: 'p-map' })
    await row.getByText('Import failed', { exact: true }).waitFor()
    await page.reload()
    await row.getByText('Import failed', { exact: true }).waitFor()
    await page.getByRole('tab', { name: 'MCP catalog', exact: true }).click()
    await preset.click()
    await drawer.getByRole('status').getByText('Import failed', { exact: true }).waitFor()
    await drawer.getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.getByRole('tab', { name: 'MCP services', exact: true }).click()
    const settings = async () => (await page.request.get(origin + '/admin/api/mcp')).json()
    const saved = (await settings())[0]
    expect(saved.display).toMatchObject({ name: '地图助手', defaults: { name: { en: 'Amap', 'zh-CN': '高德地图' } } })
    expect(saved.display).not.toHaveProperty('description')
    expect(JSON.stringify(saved)).not.toContain('fixture-key')
    expect(
      (
        await page.request.post(origin + '/admin/api/mcp', {
          data: { action: 'save', service: { ...saved, url: 'https://tampered.example.test' } },
          headers: { origin },
        })
      ).status(),
    ).toBe(400)
    expect(
      (
        await page.request.post(origin + '/admin/api/mcp', {
          data: {
            action: 'publish',
            name: 'p-map',
            published: true,
            revision: (await (await page.request.get(origin + '/admin/api/mcp?publication=p-map')).json()).revision,
          },
          headers: { origin },
        })
      ).status(),
    ).toBe(409)
    fail = false
    await row.getByRole('button', { name: 'Retry import', exact: true }).click()
    await row.getByText('Import ready', { exact: true }).waitFor()
    entryVersion = '2.0.0'
    await page.reload()
    const updateAvailable = row.getByRole('button', { name: 'Review catalog update', exact: true })
    await updateAvailable.waitFor()
    await page.getByRole('button', { name: 'Add MCP service', exact: true }).click()
    await page.getByLabel('MCP service name', { exact: true }).fill('p-independent')
    await page.getByLabel('Remote MCP address', { exact: true }).fill('https://example.test/mcp')
    let failFirstRefresh = true
    await page.route('**/admin/api/mcp', async route => {
      if (route.request().method() === 'GET' && failFirstRefresh) {
        failFirstRefresh = false
        await route.fulfill({ status: 503, json: { error: 'Temporary catalog refresh failure' } })
      } else await route.continue()
    })
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    const independent = page.locator('.mcp-service-card').filter({ hasText: 'p-independent' })
    await independent.waitFor()
    const reloadError = page.getByRole('alert').filter({ hasText: 'Temporary catalog refresh failure' })
    await reloadError.waitFor()
    expect(await updateAvailable.isVisible()).toBe(true)
    await reloadError.waitFor({ state: 'hidden' })
    await page.unroute('**/admin/api/mcp')
    await independent.getByRole('button', { name: 'Remove', exact: true }).click()
    await page.getByRole('button', { name: 'Confirm action', exact: true }).click()
    await independent.waitFor({ state: 'detached' })
    await updateAvailable.click()
    await page.getByText('An update is available for this service.', { exact: true }).waitFor()
    expect(await page.getByRole('dialog').getByText('2.0.0', { exact: true }).count()).toBe(0)
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await row.getByRole('button', { name: 'Edit', exact: true }).click()
    expect(await page.getByLabel('Remote MCP address', { exact: true }).count()).toBe(0)
    await page.getByText('Connection settings are maintained by the platform.', { exact: true }).waitFor()
    await page.getByRole('tab', { name: 'Access settings', exact: true }).click()
    expect(await page.getByLabel('Platform credential', { exact: true }).inputValue()).toBe('')
    expect(await page.getByRole('button', { name: 'Add parameter', exact: true }).count()).toBe(0)
    await page.getByRole('tab', { name: 'Basic information', exact: true }).click()
    await page.getByRole('button', { name: 'Publish MCP service', exact: true }).click()
    await page.getByRole('dialog', { name: 'Confirm MCP publication', exact: true }).getByRole('button', { name: 'Confirm', exact: true }).click()
    await page.getByRole('region', { name: 'Platform App Center', exact: true }).getByRole('button', { name: 'Unpublish MCP service', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    // Render the public development-fallback state without starting a host process.
    await page.route('**/admin/api/mcp', async route => {
      const response = await route.fetch(),
        rows = await response.json()
      await route.fulfill({
        response,
        json: rows.map((value: object) => ({ ...value, preparation: { stage: 'ready', updatedAt: 1, log: '', isolated: false } })),
      })
    })
    await page.reload()
    await row.getByRole('button', { name: 'Edit', exact: true }).click()
    await page.getByText('Shared run is not isolated. Development only.', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.unroute('**/admin/api/mcp')
    await page.reload()
    await page.getByRole('tab', { name: 'MCP catalog', exact: true }).click()
    await page.getByText('1 imported services', { exact: true }).waitFor()
    if (process.env.DSH_PHALANX_E2E_EVIDENCE_DIR)
      await page.screenshot({ path: join(process.env.DSH_PHALANX_E2E_EVIDENCE_DIR, 'mcp-catalog-en.png'), fullPage: true })
    await page.context().addCookies([{ name: 'dsh-phalanx.lang', value: 'zh-CN', url: origin }])
    await page.setViewportSize({ width: 375, height: 844 })
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      await page.reload()
      await page.getByRole('tab', { name: 'MCP 广场', exact: true }).click()
      await page.getByRole('button', { name: '查看 MCP 服务 高德地图', exact: true }).waitFor()
      expect(await page.locator('html').getAttribute('data-theme')).toBe(colorScheme)
      const filters = page.locator('.catalog-gallery-filters')
      expect(await filters.evaluate(node => node.scrollWidth <= node.clientWidth && getComputedStyle(node).gridTemplateColumns.split(' ').length === 1)).toBe(
        true,
      )
      const group = filters.getByRole('group', { name: '按标签筛选', exact: true })
      await group.getByRole('button', { name: '全部', pressed: true }).waitFor()
      await group.getByRole('button', { name: '地图', exact: true }).click()
      expect(await group.getByRole('button', { name: '出行', exact: true }).count()).toBe(0)
      expect(await group.evaluate(node => getComputedStyle(node).flexWrap)).toBe('wrap')
    }
    if (process.env.DSH_PHALANX_E2E_EVIDENCE_DIR)
      await page.screenshot({ path: join(process.env.DSH_PHALANX_E2E_EVIDENCE_DIR, 'mcp-catalog-zh.png'), fullPage: true })
    classified = false
    await page.reload()
    await page.getByRole('tab', { name: 'MCP 广场', exact: true }).click()
    await page.getByRole('button', { name: '查看 MCP 服务 高德地图', exact: true }).waitFor()
    expect(await page.getByRole('group', { name: '按标签筛选' }).count()).toBe(0)
    catalogOnline = false
    await page.reload()
    await page.getByRole('tab', { name: 'MCP 广场', exact: true }).click()
    await page.getByRole('alert').getByText('已安装的 MCP 服务继续使用已保存的配置。').waitFor()
    expect((await settings())[0]).toMatchObject({ testStatus: 'passed', catalogTargetUnavailable: true })
    expect(authenticated).toBe(true)
    expect(errors).toEqual([])
    expect(await settings()).toHaveLength(1)
  } finally {
    await browser.close()
    proxy.close()
    forwarder.closeAllConnections()
    await new Promise<void>(resolve => forwarder.close(() => resolve()))
    await app.stop()
    catalogServer.closeAllConnections()
    await new Promise<void>(resolve => catalogServer.close(() => resolve()))
    await removeCommunityFixture(root)
  }
})
