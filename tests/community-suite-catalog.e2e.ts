// Validation: T1; real credentials: none; controlled browser/process fixtures. CI selects its explicit public-entry subset.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { createProxyServer } from 'http-proxy-3'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { createCommunityApplication } from '../src/composition/community-application.js'
import { FileExecutionArtifacts } from '../src/adapters/execution-artifacts.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { loopbackPort } from '../src/adapters/loopback-port.js'
import type { SuiteCatalogEntry } from '../src/domain/suite-catalog.js'

const text = { en: 'text', 'zh-CN': '文案' }
const preparation = 'mkdir bin; printf "#!/bin/sh\\necho fixture-tool\\n" > bin/fixture-tool; chmod +x bin/fixture-tool'
const presets: readonly SuiteCatalogEntry[] = [
  { category: 'dependency', id: 'fixture-tool', version: '1', title: { en: 'Fixture tool', 'zh-CN': '夹具工具' }, description: text, source: text,
    items: [{ kind: 'runtime-dependency', name: 'fixture-tool', prepareCommands: { amd64: preparation, arm64: preparation }, pathDirectories: ['bin'], checkCommand: 'fixture-tool', commands: ['fixture-tool'] }] },
  { category: 'dependency', id: 'amd64-only', version: '1', title: { en: 'amd64 only', 'zh-CN': '仅 amd64' }, description: text, source: text,
    items: [{ kind: 'runtime-dependency', name: 'amd64tool', prepareCommands: { amd64: 'mkdir bin; printf "#!/bin/sh\\ntrue\\n" > bin/amd64tool; chmod +x bin/amd64tool' }, pathDirectories: ['bin'], commands: ['amd64tool'] }] },
]

