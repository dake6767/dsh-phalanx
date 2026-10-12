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
    await page.getByLabel('Remote MCP address', { exact: true }).fill('https://mcp.example.test/mcp')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    const row = page.getByRole('row').filter({ hasText: 'p-docs' }); await row.waitFor()
    const groups = await (await page.request.get(origin + '/admin/api/groups')).json()
    const memberGroup = groups.find((group: { kind: string }) => group.kind === 'ordinary').id
    const group = async () => (await page.request.get(origin + '/admin/api/groups/' + memberGroup + '/mcp')).json()
    expect((await group()).services[0].granted).toBe(false)
    await row.getByRole('button', { name: 'Edit', exact: true }).click()
    await page.getByLabel('Description', { exact: true }).fill('Updated documentation')
    await page.getByRole('button', { name: 'Save', exact: true }).click(); await row.getByText('Updated documentation', { exact: true }).waitFor()
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
  } finally { await browser.close(); await app.stop(); await rm(root, { recursive: true, force: true }) }
})
