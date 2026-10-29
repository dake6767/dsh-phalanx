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
import { FileExecutionArtifacts } from '../src/adapters/execution-artifacts.js'
import { loopbackPort } from '../src/adapters/loopback-port.js'
import type { SuiteCatalogEntry } from '../src/domain/suite-catalog.js'
import { removeCommunityFixture } from './fixtures/owned-cleanup.js'
import { legacySuiteCatalogFixture } from './fixtures/suite-catalog-server.js'
import { createCommunityApplication } from './support/community-application.js'
import { selectBuiltinDatabase } from './support/community-bootstrap-browser.js'

const text = { en: 'text', 'zh-CN': '文案' }
const preparation = 'mkdir bin; printf "#!/bin/sh\\necho fixture-tool\\n" > bin/fixture-tool; chmod +x bin/fixture-tool'
const presets: readonly SuiteCatalogEntry[] = [
  {
    identity: text,
    category: 'suite',
    id: 'office',
    version: '1',
    title: { en: 'Fixture office', 'zh-CN': '夹具办公' },
    description: text,
    source: text,
    dependencies: ['fixture-tool'],
    items: [
      {
        kind: 'runtime-dependency',
        name: 'office-tool',
        prepareCommands: { amd64: preparation.replaceAll('fixture-tool', 'office-tool'), arm64: preparation.replaceAll('fixture-tool', 'office-tool') },
        pathDirectories: ['bin'],
        checkCommand: 'office-tool',
        commands: ['office-tool'],
      },
    ],
  },
  {
    category: 'dependency',
    id: 'fixture-tool',
    version: '1',
    title: { en: 'Fixture tool', 'zh-CN': '夹具工具' },
    description: text,
    source: text,
    items: [
      {
        kind: 'runtime-dependency',
        name: 'fixture-tool',
        prepareCommands: { amd64: preparation, arm64: preparation },
        pathDirectories: ['bin'],
        checkCommand: 'fixture-tool',
        commands: ['fixture-tool'],
      },
    ],
  },
  {
    category: 'dependency',
    id: 'amd64-only',
    version: '1',
    title: { en: 'amd64 only', 'zh-CN': '仅 amd64' },
    description: text,
    source: text,
    items: [
      {
        kind: 'runtime-dependency',
        name: 'amd64tool',
        prepareCommands: { amd64: 'mkdir bin; printf "#!/bin/sh\\ntrue\\n" > bin/amd64tool; chmod +x bin/amd64tool' },
        pathDirectories: ['bin'],
        commands: ['amd64tool'],
      },
    ],
  },
]

