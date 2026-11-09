// Validation: T1; real credentials: none; controlled browser/process fixtures. CI selects its explicit public-entry subset.
import { prepareAndConfirmNpmPluginInBrowser, prepareAndConfirmNpmPlugin } from './support/plugin-intake.js'
import { createServer } from 'node:http'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { declaredRuntimeRevision } from '../src/adapters/runtime-revision.js'
import type { CommunityGroupView, CommunityPluginView } from '../src/domain/admin-contract.js'
import { platformText } from '../src/domain/platform-copy.js'
import type { CommunityRuntimePort } from '../src/ports/community-runtime.js'
import { signInCommunity } from './fixtures/community-native-browser.js'
import { expertApplication } from './fixtures/expert-application.js'
import { cleanupOwned, removeCommunityFixture } from './fixtures/owned-cleanup.js'
import { createCommunityApplication } from './support/community-application.js'
import { selectBuiltinDatabase } from './support/community-bootstrap-browser.js'

it('prechecks and confirms version changes through HeroUI, projects pending members and removes grants/publication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-changes-ui-'))
  let finish!: () => void
  const gate = new Promise<void>(resolve => {
    finish = resolve
  })
  const installed = [{ packageName: 'plugin', version: '1.0.0' }]
  let latest = '1.0.0'
  const registry = createServer((request, response) => {
    const versions = Object.fromEntries(['1.0.0', '2.0.0', '3.0.0'].map(version => [version, { name: 'plugin', version }]))
    response.writeHead(request.url === '/registry/plugin' ? 200 : 404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ name: 'plugin', 'dist-tags': { latest }, versions }))
  })
  await new Promise<void>(resolve => registry.listen(0, '127.0.0.1', resolve))
  const registryAddress = registry.address()
  if (!registryAddress || typeof registryAddress === 'string') throw Error('Missing registry fixture address')
  const instance = { userId: 'member', origin: 'http://example.test', launchUrl: 'http://example.test', processId: 1 }
  const runtime: CommunityRuntimePort = {
    ensure: async () => instance,
    restart: async () => instance,
    recover: async () => instance,
    reclaim: async () => 'not-running',
    terminate: async () => {},
    status: username =>
      username === 'member' ? { state: 'ready', instance: { ...instance, managedSnapshot: ['plugin@1.0.0:sha512-1.0.0'] } } : { state: 'stopped' },
    stopAll: async () => {},
    reconcileStartupContainers: async () => ({ adopted: [], swept: [] }),
  }
  const app = createCommunityApplication(
    {
      listen: { host: '127.0.0.1', port: 0 },
      sessionSecret: 'plugin-changes-ui-fixture-secret-value',
      downloadSources: { preset: 'official', overrides: { npm: `http://127.0.0.1:${registryAddress.port}/registry` } },
      runtime: {
        command: '/unavailable',
        args: [],
        dataRoot: root,
        defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'https://example.test' } },
      },
    },
    {
      runtime,
      pluginPreparer: {
        prepare: async input => {
          if (input.version === '2.0.0') await gate
          if (input.version === '3.0.0') throw Error('fixture incompatible version')
          return {
            ...input,
            title: 'Shared plugin',
            description: '',
            artifact: 'artifacts/fixture',
            integrity: `sha512-${input.version}`,
            runtimeRevision: declaredRuntimeRevision(),
            bundlePatch: '[]',
            dependencies: {},
          }
        },
      },
      pluginManager: {
        list: async () => installed,
        install: async () => {
          throw Error('Native installation is not used in library changes')
        },
        remove: async () => {
          throw Error('Native removal is not used in library changes')
        },
      },
    },
  )
  const browser = await chromium.launch({ headless: true })
  try {
    const origin = await app.start()
    const page = await browser.newPage({ locale: 'en' })
    page.setDefaultTimeout(15000)
    const cdp = await page.context().newCDPSession(page)
    if (process.env.DSH_PHALANX_E2E_CPU_THROTTLE) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
    await page.goto(`${origin}/bootstrap#credential=${readBootstrapCredential(root)!.credential}`)
    await selectBuiltinDatabase(page)
    await page.getByLabel('Username', { exact: true }).fill('admin')
    await page.getByLabel('Password', { exact: true }).fill('password')
    await page.getByRole('button', { name: 'Create administrator' }).click()
    await page.waitForURL(origin + '/admin')
    const post = async (path: string, data: object) => page.request.post(origin + '/admin/api/' + path, { headers: { origin }, data })
    const list = async () => (await (await page.request.get(origin + '/admin/api/plugins')).json()) as CommunityPluginView[]
    await prepareAndConfirmNpmPluginInBrowser(page.request, origin, 'plugin@1.0.0')
    const groups = (await (await page.request.get(origin + '/admin/api/groups')).json()) as CommunityGroupView[]
    const group = groups.find(row => row.isDefault)!
    await post('accounts', { username: 'member', password: 'password', email: '', groupId: group.id })
    await post(`groups/${group.id}/plugins`, {
      action: 'save',
      packages: ['plugin'],
      preinstalls: [],
      revision: (await (await page.request.get(origin + '/admin/api/' + `groups/${group.id}/plugins`)).json()).revision,
    })
    await post('plugins/publication', { action: 'publish', packageName: 'plugin', published: true })
    await page.getByRole('link', { name: 'Plugin library', exact: true }).click()
    await page.getByRole('button', { name: 'View plugin plugin', exact: true }).click()
    await page.getByRole('tab', { name: 'Basic settings', exact: true }).click()
    await page.getByRole('button', { name: 'Change npm version', exact: true }).click()
    await page.getByLabel('Exact version', { exact: true }).fill('2.0.0')
    await page.getByRole('button', { name: 'Start precheck', exact: true }).click()
    await page.getByText('Checking replacement…', { exact: true }).waitFor()
    expect((await list())[0]).toMatchObject({ currentVersion: '1.0.0', published: true })
    finish()
    await page.getByRole('button', { name: 'Select this version', exact: true }).click()
    const confirmation = page.getByRole('dialog', { name: 'Confirm version change', exact: true })
    await confirmation.getByText('This affects 1 groups and 1 members.', { exact: true }).waitFor()
    await confirmation.getByRole('button', { name: 'Confirm', exact: true }).click()
    await expect.poll(async () => (await list())[0]?.currentVersion).toBe('2.0.0')
    const details = await (await page.request.get(origin + `/admin/api/groups/${group.id}/plugins`)).json()
    expect(details.pendingMembers).toEqual(['member'])
    expect((await (await page.request.get(origin + '/market/api/plugins')).json()).plugins[0].status).toBe('native')
    latest = '2.0.0'
    await page.getByRole('button', { name: 'Check for updates', exact: true }).click()
    await page.getByText('2.0.0 is the latest npm version', { exact: true }).waitFor()
    expect(await page.getByRole('button', { name: 'Precheck update', exact: true }).count()).toBe(0)
    latest = '3.0.0'
    await page.getByRole('button', { name: 'Check for updates', exact: true }).click()
    await page.getByText('New version 3.0.0 available', { exact: true }).waitFor()
    expect((await list())[0]).toMatchObject({ currentVersion: '2.0.0' })
    expect((await list())[0]?.replacement?.version).not.toBe('3.0.0')
    const evidence = process.env.DSH_PHALANX_E2E_EVIDENCE_DIR
    if (evidence) {
      await mkdir(evidence, { recursive: true })
      await page.getByRole('button', { name: 'Precheck update', exact: true }).scrollIntoViewIfNeeded()
      await page.screenshot({ path: join(evidence, 'plugin-update-available.png'), fullPage: true, animations: 'disabled' })
    }
    await page.getByRole('button', { name: 'Precheck update', exact: true }).click()
    await page.getByText('Precheck failed', { exact: true }).waitFor()
    expect((await list())[0]?.replacement).toMatchObject({ version: '3.0.0', stage: 'failed' })
    expect(await page.getByRole('button', { name: 'Select this version', exact: true }).count()).toBe(0)
    expect((await list())[0]?.currentVersion).toBe('2.0.0')
    await page.getByRole('button', { name: 'Close plugin details', exact: true }).last().click()
    await page.getByRole('button', { name: /Platform language/ }).click()
    await page.getByRole('menuitemradio', { name: '简体中文', exact: true }).click()
    await page.getByRole('menuitemradio', { name: '简体中文', exact: true }).waitFor({ state: 'detached' })
    await page.getByRole('button', { name: '查看插件 plugin', exact: true }).click()
    await page.getByRole('tab', { name: '基础设置', exact: true }).click()
    await page.getByRole('button', { name: '更换 npm 版本', exact: true }).waitFor()
    await page.getByRole('button', { name: '检查更新', exact: true }).click()
    await page.getByText('有新版本 3.0.0', { exact: true }).waitFor()
    await page.getByRole('button', { name: '从插件库移除', exact: true }).click()
    const removal = page.getByRole('dialog', { name: '确认移除插件', exact: true })
    await removal.getByText('将影响 1 个分组、1 位成员。', { exact: true }).waitFor()
    await removal.getByText('移除将撤销平台管控和共享凭据自选，成员已安装的副本不会收回。', { exact: true }).waitFor()
    if (evidence) {
      await page.screenshot({ path: join(evidence, 'remove-confirmation-zh.png'), fullPage: true, animations: 'disabled' })
    }
    await removal.getByRole('button', { name: '确认', exact: true }).click()
    await page.getByText('尚无插件', { exact: true }).waitFor()
    expect(await (await page.request.get(origin + '/market/api/plugins')).json()).toMatchObject({ plugins: [] })
    expect((await (await page.request.get(origin + `/admin/api/groups/${group.id}/plugins`)).json()).plugins).toEqual([])
    expect(installed).toEqual([{ packageName: 'plugin', version: '1.0.0' }])
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
  } finally {
    finish()
    await cleanupOwned(
      () => browser.close(),
      () => app.stop(),
      () => new Promise<void>((resolve, reject) => registry.close(error => (error ? reject(error) : resolve()))),
      () => removeCommunityFixture(root),
    )
  }
})

