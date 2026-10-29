// Validation: T1; real credentials: none; controlled browser/process fixtures. CI selects its explicit public-entry subset.
import { once } from 'node:events'
import { mkdtemp } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { removeCommunityFixture } from './fixtures/owned-cleanup.js'
import { createCommunityApplication } from './support/community-application.js'
import { selectBuiltinDatabase } from './support/community-bootstrap-browser.js'

it('previews MCP JSON, protects credentials and confirms each service without overwriting existing names', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-import-'))
  const app = createCommunityApplication({
    listen: { host: '127.0.0.1', port: 0 },
    sessionSecret: 'mcp-import-fixture-session-secret',
    runtime: {
      command: '/unavailable',
      args: [],
      dataRoot: root,
      defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'https://example.test' } },
    },
  })
  const upstream = createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(204)
      res.end()
      return
    }
    let data = ''
    for await (const chunk of req) data += chunk
    const message = JSON.parse(data)
    if (message.id === undefined) {
      res.writeHead(202)
      res.end()
      return
    }
    const result =
      message.method === 'initialize'
        ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
        : { tools: [{ name: 'read', inputSchema: { type: 'object' } }] }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
  })
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  const mcpUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}/mcp`
  const browser = await chromium.launch({ headless: true })
  try {
    const origin = await app.start(),
      page = await browser.newPage({ locale: 'en', viewport: { width: 1440, height: 1000 } })
    if (process.env.DSH_PHALANX_E2E_CPU_THROTTLE) await (await page.context().newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: 4 })
    page.setDefaultTimeout(15000)
    await page.goto(`${origin}/bootstrap#credential=${readBootstrapCredential(root)!.credential}`)
    await selectBuiltinDatabase(page)
    await page.getByLabel('Username', { exact: true }).fill('admin')
    await page.getByLabel('Password', { exact: true }).fill('password')
    await page.getByRole('button', { name: 'Create administrator' }).click()
    await page.waitForURL(origin + '/admin')
    await page.getByRole('link', { name: 'MCP library', exact: true }).click()
    const services = async () => (await page.request.get(origin + '/admin/api/mcp')).json()
    const importJson = async (text: string) => {
      await page.getByRole('button', { name: 'Import MCP JSON', exact: true }).click()
      await page.getByLabel('mcpServers JSON', { exact: true }).fill(text)
      await page.getByRole('button', { name: 'Review imported services', exact: true }).click()
    }
    await importJson('{bad')
    await page.getByText('Invalid MCP JSON.', { exact: true }).waitFor()
    await page.getByLabel('mcpServers JSON', { exact: true }).fill('{"mcpServers":{"x":{"url":"https://example.test","unknown":"fictional-secret"}}}')
    await page.getByRole('button', { name: 'Review imported services', exact: true }).click()
    await page.getByText('Unknown MCP field: mcpServers.x.unknown', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await importJson(
      JSON.stringify({
        mcpServers: {
          docs: { url: mcpUrl, headers: { Authorization: 'Bearer fictional-first', 'X-Api-Key': 'fictional-second' } },
          bocha: { command: 'uv', args: ['run', 'bocha-search-mcp'], env: { BOCHA_API_KEY: 'fictional-bocha' } },
          playwright: { command: 'node', args: ['cli.js'] },
        },
      }),
    )
    expect(await services()).toEqual([])
    await page.getByText('Review service 1 of 3', { exact: true }).waitFor()
    await page.getByRole('tab', { name: 'Access settings', exact: true }).click()
    expect(await page.getByLabel('Platform credential', { exact: true }).inputValue()).toBe('fictional-first')
    expect(await page.getByLabel('Platform credential imported1', { exact: true }).inputValue()).toBe('fictional-second')
    expect(await page.getByLabel('Header value', { exact: true }).first().inputValue()).toBe('Bearer {credential}')
    await page.getByRole('tab', { name: 'MCP tools', exact: true }).click()
    await page.getByRole('button', { name: 'Test connection', exact: true }).click()
    await page.getByText('MCP connection passed.', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.getByText('Review service 2 of 3', { exact: true }).waitFor()
    expect((await services()).map((row: { name: string }) => row.name)).toEqual(['p-docs'])
    expect(JSON.stringify(await services())).not.toContain('fictional-')
    expect(await page.getByLabel('MCP command', { exact: true }).inputValue()).toBe('uv')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await page.getByText('Review service 3 of 3', { exact: true }).waitFor()
    await page.getByRole('button', { name: /Run location/ }).click()
    expect(await page.getByRole('option', { name: 'Independent member run (unavailable)', exact: true }).getAttribute('aria-disabled')).toBe('true')
    await page.getByRole('option', { name: 'Member container run', exact: true }).click()
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect.poll(() => page.getByRole('dialog').count()).toBe(0)
    const saved = await services()
    expect(saved.find((row: { name: string }) => row.name === 'p-bocha')).toMatchObject({ run: { location: 'shared' }, credentialConfigured: true })
    expect(saved.find((row: { name: string }) => row.name === 'p-playwright')).toMatchObject({ run: { location: 'member' } })
    await importJson('{"mcpServers":{"docs":{"url":"https://changed.example.test/mcp"}}}')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await page.getByRole('alert').waitFor()
    expect((await services()).find((row: { name: string }) => row.name === 'p-docs').url).toBe(mcpUrl)
    await page.getByLabel('MCP service name', { exact: true }).fill('p-docs-copy')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect.poll(() => page.getByRole('dialog').count()).toBe(0)
    await importJson(JSON.stringify({ mcpServers: { tested: { url: mcpUrl } } }))
    await page.getByRole('tab', { name: 'MCP tools', exact: true }).click()
    await page.getByRole('button', { name: 'Test connection', exact: true }).click()
    await page.getByText('MCP connection passed.', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await page
      .getByRole('row')
      .filter({ has: page.getByText('p-tested', { exact: true }) })
      .getByRole('button', { name: 'Edit', exact: true })
      .click()
    await page.getByRole('tab', { name: 'MCP tools', exact: true }).click()
    await expect.poll(() => page.getByRole('checkbox', { name: 'read', exact: true }).isEnabled()).toBe(true)
    await page.getByRole('tab', { name: 'Basic information', exact: true }).click()
    expect(await page.getByRole('button', { name: 'Publish MCP service', exact: true }).isEnabled()).toBe(true)
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    const evidence = process.env.DSH_PHALANX_E2E_EVIDENCE_DIR
    if (evidence) await page.screenshot({ path: join(evidence, 'mcp-import-complete.png'), fullPage: true })
    expect(await services()).toHaveLength(5)
    const rejected = await page.request.post(origin + '/admin/api/mcp', {
      data: {
        action: 'save',
        service: { name: 'p-bocha', description: '', url: '', run: { location: 'member', command: 'node', args: [], env: [], prepareCommand: '' } },
      },
    })
    expect(rejected.status()).toBe(400)
  } finally {
    await browser.close()
    await app.stop()
    upstream.closeAllConnections()
    await new Promise<void>(resolve => upstream.close(() => resolve()))
    await removeCommunityFixture(root)
  }
})