it('opens the skill catalog in both languages, hides dependencies and preserves an existing standalone installation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'suite-catalog-'))
  const port = await loopbackPort(),
    origin = `http://phalanx.example.test:${port}`
  const catalogFixture = await legacySuiteCatalogFixture(presets)
  const app = createCommunityApplication(
    {
      downloadSources: catalogFixture.downloadSources,
      listen: { host: '127.0.0.1', port, publicOrigin: origin },
      sessionSecret: 'suite-catalog-fixture-secret-000032',
      runtime: {
        command: '/unavailable',
        args: [],
        dataRoot: root,
        defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'https://example.test' } },
      },
    },
    { suiteCatalog: { address: catalogFixture.address, trustedKeys: catalogFixture.trustedKeys } },
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
    page.setDefaultTimeout(15000)
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`${origin}/bootstrap#credential=${readBootstrapCredential(root)!.credential}`)
    await selectBuiltinDatabase(page)
    expect(await page.evaluate(() => isSecureContext)).toBe(false)
    await page.getByLabel('Username', { exact: true }).fill('admin')
    await page.getByLabel('Password', { exact: true }).fill('password')
    await page.getByRole('button', { name: 'Create administrator' }).click()
    await page.waitForURL(`${origin}/admin`)
    // A standalone catalog dependency installed before the entry-point change keeps its record and artifact.
    await page.request.get(origin + '/admin/api/suites')
    expect(
      (
        await page.request.post(origin + '/admin/api/suites', {
          headers: { origin },
          data: { action: 'install', input: { id: 'fixture-tool', requestId: 'legacy-dependency-0001' } },
        })
      ).status(),
    ).toBe(202)
    const dependency = async () => await (await page.request.get(origin + '/admin/api/runtime-dependencies?name=fixture-tool')).json()
    await expect.poll(async () => (await dependency()).stage, { timeout: 60000 }).toBe('ready')
    const before = await dependency()
    expect(await page.getByRole('link', { name: 'Suite catalog', exact: true }).count()).toBe(0)
    await page.goto(`${origin}/admin/suites`)
    await page.waitForURL(`${origin}/admin/skills?tab=catalog`)
    await page.getByRole('tab', { name: 'Skill catalog', exact: true, selected: true }).waitFor()
    const card = page.locator('.plugin-library-card').filter({ has: page.getByRole('button', { name: 'View catalog entry Fixture office', exact: true }) })
    await card.getByText('Not installed', { exact: true }).waitFor()
    expect(await page.getByRole('button', { name: 'View catalog entry Fixture tool', exact: true }).count()).toBe(0)
    expect(await page.getByRole('button', { name: /Filter by category/ }).count()).toBe(0)
    await card.getByText('Fixture tool', { exact: true }).waitFor()
    await card.getByRole('button', { name: 'View catalog entry Fixture office', exact: true }).click()
    const detail = page.getByRole('dialog', { name: 'Fixture office', exact: true })
    await detail.getByText('Fixture tool', { exact: true }).waitFor()
    await detail.getByRole('button', { name: 'Close catalog entry details', exact: true }).click()
    await card.getByRole('button', { name: 'Install', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Fixture office' })
    await dialog.getByText('This entry will install:', { exact: true }).waitFor()
    await dialog.getByText('Fixture tool · Already in the library; reused without preparing again', { exact: true }).waitFor()
    await dialog.getByRole('button', { name: 'Install entry', exact: true }).click()
    await card.getByText('Installed', { exact: true }).first().waitFor({ timeout: 60000 })
    expect((await dependency()).current).toEqual(before.current)
    await card.getByRole('button', { name: 'View catalog entry Fixture office', exact: true }).click()
    await detail.getByText('Fixture tool', { exact: true }).waitFor()
    await detail.getByRole('button', { name: 'Close catalog entry details', exact: true }).click()

    await page.getByRole('link', { name: 'Runtime dependencies', exact: true }).click()
    await page.getByText('From catalog', { exact: true }).first().waitFor()
    await page.getByRole('button', { name: 'View dependency fixture-tool', exact: true }).click()
    await page.getByText('Managed by the catalog. Definition is read-only.', { exact: true }).waitFor()
    expect(await page.getByRole('button', { name: 'Edit runtime dependency', exact: true }).count()).toBe(0)
    await page.getByRole('dialog', { name: 'fixture-tool', exact: true }).getByRole('button', { name: 'Uninstall', exact: true }).click()
    const blockedRemoval = page.getByRole('dialog', { name: 'Fixture tool', exact: true })
    await blockedRemoval.getByText('Remove these references before deleting the dependency.', { exact: true }).waitFor()
    expect(await blockedRemoval.getByRole('button', { name: 'Confirm uninstall', exact: true }).isDisabled()).toBe(true)
    await blockedRemoval.getByRole('button', { name: 'Cancel', exact: true }).click()

    await page.getByRole('button', { name: 'Close dependency details', exact: true }).click()
    await page.locator('nav.nav-list').getByRole('link', { name: 'Skill library', exact: true }).click()
    await page.getByRole('tab', { name: 'Skill catalog', exact: true }).click()
    await card.getByRole('button', { name: 'Uninstall', exact: true }).click()
    const uninstall = page.getByRole('dialog', { name: 'Fixture office' })
    await uninstall.getByText('This will remove:', { exact: true }).waitFor()
    await uninstall.getByText('Also remove Fixture tool; nothing else uses it', { exact: true }).click()
    expect(await uninstall.getByRole('checkbox', { name: 'Also remove Fixture tool; nothing else uses it', exact: true }).isChecked()).toBe(false)
    await uninstall.getByRole('button', { name: 'Confirm uninstall', exact: true }).click()
    await card.getByText('Not installed', { exact: true }).waitFor()
    expect((await dependency()).current).toEqual(before.current)
    expect((await page.request.get(origin + '/admin/api/suites')).status()).toBe(200)
    expect(
      (
        await page.request.post(origin + '/admin/api/accounts', {
          headers: { origin },
          data: { username: 'member', email: 'member@example.test', password: 'password' },
        })
      ).status(),
    ).toBe(201)
    const memberContext = await browser.newContext({ locale: 'en' }),
      member = await memberContext.newPage()
    await member.request.post(origin + '/login', { form: { username: 'member', password: 'password' } })
    expect((await member.request.get(origin + '/admin/api/suites')).status()).toBe(403)
    await memberContext.close()
    await page.context().addCookies([{ name: 'dsh-phalanx.lang', value: 'zh-CN', url: origin }])
    await page.goto(origin + '/admin/suites')
    await page.waitForURL(origin + '/admin/skills?tab=catalog')
    await page.getByRole('tab', { name: '技能广场', exact: true, selected: true }).waitFor()
    await page.getByRole('button', { name: '查看广场条目 夹具办公', exact: true }).waitFor()
    expect(await page.getByRole('button', { name: '查看广场条目 夹具工具', exact: true }).count()).toBe(0)
    expect(await page.getByRole('button', { name: /按类别筛选/ }).count()).toBe(0)
    expect(await page.getByRole('link', { name: '套件广场', exact: true }).count()).toBe(0)
    expect(await page.locator('body').innerText()).not.toContain('套件')
    await page.getByRole('link', { name: '运行依赖', exact: true }).click()
    await page.getByText('来自广场', { exact: true }).first().waitFor()
    expect((await dependency()).current).toEqual(before.current)
    await page.getByRole('button', { name: '查看依赖 fixture-tool', exact: true }).click()
    await page.getByRole('dialog', { name: 'fixture-tool', exact: true }).getByRole('button', { name: '卸载', exact: true }).click()
    const removal = page.getByRole('dialog', { name: '夹具工具', exact: true })
    await removal.getByText('将移除：', { exact: true }).waitFor()
    await removal.getByRole('button', { name: '确认卸载', exact: true }).click()
    await page.getByText('暂无运行依赖', { exact: true }).waitFor()
    if (process.env.DSH_PHALANX_E2E_EVIDENCE_DIR)
      await page.screenshot({ path: join(process.env.DSH_PHALANX_E2E_EVIDENCE_DIR, 'skill-catalog-zh.png'), fullPage: true })
    expect(errors).toEqual([])
  } finally {
    await browser.close()
    proxy.close()
    forwarder.closeAllConnections()
    await new Promise<void>(resolve => forwarder.close(() => resolve()))
    await app.stop()
    await catalogFixture.close()
    await new FileExecutionArtifacts(join(root, 'runtime-dependencies', '.trees')).collect([])
    await removeCommunityFixture(root)
  }
})