for (const locale of ['en', 'zh-CN'] as const)
  it(`hides expert references in all four removal dialogs while retaining cancellation and stale confirmation (${locale})`, async () => {
    const fixture = await expertApplication({
        pluginPreparer: {
          prepare: async input => ({
            ...input,
            integrity: 'fixture',
            artifact: 'fixture',
            runtimeRevision: declaredRuntimeRevision(),
            title: 'Reports',
            description: 'Reports',
            dependencies: {},
            bundlePatch: JSON.stringify([{ id: 'tools', insert: [{ id: 'main', name: './main.js' }] }]),
          }),
        },
      }),
      { api, request, origin } = fixture,
      t = (key: Parameters<typeof platformText>[1], params?: Parameters<typeof platformText>[2]) => platformText(locale, key, params)
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
    try {
      browser = await chromium.launch({ headless: true })
      await fixture.uploadSkill('direct')
      await fixture.uploadSkill('bundled')
      const packs = await api<{ revision: string }>('skill-packs')
      await api('skill-packs', {
        action: 'save',
        revision: packs.revision,
        pack: { name: 'report-pack', description: 'Reports', skills: ['bundled'], instructions: '', published: false },
      })
      await prepareAndConfirmNpmPlugin(request, 'report-plugin@1.0.0')
      await expect.poll(async () => (await api<{ stage: string }[]>('plugins'))[0]?.stage).toBe('available')
      await api('mcp', { action: 'save', create: true, service: { name: 'p-reports', description: 'Reports', url: 'https://example.test' } })
      const addExpert = async (name: string, refs: object) => {
        const library = await api<{ revision: string }>('experts')
        await api('experts', {
          revision: library.revision,
          expert: { name, description: 'Reports', icon: 'W', persona: 'Write.', skills: [], skillPacks: [], ...refs },
        })
      }
      await addExpert('All expert', { skills: ['direct'], skillPacks: ['report-pack'], plugins: ['report-plugin'], mcp: ['p-reports'] })
      await addExpert('Skill expert', { skills: ['bundled'] })
      const before = await api('experts'),
        page = await browser.newPage({ locale: 'en' })
      page.setDefaultTimeout(10000)
      await signInCommunity(page, origin, 'admin', 'password', true)
      await page.context().addCookies([{ name: 'dsh-phalanx.lang', value: locale, url: origin }])
      const impactText = (names: string) => (locale === 'en' ? `Will be removed from experts: ${names}` : `将从专家 ${names} 中移除`)
      const openMcp = async () => {
        await page.goto(origin + '/admin/mcp')
        await page
          .locator('.mcp-service-card')
          .filter({ hasText: 'p-reports' })
          .getByRole('button', { name: t('Remove'), exact: true })
          .click()
        return page.getByRole('dialog', { name: t('Remove MCP service'), exact: true })
      }
      let dialog = await openMcp()
      // hidden in 0.1.32: references remain active without revealing expert names.
      await dialog.waitFor()
      expect(await dialog.getByText(impactText('All expert'), { exact: true }).count()).toBe(0)
      await dialog.getByRole('button', { name: t('Cancel'), exact: true }).click()
      await page.goto(origin + '/admin/plugins')
      await page.getByRole('button', { name: t('View plugin {name}', { name: 'report-plugin' }), exact: true }).click()
      await page.getByRole('tab', { name: t('Basic settings'), exact: true }).click()
      await page.getByRole('button', { name: t('Remove from library'), exact: true }).click()
      dialog = page.getByRole('dialog', { name: t('Confirm plugin removal'), exact: true })
      // hidden in 0.1.32: references remain active without revealing expert names.
      await dialog.waitFor()
      expect(await dialog.getByText(impactText('All expert'), { exact: true }).count()).toBe(0)
      await dialog.getByRole('button', { name: t('Cancel'), exact: true }).click()
      await page.goto(origin + '/admin/skills')
      await page.getByRole('button', { name: t('View skill {name}', { name: 'direct' }), exact: true }).click()
      await page.getByRole('tab', { name: t('Version management'), exact: true }).click()
      await page.getByRole('button', { name: t('Remove skill'), exact: true }).click()
      dialog = page.getByRole('dialog', { name: t('Remove skill'), exact: true })
      // hidden in 0.1.32: references remain active without revealing expert names.
      await dialog.waitFor()
      expect(await dialog.getByText(impactText('All expert'), { exact: true }).count()).toBe(0)
      await dialog.getByRole('button', { name: t('Cancel'), exact: true }).click()
      await page.goto(origin + '/admin/skills')
      await page.getByRole('tab', { name: t('Skill packs'), exact: true }).click()
      await page.getByRole('button', { name: t('View skill pack {name}', { name: 'report-pack' }), exact: true }).click({ position: { x: 12, y: 12 } })
      await page.getByRole('button', { name: t('Remove skill pack'), exact: true }).click()
      dialog = page.getByRole('dialog', { name: t('Remove skill pack'), exact: true }).last()
      // hidden in 0.1.32: references remain active without revealing expert names.
      await dialog.waitFor()
      expect(await dialog.getByText(impactText('All expert'), { exact: true }).count()).toBe(0)
      await dialog.getByText(t('Also delete eligible skills'), { exact: true }).click()
      expect(await dialog.getByText(/Skill expert/u).count()).toBe(0)
      await dialog.getByRole('button', { name: t('Cancel'), exact: true }).click()
      expect(await api('experts')).toEqual(before)
      dialog = await openMcp()
      // hidden in 0.1.32: references remain active without revealing expert names.
      await dialog.waitFor()
      expect(await dialog.getByText(impactText('All expert'), { exact: true }).count()).toBe(0)
      await addExpert('Late expert', { mcp: ['p-reports'] })
      await dialog.getByRole('button', { name: t('Confirm action'), exact: true }).click()
      await page.getByRole('alert').waitFor()
      expect((await api<{ experts: { mcp: string[] }[] }>('experts')).experts.filter(row => row.mcp.includes('p-reports'))).toHaveLength(2)
      dialog = await openMcp()
      await dialog.waitFor()
      expect(await dialog.getByText(/Late expert/u).count()).toBe(0)
      await dialog.getByRole('button', { name: t('Confirm action'), exact: true }).click()
      await expect.poll(async () => (await api<{ experts: { mcp: string[] }[] }>('experts')).experts.every(row => row.mcp.length === 0)).toBe(true)
      await page.goto(origin + '/admin/plugins')
      await page.getByRole('button', { name: t('View plugin {name}', { name: 'report-plugin' }), exact: true }).click()
      await page.getByRole('tab', { name: t('Basic settings'), exact: true }).click()
      await page.getByRole('button', { name: t('Remove from library'), exact: true }).click()
      dialog = page.getByRole('dialog', { name: t('Confirm plugin removal'), exact: true })
      // hidden in 0.1.32: references remain active without revealing expert names.
      await dialog.waitFor()
      expect(await dialog.getByText(impactText('All expert'), { exact: true }).count()).toBe(0)
      await dialog.getByRole('button', { name: t('Confirm'), exact: true }).click()
      await expect.poll(async () => (await api<{ experts: { plugins: string[] }[] }>('experts')).experts.every(row => row.plugins.length === 0)).toBe(true)
      await page.goto(origin + '/admin/skills')
      await page.getByRole('tab', { name: t('Skill packs'), exact: true }).click()
      await page.getByRole('button', { name: t('View skill pack {name}', { name: 'report-pack' }), exact: true }).click({ position: { x: 12, y: 12 } })
      await page.getByRole('button', { name: t('Remove skill pack'), exact: true }).click()
      dialog = page.getByRole('dialog', { name: t('Remove skill pack'), exact: true }).last()
      await dialog.getByText(t('Also delete eligible skills'), { exact: true }).click()
      expect(await dialog.getByText(/Skill expert/u).count()).toBe(0)
      await dialog.getByRole('button', { name: t('Confirm removal'), exact: true }).click()
      await expect
        .poll(async () => (await api<{ experts: { skillPacks: string[] }[] }>('experts')).experts.every(row => row.skillPacks.length === 0))
        .toBe(true)
      await page.goto(origin + '/admin/skills')
      await page.getByRole('button', { name: t('View skill {name}', { name: 'direct' }), exact: true }).click()
      await page.getByRole('tab', { name: t('Version management'), exact: true }).click()
      await page.getByRole('button', { name: t('Remove skill'), exact: true }).click()
      dialog = page.getByRole('dialog', { name: t('Remove skill'), exact: true })
      // hidden in 0.1.32: references remain active without revealing expert names.
      await dialog.waitFor()
      expect(await dialog.getByText(impactText('All expert'), { exact: true }).count()).toBe(0)
      await dialog.getByRole('button', { name: t('Confirm removal'), exact: true }).click()
      await expect
        .poll(async () =>
          (await api<{ experts: { skills: string[]; missing: string[] }[] }>('experts')).experts.every(
            row => row.skills.length === 0 && row.missing.length === 0,
          ),
        )
        .toBe(true)
    } finally {
      await cleanupOwned(
        async () => browser?.close(),
        () => fixture.close(),
      )
    }
  })
