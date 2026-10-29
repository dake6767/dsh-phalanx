// Validation: T2; real credentials: none; controlled signed catalog and plugin preparation fixtures.
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { loopbackPort } from '../src/adapters/loopback-port.js'
import { withSuiteCatalogContentHash } from '../src/domain/suite-catalog-document.js'
import { removeCommunityFixture } from './fixtures/owned-cleanup.js'
import { documentSuiteCatalogFixture } from './fixtures/suite-catalog-server.js'
import { createCommunityApplication } from './support/community-application.js'
import { selectBuiltinDatabase } from './support/community-bootstrap-browser.js'

it('browses, installs, replaces, detaches and uninstalls plugin entries in both languages', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-catalog-browser-'))
  const port = await loopbackPort(),
    origin = `http://127.0.0.1:${port}`
  const localized = { en: 'Fixture editor', 'zh-CN': '夹具编辑器' },
    integrity = 'sha512-' + Buffer.alloc(64, 1).toString('base64')
  const plugin = withSuiteCatalogContentHash({
    kind: 'plugin',
    id: 'fixture-editor',
    version: '1.0.0',
    engines: { platform: '>=0.1.24' },
    adapters: [],
    title: localized,
    description: localized,
    source: localized,
    identity: localized,
    dependencies: [],
    items: [
      {
        kind: 'plugin',
        packageName: '@fixture/editor',
        version: '1.0.0',
        integrity,
        runtimeDependencies: [],
        catalogDependencies: [],
        access: { environment: [{ name: 'EDITOR_MODE', value: 'shared' }], entriesYaml: '' },
      },
    ],
  })
  const catalog = await documentSuiteCatalogFixture([plugin], new Map())
  const app = createCommunityApplication(
    {
      listen: { host: '127.0.0.1', port, publicOrigin: origin },
      sessionSecret: 'plugin-catalog-browser-secret-000032',
      runtime: {
        command: '/unavailable',
        args: [],
        dataRoot: root,
        defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'https://example.test' } },
      },
    },
    {
      suiteCatalog: { address: catalog.address, trustedKeys: catalog.trustedKeys },
      pluginPreparer: {
        prepare: async input => ({
          packageName: input.packageName,
          version: input.version,
          integrity,
          artifact: 'fixture',
          runtimeRevision: 'fixture',
          title: 'Fixture editor',
          description: '',
          bundlePatch: '- insert:\n  - id: main\n    name: editor\n',
          dependencies: {},
        }),
      },
    },
  )
  const browser = await chromium.launch({ headless: true })
  try {
    await app.start()
    const page = await browser.newPage({ locale: 'en' })
    page.setDefaultTimeout(15000)
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`${origin}/bootstrap#credential=${readBootstrapCredential(root)!.credential}`)
    await selectBuiltinDatabase(page)
    await page.getByLabel('Username', { exact: true }).fill('admin')
    await page.getByLabel('Password', { exact: true }).fill('password')
    await page.getByRole('button', { name: 'Create administrator' }).click()
    await page.waitForURL(`${origin}/admin`)
    for (const zh of [false, true]) {
      await page.context().addCookies([{ name: 'dsh-phalanx.lang', value: zh ? 'zh-CN' : 'en', url: origin }])
      const title = localized[zh ? 'zh-CN' : 'en']
      await page.goto(origin + '/admin/skills?tab=catalog')
      expect(await page.getByRole('button', { name: zh ? `查看广场条目 ${title}` : `View catalog entry ${title}`, exact: true }).count()).toBe(0)
      await page.goto(origin + '/admin/plugins?tab=catalog')
      await page.getByRole('tab', { name: zh ? '插件广场' : 'Plugin catalog', exact: true, selected: true }).waitFor()
      const card = page
        .locator('.plugin-library-card')
        .filter({ has: page.getByRole('button', { name: zh ? `查看广场条目 ${title}` : `View catalog entry ${title}`, exact: true }) })
      await card.getByRole('button', { name: zh ? '安装' : 'Install', exact: true }).click()
      let dialog = page.getByRole('dialog', { name: title, exact: true })
      await dialog.getByRole('button', { name: zh ? '安装条目' : 'Install entry', exact: true }).click()
      await card
        .getByText(zh ? '已安装' : 'Installed', { exact: true })
        .first()
        .waitFor()
      await card.getByRole('button', { name: zh ? '卸载' : 'Uninstall', exact: true }).click()
      await dialog.getByText(zh ? '将移除：' : 'This will remove:', { exact: true }).waitFor()
      await dialog.getByRole('button', { name: zh ? '确认卸载' : 'Confirm uninstall', exact: true }).click()
      await card.getByText(zh ? '未安装' : 'Not installed', { exact: true }).waitFor()
      // The installation row disappears before catalog cleanup releases its claim.
      // Only this explicit admission rejection is safe to submit again.
      let add: Awaited<ReturnType<typeof page.request.post>> | undefined
      let addResult: { code?: string } | undefined
      let requestFailure: { error: unknown } | undefined
      await expect
        .poll(
          async () => {
            try {
              add = await page.request.post(origin + '/admin/api/plugins', {
                headers: { origin },
                data: { action: 'add', packageName: '@fixture/editor', version: '0.9.0' },
              })
              addResult = (await add.json()) as { code?: string }
              return add.status() === 409 && addResult?.code === 'plugin-job-busy' ? '409/plugin-job-busy' : 'completed'
            } catch (error) {
              // An unknown write outcome is terminal; poll must not replay it.
              requestFailure = { error }
              return 'completed'
            }
          },
          { timeout: 15000 },
        )
        .toBe('completed')
      if (requestFailure) throw requestFailure.error
      expect(add?.ok(), `Manual plugin add: HTTP ${add?.status()}, code=${addResult?.code ?? 'none'}`).toBe(true)
      await expect.poll(async () => ((await (await page.request.get(origin + '/admin/api/plugins')).json()) as { stage: string }[])[0]?.stage).toBe('available')
      await card.getByRole('button', { name: zh ? '安装' : 'Install', exact: true }).click()
      await dialog.getByText(zh ? '替代这些手动条目' : 'Replace these manual entries', { exact: true }).click()
      await dialog.getByRole('button', { name: zh ? '安装条目' : 'Install entry', exact: true }).click()
      await card
        .getByText(zh ? '已安装' : 'Installed', { exact: true })
        .first()
        .waitFor()
      await card.getByRole('button', { name: zh ? `查看广场条目 ${title}` : `View catalog entry ${title}`, exact: true }).click()
      dialog = page.getByRole('dialog', { name: title, exact: true })
      await dialog.getByRole('button', { name: zh ? `让 @fixture/editor 脱离『${title}』` : `Detach @fixture/editor from “${title}”`, exact: true }).click()
      const detach = page.getByRole('dialog').last()
      await detach.getByRole('button', { name: zh ? `脱离『${title}』` : `Detach from “${title}”`, exact: true }).click()
      await page.getByRole('button', { name: zh ? '关闭广场条目详情' : 'Close catalog entry details', exact: true }).click()
      await card.getByRole('button', { name: zh ? '卸载' : 'Uninstall', exact: true }).click()
      await page
        .getByRole('dialog', { name: title, exact: true })
        .getByRole('button', { name: zh ? '确认卸载' : 'Confirm uninstall', exact: true })
        .click()
      await card.getByText(zh ? '未安装' : 'Not installed', { exact: true }).waitFor()
      const plugins = (await (await page.request.get(origin + '/admin/api/plugins')).json()) as { packageName: string; suiteOrigin?: string }[]
      expect(plugins).toMatchObject([{ packageName: '@fixture/editor' }])
      expect(plugins[0]?.suiteOrigin).toBeUndefined()
      const impact = (await (await page.request.get(origin + '/admin/api/plugins/impact?packageName=' + encodeURIComponent('@fixture/editor'))).json()) as {
        revision: string
      }
      const removed = await page.request.post(origin + '/admin/api/plugins/change', {
        headers: { origin },
        data: { action: 'remove', confirmed: true, packageName: '@fixture/editor', revision: impact.revision },
      })
      expect(removed.ok()).toBe(true)
    }
    catalog.fail(true)
    await page.reload()
    await page.getByText('广场服务不可达', { exact: true }).waitFor()
    expect(errors).toEqual([])
  } finally {
    await browser.close()
    await app.stop()
    await catalog.close()
    await removeCommunityFixture(root)
  }
})
