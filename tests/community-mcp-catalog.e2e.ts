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
import { withSuiteCatalogContentHash } from '../src/domain/suite-catalog-document.js'
import { onlineCatalogEntries } from './fixtures/suite-catalog-online.js'
import { signedMcpEntries } from './fixtures/mcp-catalog-online.js'
import { createCatalogSigningKey, signRawCatalog } from './fixtures/suite-catalog-signing.js'
import { removeCommunityFixture } from './fixtures/owned-cleanup.js'
import { createCommunityApplication } from './support/community-application.js'
import { selectBuiltinDatabase } from './support/community-bootstrap-browser.js'

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