it('browses the suite catalog, installs, locks and uninstalls a catalog dependency', async () => {
  const root = await mkdtemp(join(tmpdir(), 'suite-catalog-'))
  const port = await loopbackPort(), origin = `http://phalanx.example.test:${port}`
  const app = createCommunityApplication({ listen: { host: '127.0.0.1', port, publicOrigin: origin }, sessionSecret: 'suite-catalog-fixture-secret-000032', runtime: { command: '/unavailable', args: [], dataRoot: root, defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'https://example.test' } } } }, { suitePresets: presets })
  const proxy = createProxyServer({ target: `http://127.0.0.1:${port}` })
  proxy.on('error', (_error, _request, response) => response.destroy())
  const forwarder = createServer((request, response) => proxy.web(request, response))
  forwarder.on('connect', (_request, socket, head) => {
    const target = connect(port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); target.write(head)
      socket.pipe(target); target.pipe(socket)
    })
    target.on('error', () => socket.destroy()); socket.on('error', () => target.destroy())
    socket.on('close', () => target.destroy())
  })
  await new Promise<void>(resolve => forwarder.listen(0, '127.0.0.1', resolve))
  const address = forwarder.address()
  if (!address || typeof address === 'string') throw new Error('HTTP fixture did not listen')
  const browser = await chromium.launch({ headless: true, proxy: { server: `http://127.0.0.1:${address.port}` } })
  try {
    await app.start()
    const page = await browser.newPage({ locale: 'en', viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(15000)
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
    await page.goto(`${origin}/bootstrap#credential=${readBootstrapCredential(root)!.credential}`)
    expect(await page.evaluate(() => isSecureContext)).toBe(false)
    await page.getByLabel('Username', { exact: true }).fill('admin'); await page.getByLabel('Password', { exact: true }).fill('password')
    await page.getByRole('button', { name: 'Create administrator' }).click(); await page.waitForURL(`${origin}/admin`)
    await page.getByRole('link', { name: 'Suite catalog', exact: true }).click(); await page.waitForURL(`${origin}/admin/suites`)
    await page.getByRole('heading', { name: 'Suite catalog', exact: true }).waitFor()
    const card = page.locator('.plugin-library-card').filter({ hasText: 'Fixture tool' })
    await card.getByText('Not installed', { exact: true }).waitFor()
    if (process.arch === 'x64') expect(await card.getByRole('button', { name: 'Install', exact: true }).count()).toBe(1)
    else await page.locator('.plugin-library-card').filter({ hasText: 'amd64 only' }).getByText('Unavailable on this architecture', { exact: true }).waitFor()
    const select = async (label: string, option: string) => {
      await page.getByRole('button', { name: new RegExp(label) }).click()
      await page.getByRole('option', { name: option, exact: true }).click()
    }
    await select('Filter by category', 'Suites')
    await page.getByText('No entries match this filter.', { exact: true }).waitFor()
    await select('Filter by category', 'All entries')
    await card.getByRole('button', { name: 'Install', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Fixture tool' })
    await dialog.getByText('This entry will install:', { exact: true }).waitFor()
    await dialog.getByText('Runtime dependency fixture-tool · commands: fixture-tool').waitFor()
    await dialog.getByRole('button', { name: 'Install entry', exact: true }).click()
    await card.getByText('Installed', { exact: true }).first().waitFor({ timeout: 60000 })
    const saved = await (await page.request.get(origin + '/admin/api/runtime-dependencies?name=fixture-tool')).json()
    expect(saved).toMatchObject({ name: 'fixture-tool', source: 'suite-catalog', stage: 'ready', current: { commands: ['fixture-tool'] } })
    expect((await page.request.post(origin + '/admin/api/runtime-dependencies', { headers: { origin }, data: { action: 'update', name: 'fixture-tool', input: { name: 'fixture-tool', prepareCommand: 'tampered', pathDirectories: ['bin'] } } })).status()).toBe(403)
    expect((await page.request.post(origin + '/admin/api/runtime-dependencies', { headers: { origin }, data: { action: 'remove', name: 'fixture-tool' } })).status()).toBe(403)
    await page.getByRole('link', { name: 'Runtime dependencies', exact: true }).click()
    await page.getByText('Suite catalog', { exact: true }).first().waitFor()
    await page.getByRole('button', { name: 'View dependency fixture-tool', exact: true }).click()
    await page.getByText('Managed by the suite catalog. Definition is read-only.', { exact: true }).waitFor()
    expect(await page.getByRole('button', { name: 'Edit runtime dependency', exact: true }).count()).toBe(0)
    await page.getByRole('button', { name: 'Close dependency details', exact: true }).click()
    await page.getByRole('link', { name: 'Suite catalog', exact: true }).click()
    await card.getByRole('button', { name: 'Uninstall', exact: true }).click()
    const uninstall = page.getByRole('dialog', { name: 'Fixture tool' })
    await uninstall.getByText('This will remove:', { exact: true }).waitFor()
    await uninstall.getByText('fixture-tool').waitFor()
    await uninstall.getByRole('button', { name: 'Confirm uninstall', exact: true }).click()
    await card.getByText('Not installed', { exact: true }).waitFor()
    await page.getByRole('link', { name: 'Runtime dependencies', exact: true }).click()
    await page.getByText('No runtime dependencies yet', { exact: true }).waitFor()
    expect((await page.request.get(origin + '/admin/api/suites')).status()).toBe(200)
    expect((await page.request.post(origin + '/admin/api/accounts', { headers: { origin }, data: { username: 'member', email: 'member@example.test', password: 'password' } })).status()).toBe(201)
    const memberContext = await browser.newContext({ locale: 'en' }), member = await memberContext.newPage()
    await member.request.post(origin + '/login', { form: { username: 'member', password: 'password' } })
    expect((await member.request.get(origin + '/admin/api/suites')).status()).toBe(403)
    await memberContext.close()
    await page.context().addCookies([{ name: 'dsh-phalanx.lang', value: 'zh-CN', url: origin }])
    await page.reload()
    await page.getByRole('link', { name: '套件广场', exact: true }).click()
    await page.getByRole('heading', { name: '套件广场', exact: true }).waitFor()
    await page.locator('.plugin-library-card').filter({ hasText: '夹具工具' }).getByText('未安装', { exact: true }).waitFor()
    if (process.env.DSH_PHALANX_E2E_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.DSH_PHALANX_E2E_EVIDENCE_DIR, 'suite-catalog-zh.png'), fullPage: true })
    expect(errors).toEqual([])
  } finally {
    await browser.close(); proxy.close(); forwarder.closeAllConnections()
    await new Promise<void>(resolve => forwarder.close(() => resolve()))
    await app.stop(); await new FileExecutionArtifacts(join(root, 'runtime-dependencies', '.trees')).collect([]); await rm(root, { recursive: true, force: true })
  }
})
