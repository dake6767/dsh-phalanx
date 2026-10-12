import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { createCommunityApplication } from '../src/composition/community-application.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'

it('manages remote MCP services and group grants through the existing administration shell', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-admin-'))
  const app = createCommunityApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'mcp-admin-fixture-session-secret-32', runtime: { command: '/unavailable', args: [], dataRoot: root, defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'https://example.test' } } } })
  let discoverNew = false, fail = false
  const received: { auth: string | undefined, key: string | null }[] = []
  const upstream = createServer(async (req, res) => {
    if (req.method === 'DELETE') { res.writeHead(204); res.end(); return }
    let body = ''; for await (const chunk of req) body += chunk
    const input = JSON.parse(body)
    received.push({ auth: req.headers.authorization, key: new URL(req.url!, 'http://localhost').searchParams.get('key') })
    if (input.method === 'notifications/initialized') { res.writeHead(202); res.end(); return }
    if (fail) { res.writeHead(503); res.end(); return }
    const result = input.method === 'initialize' ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
      : { tools: ['read', 'write', ...(discoverNew ? ['new_tool'] : [])].map(name => ({ name, description: name, inputSchema: { type: 'object' } })) }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: input.id, result }))
  })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening'); const address = upstream.address()
  if (!address || typeof address === 'string') throw Error('no address')
  const mcpUrl = `http://127.0.0.1:${address.port}/mcp`
  const browser = await chromium.launch({ headless: true })
  try {
    const origin = await app.start(), page = await browser.newPage({ locale: 'en', viewport: { width: 1440, height: 1000 } })
    if (process.env.DSH_PHALANX_E2E_CPU_THROTTLE) await (await page.context().newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.DSH_PHALANX_E2E_CPU_THROTTLE) })
    page.setDefaultTimeout(15000)
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
    expect((await page.request.get(origin + '/admin/api/mcp')).status()).toBe(401)
    await page.goto(`${origin}/bootstrap#credential=${readBootstrapCredential(root)!.credential}`)
    await page.getByLabel('Username', { exact: true }).fill('admin'); await page.getByLabel('Password', { exact: true }).fill('password')
    await page.getByRole('button', { name: 'Create administrator' }).click(); await page.waitForURL(`${origin}/admin`)
    await page.getByRole('link', { name: 'MCP library', exact: true }).click()
    await page.getByRole('button', { name: 'Add MCP service', exact: true }).click()
    await page.getByLabel('MCP service name', { exact: true }).fill('p-docs')
    await page.getByLabel('Description', { exact: true }).fill('Shared documentation')
    await page.getByLabel('Remote MCP address', { exact: true }).fill(mcpUrl)
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    const row = page.getByRole('row').filter({ hasText: 'p-docs' }); await row.waitFor()
    const groups = await (await page.request.get(origin + '/admin/api/groups')).json()
    const memberGroup = groups.find((group: { kind: string }) => group.kind === 'ordinary').id
    const group = async () => (await page.request.get(origin + '/admin/api/groups/' + memberGroup + '/mcp')).json()
    expect((await group()).services[0].granted).toBe(false)
    await row.getByRole('button', { name: 'Edit', exact: true }).click()
    await page.getByLabel('Description', { exact: true }).fill('Updated documentation')
    await page.getByRole('button', { name: 'Save', exact: true }).click(); await row.getByText('Updated documentation', { exact: true }).waitFor()
    await row.getByRole('button', { name: 'Edit', exact: true }).click()
    await page.getByRole('tab', { name: 'Access settings', exact: true }).click()
    await page.getByLabel('Platform credential', { exact: true }).fill('fictional-platform-secret')
    await page.getByRole('button', { name: 'Add header', exact: true }).click()
    await page.getByLabel('Header name', { exact: true }).fill('Authorization'); await page.getByLabel('Header value', { exact: true }).fill('Bearer {credential}')
    await page.getByRole('button', { name: 'Add parameter', exact: true }).click()
    await page.getByLabel('Parameter name', { exact: true }).fill('key'); await page.getByLabel('Parameter value', { exact: true }).fill('{credential}')
    await page.getByRole('tab', { name: 'MCP tools', exact: true }).click()
    await page.getByRole('button', { name: 'Test connection', exact: true }).click()
    await page.getByText('MCP connection passed.', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await row.getByRole('button', { name: 'Edit', exact: true }).click()
    await page.getByRole('tab', { name: 'MCP tools', exact: true }).click()
    await expect.poll(() => page.getByRole('checkbox', { name: 'write', exact: true }).isEnabled()).toBe(true)
    await page.getByText('write', { exact: true }).first().click()
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect.poll(() => page.getByRole('dialog').count()).toBe(0)
    const services = async () => (await page.request.get(origin + '/admin/api/mcp')).json()
    expect((await services())[0]).toMatchObject({ credentialConfigured: true, testStatus: 'passed', disabledTools: ['write'] })
    expect(JSON.stringify(await services())).not.toContain('fictional-platform-secret')
    expect(received.every(item => item.auth === 'Bearer fictional-platform-secret' && item.key === 'fictional-platform-secret')).toBe(true)
    discoverNew = true
    await row.getByRole('button', { name: 'Edit', exact: true }).click()
    await page.getByRole('tab', { name: 'MCP tools', exact: true }).click()
    await expect.poll(() => page.getByRole('checkbox', { name: 'new_tool', exact: true }).isEnabled()).toBe(true)
    expect(await page.getByRole('checkbox', { name: 'write', exact: true }).isChecked()).toBe(true)
    expect(await page.getByRole('checkbox', { name: 'new_tool', exact: true }).isChecked()).toBe(false)
    await page.getByText('New tool', { exact: true }).waitFor()
    await page.getByRole('tab', { name: 'Access settings', exact: true }).click()
    expect(await page.getByLabel('Platform credential', { exact: true }).inputValue()).toBe('')
    await page.getByRole('tab', { name: 'MCP tools', exact: true }).click()
    if (process.env.DSH_PHALANX_E2E_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.DSH_PHALANX_E2E_EVIDENCE_DIR, 'mcp-tools-desktop.png'), fullPage: true })
    fail = true
    await page.getByRole('button', { name: 'Test connection', exact: true }).click()
    await page.getByText('MCP connection failed. Saved settings cannot be published.', { exact: true }).waitFor()
    expect((await services())[0].testStatus).toBe('failed')
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    const evidence = process.env.DSH_PHALANX_E2E_EVIDENCE_DIR
    if (evidence) await page.screenshot({ path: join(evidence, 'mcp-library-desktop.png'), fullPage: true })
    await page.getByRole('link', { name: 'Group management', exact: true }).click()
    await page.getByRole('row').filter({ hasText: 'Default group' }).getByRole('button', { name: 'Details', exact: true }).click()
    await page.getByRole('tab', { name: 'MCP grants', exact: true }).click()
    await expect.poll(() => page.getByRole('checkbox', { name: 'p-docs', exact: true }).isEnabled()).toBe(true); await page.getByText('p-docs', { exact: true }).click(); await page.getByRole('button', { name: 'Save grants', exact: true }).click()
    await expect.poll(async () => (await group()).services[0].granted).toBe(true)
    await expect.poll(() => page.getByRole('checkbox', { name: 'p-docs', exact: true }).isEnabled()).toBe(true); await page.getByText('p-docs', { exact: true }).click(); await page.getByRole('button', { name: 'Save grants', exact: true }).click()
    await expect.poll(async () => (await group()).services[0].granted).toBe(false)
    await page.getByRole('button', { name: 'Close group details', exact: true }).last().click()
    await page.getByRole('row').filter({ hasText: 'Administrators' }).getByRole('button', { name: 'Details', exact: true }).click()
    await page.getByRole('tab', { name: 'MCP grants', exact: true }).click()
    expect(await page.getByRole('checkbox', { name: 'p-docs', exact: true }).isChecked()).toBe(true)
    expect(await page.getByRole('checkbox', { name: 'p-docs', exact: true }).isDisabled()).toBe(true)
    await page.getByRole('button', { name: 'Close group details', exact: true }).last().click()
    await page.getByRole('link', { name: 'MCP library', exact: true }).click()
    await page.getByRole('button', { name: /Platform language/ }).click(); await page.getByRole('option', { name: '简体中文', exact: true }).click()
    await page.getByRole('heading', { name: 'MCP 库', exact: false }).waitFor()
    await page.setViewportSize({ width: 390, height: 844 })
    if (evidence) await page.screenshot({ path: join(evidence, 'mcp-library-mobile-zh.png'), fullPage: true })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.getByRole('button', { name: '移除', exact: true }).click(); await page.getByRole('button', { name: '确认操作', exact: true }).click()
    await page.getByText('暂无 MCP 服务', { exact: true }).waitFor()
    expect(errors).toEqual([])
  } finally { await browser.close(); await app.stop(); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); await rm(root, { recursive: true, force: true }) }
})
