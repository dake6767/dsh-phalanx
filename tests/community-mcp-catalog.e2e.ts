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
import { mcpPresets } from '../src/domain/mcp-catalog.js'
import { removeCommunityFixture } from './fixtures/owned-cleanup.js'
import { createCommunityApplication } from './support/community-application.js'
import { selectBuiltinDatabase } from './support/community-bootstrap-browser.js'

it('imports a preset through the skill-pack style market, persists failure, retries and locks connection settings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-catalog-ui-'))
  const port = await loopbackPort(),
    origin = `http://phalanx.example.test:${port}`
  const presets = [...structuredClone(mcpPresets)]
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
      mcpPresets: presets,
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
    await page.waitForURL(`${origin}/admin`)
    await page.getByRole('link', { name: 'MCP library', exact: true }).click()
    await page.getByRole('tab', { name: 'MCP catalog', exact: true }).click()
    const preset = page.getByRole('button', { name: 'View MCP service Amap', exact: true })
    await preset.focus()
    await page.keyboard.press('Enter')
    await page.getByLabel('MCP service name', { exact: true }).fill('p-map')
    await page.getByLabel('Amap Web Service Key', { exact: true }).fill('fixture-key')
    await page.getByRole('button', { name: 'Import MCP service', exact: true }).click()
    const row = page.getByRole('row').filter({ hasText: 'p-map' })
    await row.getByText('Import failed', { exact: true }).waitFor()
    await page.reload()
    await row.getByText('Import failed', { exact: true }).waitFor()
    const settings = async () => (await page.request.get(origin + '/admin/api/mcp')).json()
    const saved = (await settings())[0]
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
      (await page.request.post(origin + '/admin/api/mcp', { data: { action: 'publish', name: 'p-map', published: true }, headers: { origin } })).status(),
    ).toBe(409)
    fail = false
    await row.getByRole('button', { name: 'Retry import', exact: true }).click()
    await row.getByText('Import ready', { exact: true }).waitFor()
    const index = presets.findIndex(preset => preset.entry.id === saved.catalog.id)
    presets[index] = { ...presets[index]!, entry: { ...presets[index]!.entry, version: 'http-next' } }
    await page.reload()
    await row.getByRole('button', { name: 'Review catalog update', exact: true }).click()
    await page.getByText(`Catalog update ${saved.catalog.version} → http-next`, { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await row.getByRole('button', { name: 'Edit', exact: true }).click()
    expect(await page.getByLabel('Remote MCP address', { exact: true }).count()).toBe(0)
    await page.getByText('Connection settings are maintained by the platform.', { exact: true }).waitFor()
    await page.getByRole('tab', { name: 'Access settings', exact: true }).click()
    expect(await page.getByLabel('Platform credential', { exact: true }).inputValue()).toBe('')
    expect(await page.getByRole('button', { name: 'Add parameter', exact: true }).count()).toBe(0)
    await page.getByRole('tab', { name: 'Basic information', exact: true }).click()
    await page.getByRole('button', { name: 'Publish MCP service', exact: true }).click()
    await page.getByText('MCP service is published.', { exact: true }).waitFor()
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
    await page.reload()
    await page.getByRole('tab', { name: 'MCP 广场', exact: true }).click()
    await page.getByRole('button', { name: '查看 MCP 服务 高德地图', exact: true }).waitFor()
    if (process.env.DSH_PHALANX_E2E_EVIDENCE_DIR)
      await page.screenshot({ path: join(process.env.DSH_PHALANX_E2E_EVIDENCE_DIR, 'mcp-catalog-zh.png'), fullPage: true })
    expect(authenticated).toBe(true)
    expect(errors).toEqual([])
    expect(await settings()).toHaveLength(1)
  } finally {
    await browser.close()
    proxy.close()
    forwarder.closeAllConnections()
    await new Promise<void>(resolve => forwarder.close(() => resolve()))
    await app.stop()
    await removeCommunityFixture(root)
  }
})
