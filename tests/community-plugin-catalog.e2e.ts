// Validation: T2; real credentials: none; controlled signed catalog and plugin preparation fixtures.
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { declaredRuntimeRevision } from '../src/adapters/runtime-revision.js'
import officeInputs from './fixtures/office-inputs.json' with { type: 'json' }
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { loopbackPort } from '../src/adapters/loopback-port.js'
import { PostgresCatalogInstalls } from '../src/adapters/postgres-catalog-records.js'
import { PostgresPluginLibraryStore } from '../src/adapters/postgres-plugin-library.js'
import { withSuiteCatalogContentHash } from '../src/domain/suite-catalog-document.js'
import { removeCommunityFixture } from './fixtures/owned-cleanup.js'
import { documentSuiteCatalogFixture } from './fixtures/suite-catalog-server.js'
import { createCommunityApplication, openTestDatabase } from './support/community-application.js'
import { selectBuiltinDatabase } from './support/community-bootstrap-browser.js'

it('browses, installs, replaces, detaches and uninstalls plugin entries in both languages', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-catalog-browser-'))
  const port = await loopbackPort(),
    origin = `http://127.0.0.1:${port}`
  const localized = { en: 'Fixture editor', 'zh-CN': '夹具编辑器' },
    integrity = 'sha512-' + Buffer.alloc(64, 1).toString('base64')
  const conversationBackend = {
    id: 'openai',
    label: { en: 'OpenAI compatible', 'zh-CN': 'OpenAI 兼容' },
    protocol: 'openai-chat',
    mode: 'api',
    upstream: { endpoint: 'URL', key: 'KEY', model: 'MODEL' },
    fields: [
      { name: 'URL', type: 'url', required: true },
      { name: 'KEY', type: 'secret', required: true },
      { name: 'MODEL', type: 'text', required: true },
    ],
  } as const
  const makePlugin = (alternate = false) =>
    withSuiteCatalogContentHash({
      kind: 'plugin',
      id: 'fixture-editor',
      version: '7.8.9',
      engines: { platform: '>=0.1.39' },
      adapters: [],
      title: localized,
      description: localized,
      source: { en: 'Test registry', 'zh-CN': '测试包仓库' },
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
          serviceSlots: [
            {
              id: 'image',
              label: { en: 'Image generation', 'zh-CN': '生图' },
              binding: {
                kind: 'json-settings',
                deferredUpstream: true,
                file: 'fixture-image.json',
                upstream: 'image-provider',
                fields: [
                  { path: ['endpoint'], source: 'gateway-url' },
                  { path: ['token'], source: 'service-token' },
                  { path: ['model'], source: 'model' },
                ],
              },
              backends: [
                {
                  id: 'openai',
                  label: { en: 'OpenAI compatible', 'zh-CN': 'OpenAI 兼容' },
                  protocol: 'openai-image',
                  mode: 'openai',
                  upstream: { model: 'MODEL' },
                  fields: [{ name: 'MODEL', type: 'text', required: true }],
                },
              ],
            },
            {
              id: 'chat',
              label: { en: 'Conversation', 'zh-CN': '对话' },
              binding: {
                kind: 'revisioned-rpc',
                service: 'fixtureSettings',
                active: ['settings', 'chat'],
                selection: ['settings', 'chat', 'selected'],
                profiles: ['settings', 'chat', 'profiles'],
                idKey: 'id',
                snapshotKey: 'snapshot',
                fields: { endpoint: 'baseUrl', key: 'apiKey', model: 'model', mode: 'engine' },
              },
              backends: alternate
                ? [
                    conversationBackend,
                    { ...conversationBackend, id: 'alternate', mode: 'alternate-api', label: { en: 'Alternate interface', 'zh-CN': '备用接口' } },
                  ]
                : [conversationBackend],
            },
          ],
          serviceFieldLabels: [{ slot: 'chat', backend: 'openai', field: 'MODEL', label: { en: 'Model name', 'zh-CN': '模型名称' } }],
        },
      ],
    })
  const plugin = makePlugin()
  const alternatePlugin = makePlugin(true)
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
          runtimeRevision: declaredRuntimeRevision(),
          title: 'Fixture editor',
          description: '',
          services: ['fixtureSettings'],
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
    await page.getByRole('button', { name: /^(Skip for now and finish installation|暂时跳过，完成安装)$/u }).click()
    await page.waitForURL(`${origin}/admin`)
    const { repository, commit } = officeInputs.onlyofficeSdk
    const onlyOffice = withSuiteCatalogContentHash({
      kind: 'plugin',
      id: 'onlyoffice',
      version: '7.8.9',
      engines: { platform: '>=0.1.35' },
      adapters: [],
      title: { en: 'OnlyOffice', 'zh-CN': 'OnlyOffice' },
      description: { en: 'OnlyOffice', 'zh-CN': 'OnlyOffice' },
      identity: { en: 'OnlyOffice', 'zh-CN': 'OnlyOffice' },
      source: { en: 'Plugin package; SDK at pinned commit', 'zh-CN': '插件包；SDK固定提交' },
      dependencies: [],
      items: [
        {
          kind: 'runtime-dependency',
          type: 'resource',
          name: 'onlyoffice-sdk',
          paths: [],
          commands: [],
          downloads: [
            {
              source: 'github-assets',
              url: `${repository}/raw/${commit}/LICENSE`,
              sha256: { amd64: 'a'.repeat(64), arm64: 'a'.repeat(64) },
              target: 'LICENSE',
            },
          ],
        },
        {
          kind: 'plugin',
          packageName: officeInputs.onlyofficePlugin.package,
          version: officeInputs.onlyofficePlugin.version,
          integrity: officeInputs.onlyofficePlugin.integrity,
          runtimeDependencies: ['onlyoffice-sdk'],
          catalogDependencies: [],
          access: { environment: [], entriesYaml: '' },
        },
      ],
    })
    catalog.publish([onlyOffice])
    await page.setViewportSize({ width: 390, height: 844 })
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      await page.goto(origin + '/admin/plugins?tab=catalog')
      await page.getByRole('button', { name: 'View catalog entry OnlyOffice', exact: true }).click()
      const facts = page.getByRole('dialog', { name: 'OnlyOffice' }).locator('.catalog-entry-facts')
      const packageLink = facts.getByRole('link', { name: officeInputs.onlyofficePlugin.package })
      expect(await packageLink.getAttribute('href')).toBe(`https://www.npmjs.com/package/${officeInputs.onlyofficePlugin.package}`)
      await facts.getByText(`Available version ${officeInputs.onlyofficePlugin.version}`, { exact: true }).waitFor()
      const sdk = facts.locator('dd').filter({ hasText: 'onlyoffice-sdk' })
      expect(await sdk.getByRole('link').getAttribute('href')).toBe(`${repository}/tree/${commit}`)
      await sdk.getByText(commit, { exact: true }).waitFor()
      expect(await facts.locator('dt').allTextContents()).toEqual(['Package', 'Runtime dependencies'])
      expect(await facts.getByText(/7\.8\.9/u).count()).toBe(0)
      expect(await sdk.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
      expect(await page.locator('html').getAttribute('data-theme')).toBe(colorScheme)
    }
    await page.setViewportSize({ width: 1280, height: 720 })
    for (const zh of [false, true]) {
      catalog.publish([zh ? alternatePlugin : plugin])
      await page.context().addCookies([{ name: 'dsh-phalanx.lang', value: zh ? 'zh-CN' : 'en', url: origin }])
      const title = localized[zh ? 'zh-CN' : 'en']
      await page.goto(origin + '/admin/skills?tab=catalog')
      expect(await page.getByRole('button', { name: zh ? `查看广场条目 ${title}` : `View catalog entry ${title}`, exact: true }).count()).toBe(0)
      await page.goto(origin + '/admin/plugins?tab=catalog')
      await page.getByRole('tab', { name: zh ? '插件广场' : 'Plugin catalog', exact: true, selected: true }).waitFor()
      const card = page
        .locator('.plugin-library-card')
        .filter({ has: page.getByRole('button', { name: zh ? `查看广场条目 ${title}` : `View catalog entry ${title}`, exact: true }) })
      expect(await card.getByRole('button', { name: zh ? '安装' : 'Install', exact: true }).count()).toBe(0)
      const open = card.getByRole('button', { name: zh ? `查看广场条目 ${title}` : `View catalog entry ${title}`, exact: true })
      expect(await card.locator('.catalog-card-meta').innerText()).toBe(zh ? '平台广场 · 可安装版本 1.0.0' : 'Platform catalog · Available version 1.0.0')
      expect(await card.locator('.card__description').count()).toBe(0)
      await open.click()
      let dialog = page.getByRole('dialog', { name: title, exact: true })
      const sections = dialog.locator('.catalog-install-sections > .plugin-detail-section')
      await dialog.getByRole('heading', { name: zh ? '来源' : 'Source', exact: true }).waitFor()
      const sourceLink = dialog.getByRole('link', { name: '@fixture/editor', exact: true })
      await sourceLink.waitFor()
      expect(await sourceLink.getAttribute('href')).toBe('https://www.npmjs.com/package/@fixture/editor')
      const sourceFacts = dialog.locator('.catalog-entry-facts')
      await sourceFacts.getByText(zh ? '可安装版本 1.0.0' : 'Available version 1.0.0', { exact: true }).waitFor()
      expect(await dialog.getByText(/7\.8\.9/u).count()).toBe(0)
      await sourceFacts.getByText('@fixture/editor', { exact: true }).first().waitFor()
      const { sourceLeft, valueOffsets } = await sourceFacts.evaluate(list => ({
        sourceLeft: list.querySelector('a')?.getBoundingClientRect().left,
        valueOffsets: [...new Set([...list.querySelectorAll('dd')].map(value => value.getBoundingClientRect().left))],
      }))
      expect(valueOffsets).toEqual([sourceLeft])
      expect(await dialog.getByText(zh ? '技术详情' : 'Technical details', { exact: true }).count()).toBe(0)
      await dialog.getByRole('heading', { name: zh ? '将安装' : 'This entry will install', exact: true }).waitFor()
      await dialog.getByRole('heading', { name: zh ? '对话' : 'Conversation', exact: true }).waitFor()
      expect(await dialog.getByRole('heading', { name: title, exact: true }).count()).toBe(1)
      expect(await sections.count()).toBe(4)
      expect(await sections.evaluateAll(nodes => nodes[1]!.getBoundingClientRect().top - nodes[0]!.getBoundingClientRect().bottom)).toBe(12)
      const dialogModel = dialog
        .getByRole('region', { name: zh ? '对话' : 'Conversation', exact: true })
        .getByRole('textbox', { name: zh ? '模型名称' : 'Model name', exact: true })
      await dialogModel.waitFor()
      if (!zh) expect(await dialog.getByText('OpenAI compatible', { exact: true }).count()).toBe(0)
      await dialog.getByText(/^MODEL · /u).waitFor()
      const installButton = dialog.getByRole('button', { name: zh ? '安装条目' : 'Install entry', exact: true })
      await dialogModel.fill('incomplete-model')
      await dialog.getByText(zh ? /^待填写：/u : /^Fields to configure:/u).waitFor()
      expect(await installButton.isDisabled()).toBe(true)
      const chooseConversation = async (label: string) => {
        await dialog.getByRole('button', { name: /接口/u }).click()
        await page.getByRole('option', { name: label, exact: true }).click()
      }
      if (zh) {
        await chooseConversation('备用接口')
        await dialog.getByText('请完成或跳过这些接口的配置：OpenAI 兼容。', { exact: true }).waitFor()
        expect(await installButton.isDisabled()).toBe(true)
        await chooseConversation('OpenAI 兼容')
      }
      await dialog.getByRole('button', { name: zh ? '跳过此项配置' : 'Skip this configuration', exact: true }).click()
      expect(await installButton.isEnabled()).toBe(true)
      const publish = dialog.getByRole('checkbox', { name: zh ? '发布到平台应用中心' : 'Publish to the platform app center', exact: true })
      expect(await publish.isChecked()).toBe(false)
      if (!zh) {
        await publish.press('Space')
        expect(await publish.isChecked()).toBe(true)
      }
      if (zh) {
        await dialog.getByLabel('URL', { exact: true }).fill('https://conversation.example.test/v1')
        await dialog.getByLabel('KEY', { exact: true }).fill('fictional-conversation-key')
        await dialogModel.fill('installed-conversation-model')
        await chooseConversation('备用接口')
        await dialog.getByRole('button', { name: '添加分组', exact: true }).click()
        const picker = page.getByRole('dialog', { name: '添加分组', exact: true })
        const group = picker.getByRole('checkbox', { name: '默认分组', exact: true })
        await group.press('Space')
        expect(await group.isChecked()).toBe(true)
        await picker.getByRole('button', { name: '确认选择', exact: true }).click()
        await dialog.getByText('默认分组', { exact: true }).waitFor()
      } else {
        const stale = await page.request.post(origin + '/admin/api/suites', {
          headers: { origin },
          data: { action: 'install', input: { id: 'fixture-editor', requestId: 'fixture-preview-stale-01', preview: { version: '0.9.0' } } },
        })
        expect(stale.status()).toBe(409)
        expect(await stale.json()).toMatchObject({ code: 'suite-preview-changed' })
        const image = dialog.getByRole('region', { name: 'Image generation', exact: true })
        await image.getByLabel('Upstream address', { exact: true }).fill('https://images.example.test/v1')
        await image.getByLabel('API key', { exact: true }).fill('fictional-image-key')
        await image.getByLabel('Model name', { exact: true }).fill('installed-image-model')
      }
      await installButton.click()
      await dialog
        .getByText(zh ? '已安装' : 'Installed', { exact: true })
        .first()
        .waitFor()
      if (!zh) {
        await dialog.getByText('installed-image-model', { exact: true }).waitFor()
        const image = (await (await page.request.get(origin + '/admin/api/plugins/upstreams?packageName=' + encodeURIComponent('@fixture/editor'))).json())[0]
        expect(image.credential).toEqual({ configured: true, last4: '' })
        expect(JSON.stringify(image)).not.toContain('fictional-image-key')
        const editImage = async (enabled: boolean) => {
          await dialog.getByRole('button', { name: 'Edit configuration', exact: true }).click()
          const editor = page.getByRole('dialog', { name: 'Image generation', exact: true })
          const toggle = editor.getByRole('checkbox', { name: 'Enable image generation', exact: true })
          expect(await toggle.isChecked()).toBe(!enabled)
          await toggle.press('Space')
          await editor.getByRole('button', { name: 'Save changes', exact: true }).click()
          await editor.waitFor({ state: 'hidden' })
          await dialog.getByText(enabled ? 'Access configured' : 'Disabled', { exact: true }).waitFor()
        }
        await editImage(false)
        await editImage(true)
      } else {
        const conversation = dialog.getByRole('region', { name: '对话', exact: true })
        expect(await conversation.getByLabel('模型名称', { exact: true }).inputValue()).toBe('installed-conversation-model')
        expect(await conversation.getByLabel('KEY', { exact: true }).inputValue()).toBe('')
      }
      await expect
        .poll(async () => {
          const rows = (await (await page.request.get(origin + '/admin/api/plugins')).json()) as { packageName: string; published: boolean }[]
          return rows.find(row => row.packageName === '@fixture/editor')?.published
        })
        .toBe(!zh)
      const installedDisplay = async () => {
        const rows = (await (await page.request.get(origin + '/admin/api/plugins')).json()) as { packageName: string; display?: unknown }[]
        return rows.find(row => row.packageName === '@fixture/editor')?.display
      }
      expect(await installedDisplay()).toMatchObject({ catalogDefaults: { title: localized, description: localized } })
      if (!zh) {
        const database = await openTestDatabase(root)
        try {
          const store = new PostgresPluginLibraryStore(database)
          const { display: _addedInNewVersion, ...legacy } = (await store.list()).find(row => row.packageName === '@fixture/editor')!
          void _addedInNewVersion
          await store.save(legacy)
        } finally {
          await database.close()
        }
        expect(await installedDisplay()).toBeUndefined()
        expect((await page.request.get(origin + '/admin/api/suites')).ok()).toBe(true)
        expect(await installedDisplay()).toMatchObject({ catalogDefaults: { title: localized, description: localized } })
      }
      if (zh) {
        const groups = (await (await page.request.get(origin + '/admin/api/groups')).json()) as { id: string; kind: string }[]
        const group = groups.find(row => row.kind !== 'admin')!
        await expect
          .poll(async () => {
            const configured = await (await page.request.get(origin + '/admin/api/groups/' + group.id + '/plugins')).json()
            return configured.plugins.find((row: { packageName: string }) => row.packageName === '@fixture/editor')
          })
          .toMatchObject({ preinstalled: true, granted: false })
        const stale = await page.request.post(origin + '/admin/api/groups/' + group.id + '/plugins', {
          headers: { origin },
          data: { action: 'catalog-preinstall', plugin: { packageName: '@fixture/editor', integrity: 'stale-integrity', entryId: 'fixture-editor' } },
        })
        expect(stale.status()).toBe(409)
      }
      await dialog.getByText(zh ? '任务日志' : 'Task log', { exact: true }).click()
      const log = dialog.locator('.plugin-preparation-log')
      expect(await log.innerText()).toContain('Installed.')
      expect(await log.innerText()).not.toContain('7.8.9')
      await dialog.getByRole('button', { name: zh ? '关闭广场条目详情' : 'Close catalog entry details', exact: true }).click()
      await card.getByText(zh ? /库内已安装版本 1\.0\.0/u : /Installed library version 1\.0\.0/u).waitFor()
      if (!zh) {
        if (plugin.kind !== 'plugin') throw Error('Expected a plugin entry')
        const packageItem = plugin.items[0]!
        if (packageItem.kind !== 'plugin') throw Error('Expected a plugin fixture')
        catalog.publish([{ ...plugin, version: '7.9.0', items: [{ ...packageItem, packageName: '@fixture/replacement', version: '1.2.0' }] }])
        await page.reload()
        await open.click()
        const packageFacts = dialog.locator('.catalog-entry-facts > div')
        const installedPackage = packageFacts.filter({ hasText: 'Installed library package' })
        await installedPackage.getByText('@fixture/editor', { exact: true }).waitFor()
        await installedPackage.getByText('Installed library version 1.0.0', { exact: true }).waitFor()
        const targetPackage = packageFacts.filter({ hasText: 'Catalog target package' })
        await targetPackage.getByRole('link', { name: '@fixture/replacement', exact: true }).waitFor()
        await targetPackage.getByText('Catalog target version 1.2.0', { exact: true }).waitFor()
        const showUpdate = async (item: typeof packageItem) => {
          catalog.publish([{ ...plugin, version: '7.9.0', items: [item] }])
          await page.reload()
          await card.getByRole('button', { name: 'Update', exact: true }).click()
          return page.getByRole('dialog', { name: title })
        }
        let update = await showUpdate({ ...packageItem, version: '1.2.0' })
        await update.getByText('Plugin @fixture/editor: 1.0.0 → 1.2.0', { exact: true }).waitFor()
        expect(await update.getByText(/7\.8\.9|7\.9\.0/u).count()).toBe(0)
        update = await showUpdate({ ...packageItem, access: { environment: [], entriesYaml: '' } })
        await update.getByText('The plugin version is unchanged. Configuration or runtime dependencies have changed.', { exact: true }).waitFor()
        update = await showUpdate({ ...packageItem, integrity: 'sha512-' + Buffer.alloc(64, 2).toString('base64') })
        await update.getByText('Plugin package contents have changed.', { exact: true }).waitFor()
        catalog.fail(true)
        await page.reload()
        const outside = page.getByRole('region', { name: 'Installed entries outside the catalog' })
        await outside.getByText('Installed library version 1.0.0 · Catalog target version unknown', { exact: true }).waitFor()
        expect(await outside.getByText(/7\.8\.9/u).count()).toBe(0)
        await page.route('**/admin/api/plugins', async route => {
          const response = await route.fetch()
          const rows = (await response.json()) as { packageName: string; currentVersion: string | null }[]
          await route.fulfill({ response, json: rows.map(row => (row.packageName === '@fixture/editor' ? { ...row, currentVersion: null } : row)) })
        })
        await page.reload()
        await outside.getByText('Installed version unknown · Catalog target version unknown', { exact: true }).waitFor()
        await page.unroute('**/admin/api/plugins')
        await page.getByRole('tab', { name: 'Plugins', exact: true }).click()
        const openPlugin = page.getByRole('button', { name: 'View plugin @fixture/editor', exact: true })
        await openPlugin.click()
        await page.getByRole('dialog', { name: 'Fixture editor', exact: true }).getByText('Fixture editor', { exact: true }).nth(1).waitFor()
        const displaySection = page.getByRole('region', { name: 'Display information', exact: true })
        const displayName = displaySection.getByRole('textbox', { name: 'Display name', exact: true })
        const basic = page.getByRole('tabpanel', { name: 'Basic settings', exact: true })
        expect(await basic.getByRole('heading').first().textContent()).toBe('Platform App Center')
        expect(await displayName.getAttribute('placeholder')).toBe('Fixture editor')
        await displayName.fill('x'.repeat(201))
        await page.getByRole('tab', { name: 'Access settings', exact: true }).click()
        await page.getByRole('button', { name: 'Close plugin details', exact: true }).click()
        await page.getByRole('dialog', { name: 'Unsaved changes', exact: true }).getByRole('button', { name: 'Save changes', exact: true }).click()
        await displaySection.getByRole('alert').getByText('Invalid plugin display information.', { exact: true }).waitFor()
        expect(await displayName.inputValue()).toBe('x'.repeat(201))
        await displayName.fill('Team editor')
        await displaySection.getByRole('textbox', { name: 'Function description', exact: true }).fill('Team editing workflow')
        await displaySection.getByRole('button', { name: 'Save display information', exact: true }).click()
        await page.getByRole('dialog', { name: 'Team editor', exact: true }).getByRole('paragraph').filter({ hasText: 'Team editing workflow' }).waitFor()
        expect(await installedDisplay()).toMatchObject({ name: 'Team editor', description: 'Team editing workflow', catalogDefaults: { title: localized } })
        const edited = (await (await page.request.get(origin + '/admin/api/plugins')).json()).find(
          (row: { packageName: string }) => row.packageName === '@fixture/editor',
        )
        expect(edited.suiteOrigin).toBe('suite:fixture-editor')
        await displaySection.getByRole('button', { name: 'Restore defaults', exact: true }).click()
        await page.getByRole('dialog', { name: 'Fixture editor', exact: true }).waitFor()
        expect(await displayName.inputValue()).toBe('')
        expect(await installedDisplay()).not.toHaveProperty('name')
        await page.getByRole('button', { name: 'Uninstall', exact: true }).click()
        const offlineUninstall = page.getByRole('dialog').filter({ has: page.getByRole('button', { name: 'Confirm uninstall', exact: true }) })
        await offlineUninstall.getByText('This will remove:', { exact: true }).waitFor()
        await offlineUninstall.getByRole('button', { name: 'Cancel', exact: true }).click()
        const db = await openTestDatabase(root)
        try {
          const installs = new PostgresCatalogInstalls(db)
          await installs.save({
            id: 'dependent-entry',
            version: '1.0.0',
            status: 'installed',
            category: 'suite',
            updatedAt: Date.now(),
            entries: [],
            dependencies: ['fixture-editor'],
            log: '',
          })
          const assertBlocked = async () => {
            await offlineUninstall.getByText('Catalog entry · dependent-entry → fixture-editor', { exact: true }).waitFor()
            expect(await offlineUninstall.getByRole('button', { name: 'Confirm uninstall', exact: true }).isDisabled()).toBe(true)
            await offlineUninstall.getByRole('button', { name: 'Cancel', exact: true }).click()
          }
          await page.getByRole('button', { name: 'Uninstall', exact: true }).click()
          await assertBlocked()
          await page.getByRole('button', { name: 'Close plugin details', exact: true }).click()
          catalog.fail(false)
          catalog.publish([plugin])
          await page.getByRole('tab', { name: 'Plugin catalog', exact: true }).click()
          await card.getByRole('button', { name: 'Uninstall', exact: true }).click()
          await assertBlocked()
          const reference = (await installs.get('dependent-entry'))!
          await installs.remove(reference.record.id, reference.revision)
        } finally {
          await db.close()
        }
        expect(
          (
            await page.request.post(origin + '/admin/api/accounts', {
              headers: { origin },
              data: { username: 'catalog-member', password: 'password', email: '' },
            })
          ).ok(),
        ).toBe(true)
        const member = await browser.newContext()
        try {
          expect(
            (
              await member.request.post(origin + '/login', { headers: { origin }, form: { username: 'catalog-member', password: 'password' }, maxRedirects: 0 })
            ).status(),
          ).toBe(303)
          expect(
            (
              await member.request.post(origin + '/admin/api/suites', {
                headers: { origin },
                data: { action: 'uninstall', id: 'fixture-editor', input: {} },
              })
            ).ok(),
          ).toBe(false)
          expect(
            (
              await member.request.post(origin + '/admin/api/plugins/display', {
                headers: { origin },
                data: { packageName: '@fixture/editor', display: { name: 'Unprivileged edit' } },
              })
            ).status(),
          ).toBe(403)
        } finally {
          await member.close()
        }
        catalog.fail(true)
        await page.getByRole('tab', { name: 'Plugins', exact: true }).click()
        const openAccessSettings = async () => {
          await openPlugin.click()
          await page.getByRole('tab', { name: 'Access settings', exact: true }).click()
          const service = page.getByRole('region', { name: 'Access settings', exact: true })
          await page.getByText('Advanced settings', { exact: true }).waitFor()
          expect(await page.getByRole('button', { name: 'Add upstream', exact: true }).isVisible()).toBe(false)
          await service.getByLabel('Model name', { exact: true }).waitFor()
          return service
        }
        const service = await openAccessSettings()
        await service.getByText('installed-image-model', { exact: true }).waitFor()
        await service.getByRole('button', { name: 'Edit configuration', exact: true }).click()
        const imageEditor = page.getByRole('dialog', { name: 'Image generation', exact: true })
        expect(await imageEditor.getByLabel('API key', { exact: true }).inputValue()).toBe('')
        await imageEditor.getByLabel('Model name', { exact: true }).fill('offline-image-model')
        await imageEditor.getByRole('button', { name: 'Save changes', exact: true }).click()
        await service.getByText('offline-image-model', { exact: true }).waitFor()
        await service.getByText('Access configured', { exact: true }).waitFor()
        await service.getByLabel('URL', { exact: true }).fill('https://service.example.test/v1')
        await service.getByLabel('KEY', { exact: true }).fill('fixture-service-key')
        const model = service.getByLabel('Model name', { exact: true })
        await model.fill('fixture-model')
        const closePlugin = page.getByRole('button', { name: 'Close plugin details', exact: true })
        await closePlugin.click()
        await page.getByRole('dialog', { name: 'Unsaved changes', exact: true }).getByRole('button', { name: 'Continue editing', exact: true }).click()
        await service.getByRole('button', { name: 'Save configuration', exact: true }).click()
        await service.getByText('Service configuration saved.', { exact: true }).waitFor()
        await closePlugin.click()
        const reopened = await openAccessSettings()
        expect(await reopened.getByLabel('Model name', { exact: true }).inputValue()).toBe('fixture-model')
        expect(await reopened.getByLabel('KEY', { exact: true }).inputValue()).toBe('')
        await reopened.getByLabel('Model name', { exact: true }).fill('unsaved-model')
        await page.getByRole('tab', { name: 'Basic settings', exact: true }).click()
        await page.getByRole('button', { name: 'Plugin catalog', exact: true }).click()
        await page.getByRole('dialog', { name: 'Unsaved changes', exact: true }).getByRole('button', { name: 'Discard changes', exact: true }).click()
        await page.getByRole('tab', { name: 'Plugin catalog', exact: true, selected: true }).waitFor()
        catalog.fail(false)
        catalog.publish([plugin])
        await page.reload()
        await open.click()
        await dialog.getByText('offline-image-model', { exact: true }).waitFor()
        expect(await dialog.getByText('Advanced settings', { exact: true }).count()).toBe(0)
        await dialog.getByRole('button', { name: 'Close catalog entry details', exact: true }).click()
        await page.getByRole('tab', { name: 'Plugins', exact: true }).click()
        await openAccessSettings()
        await page.getByText('Advanced settings', { exact: true }).click()
        await page.getByRole('button', { name: 'Add upstream', exact: true }).waitFor()
        await closePlugin.click()
        await page.getByRole('tab', { name: 'Plugin catalog', exact: true }).click()
        await open.click()
        const secondContext = await browser.newContext({ locale: 'en', storageState: await page.context().storageState() })
        const secondPage = await secondContext.newPage()
        try {
          await secondPage.goto(origin + '/admin/plugins')
          await secondPage.getByRole('button', { name: 'View plugin @fixture/editor', exact: true }).click()
          await secondPage.getByRole('tab', { name: 'Access settings', exact: true }).click()
          const staleService = secondPage.getByRole('region', { name: 'Conversation', exact: true })
          await staleService.getByLabel('KEY', { exact: true }).fill('stale-fixture-key')
          const freshService = dialog.getByRole('region', { name: 'Conversation', exact: true })
          await freshService.getByLabel('KEY', { exact: true }).fill('new-fixture-key')
          await freshService.getByLabel('Model name', { exact: true }).fill('fresh-model')
          await freshService.getByRole('button', { name: 'Save configuration', exact: true }).click()
          await dialog.getByText('Service configuration saved.', { exact: true }).waitFor()
          await staleService.getByRole('button', { name: 'Save configuration', exact: true }).click()
          await secondPage.getByRole('button', { name: 'Retry loading configuration', exact: true }).click()
          await expect.poll(() => staleService.getByLabel('Model name', { exact: true }).inputValue()).toBe('fresh-model')
          expect(await staleService.getByLabel('KEY', { exact: true }).inputValue()).toBe('')
          expect(await staleService.getByRole('button', { name: 'Save configuration', exact: true }).isDisabled()).toBe(true)
        } finally {
          await secondContext.close()
        }
        await dialog.getByRole('button', { name: 'Close catalog entry details', exact: true }).click()
      }
      if (zh) {
        await card.getByRole('button', { name: '卸载', exact: true }).click()
        await dialog.getByText('将移除：', { exact: true }).waitFor()
        await dialog.getByRole('button', { name: '确认卸载', exact: true }).click()
      } else {
        catalog.fail(true)
        await page.getByRole('tab', { name: 'Plugins', exact: true }).click()
        const installed = page.getByRole('button', { name: 'View plugin @fixture/editor', exact: true })
        await installed.click()
        await page.getByRole('button', { name: 'Uninstall', exact: true }).click()
        const confirm = page.getByRole('button', { name: 'Confirm uninstall', exact: true })
        await page.getByText('This will remove:', { exact: true }).waitFor()
        let statusReads = 0
        await page.route('**/admin/api/suites?local=1', route =>
          ++statusReads === 1 ? route.fulfill({ status: 503, json: { code: 'platform-database-unavailable' } }) : route.continue(),
        )
        await confirm.click()
        await installed.waitFor({ state: 'hidden' })
        await expect.poll(() => statusReads).toBeGreaterThanOrEqual(2)
        await page.unroute('**/admin/api/suites?local=1')
        catalog.fail(false)
        await page.getByRole('tab', { name: 'Plugin catalog', exact: true }).click()
      }
      await card.getByText(zh ? '未安装' : 'Not installed', { exact: true }).waitFor()
      // The installation row disappears before catalog cleanup releases its claim.
      // Only this explicit admission rejection is safe to submit again.
      let add: Awaited<ReturnType<typeof page.request.post>> | undefined
      let addResult: { code?: string; token?: string } | undefined
      let requestFailure: { error: unknown } | undefined
      await expect
        .poll(
          async () => {
            try {
              add = await page.request.post(origin + '/admin/api/plugins/previews', {
                headers: { origin },
                data: { input: '@fixture/editor@0.9.0' },
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
      expect(addResult?.token).toEqual(expect.any(String))
      await expect
        .poll(async () => (await (await page.request.get(origin + '/admin/api/plugins/previews?token=' + addResult!.token)).json()).stage)
        .toBe('ready')
      expect(
        (await page.request.post(origin + '/admin/api/plugins/previews/confirm', { headers: { origin }, data: { token: addResult!.token } })).status(),
      ).toBe(200)
      await expect.poll(async () => ((await (await page.request.get(origin + '/admin/api/plugins')).json()) as { stage: string }[])[0]?.stage).toBe('available')
      await open.click()
      await dialog.getByText(zh ? '替代这些手动条目' : 'Replace these manual entries', { exact: true }).click()
      await dialog.getByRole('button', { name: zh ? '安装条目' : 'Install entry', exact: true }).click()
      await dialog
        .getByText(zh ? '已安装' : 'Installed', { exact: true })
        .first()
        .waitFor()
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
