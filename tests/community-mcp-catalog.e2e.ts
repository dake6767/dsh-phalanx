import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { createCommunityApplication } from '../src/composition/community-application.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'

it('imports a preset through the skill-pack style market, persists failure, retries and locks connection settings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-catalog-ui-'))
  let fail = true, authenticated = true
  const app = createCommunityApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'catalog-fixture-session-secret-32', runtime: { command: '/unavailable', args: [], dataRoot: root, defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'https://example.test' } } } }, {
    mcpTransport: { send: async input => {
      const target = new URL(input.upstream.baseUrl)
      authenticated &&= target.origin === 'https://mcp.amap.com' && target.searchParams.get('key') === 'fixture-key'
      if (input.method === 'DELETE') return new Response(null, { status: 204 })
      const body = await new Response(input.body).json()
      if (body.method === 'notifications/initialized') return new Response(null, { status: 202 })
      if (fail) return new Response('private upstream failure', { status: 403 })
      const result = body.method === 'initialize' ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } } : { tools: [{ name: 'maps_weather', inputSchema: { type: 'object' } }] }
      return Response.json({ jsonrpc: '2.0', id: body.id, result })
    } },
  })
  const browser = await chromium.launch({ headless: true })
  try {
    const origin = await app.start(), page = await browser.newPage({ locale: 'en', viewport: { width: 1440, height: 1000 } })
    if (process.env.DSH_PHALANX_E2E_CPU_THROTTLE) await (await page.context().newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.DSH_PHALANX_E2E_CPU_THROTTLE) })
    page.setDefaultTimeout(15000)
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
    await page.goto(`${origin}/bootstrap#credential=${readBootstrapCredential(root)!.credential}`)
    await page.getByLabel('Username', { exact: true }).fill('admin'); await page.getByLabel('Password', { exact: true }).fill('password')
    await page.getByRole('button', { name: 'Create administrator' }).click(); await page.waitForURL(`${origin}/admin`)
    await page.getByRole('link', { name: 'MCP library', exact: true }).click()
    await page.getByRole('tab', { name: 'MCP market', exact: true }).click()
    const preset = page.getByRole('button', { name: 'View preset Amap', exact: true })
    await preset.focus(); await page.keyboard.press('Enter')
    await page.getByLabel('MCP service name', { exact: true }).fill('p-map')
    await page.getByLabel('Amap Web Service Key', { exact: true }).fill('fixture-key')
    await page.getByRole('button', { name: 'Import and test', exact: true }).click()
    const row = page.getByRole('row').filter({ hasText: 'p-map' })
    await row.getByText('Import failed', { exact: true }).waitFor()
    await page.reload(); await row.getByText('Import failed', { exact: true }).waitFor()
    const settings = async () => (await page.request.get(origin + '/admin/api/mcp')).json()
    const saved = (await settings())[0]
    expect(JSON.stringify(saved)).not.toContain('fixture-key')
    expect((await page.request.post(origin + '/admin/api/mcp', { data: { action: 'save', service: { ...saved, url: 'https://tampered.example.test' } }, headers: { origin } })).status()).toBe(400)
    expect((await page.request.post(origin + '/admin/api/mcp', { data: { action: 'publish', name: 'p-map', published: true }, headers: { origin } })).status()).toBe(409)
    fail = false
    await row.getByRole('button', { name: 'Retry import', exact: true }).click()
    await row.getByText('Import ready', { exact: true }).waitFor()
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
      const response = await route.fetch(), rows = await response.json()
      await route.fulfill({ response, json: rows.map((value: object) => ({ ...value, preparation: { stage: 'ready', updatedAt: 1, log: '', isolated: false } })) })
    })
    await page.reload(); await row.getByRole('button', { name: 'Edit', exact: true }).click()
    await page.getByText('Shared run is not isolated. Development only.', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.unroute('**/admin/api/mcp'); await page.reload()
    await page.getByRole('tab', { name: 'MCP market', exact: true }).click()
    await page.getByText('1 imported services', { exact: true }).waitFor()
    if (process.env.DSH_PHALANX_E2E_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.DSH_PHALANX_E2E_EVIDENCE_DIR, 'mcp-catalog-en.png'), fullPage: true })
    await page.context().addCookies([{ name: 'dsh-phalanx.lang', value: 'zh-CN', url: origin }]); await page.reload()
    await page.getByRole('tab', { name: 'MCP 市场', exact: true }).click()
    await page.getByRole('button', { name: '查看预设 高德地图', exact: true }).waitFor()
    if (process.env.DSH_PHALANX_E2E_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.DSH_PHALANX_E2E_EVIDENCE_DIR, 'mcp-catalog-zh.png'), fullPage: true })
    expect(authenticated).toBe(true); expect(errors).toEqual([]); expect(await settings()).toHaveLength(1)
  } finally { await browser.close(); await app.stop(); await rm(root, { recursive: true, force: true }) }
})
