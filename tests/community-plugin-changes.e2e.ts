import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { createCommunityApplication } from '../src/composition/community-application.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { declaredRuntimeRevision } from '../src/adapters/runtime-revision.js'
import type { CommunityRuntimePort } from '../src/ports/community-runtime.js'
import type { CommunityGroupView, CommunityPluginView } from '../src/domain/admin-contract.js'

it('prechecks and confirms version changes through HeroUI, projects pending members and removes grants/publication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-changes-ui-'))
  let finish!: () => void; const gate = new Promise<void>(resolve => { finish = resolve })
  const installed = [{ packageName: 'plugin', version: '1.0.0' }]
  const instance = { userId: 'member', origin: 'http://example.test', launchUrl: 'http://example.test', processId: 1 }
  const runtime: CommunityRuntimePort = { ensure: async () => instance, restart: async () => instance, recover: async () => instance, reclaim: async () => 'not-running', terminate: async () => {}, status: username => username === 'member' ? { state: 'ready', instance: { ...instance, managedSnapshot: ['plugin@1.0.0:sha512-1.0.0'] } } : { state: 'stopped' }, stopAll: async () => {}, reconcileStartupContainers: async () => ({ adopted: [], swept: [] }) }
  const app = createCommunityApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'plugin-changes-ui-fixture-secret-value', runtime: { command: '/unavailable', args: [], dataRoot: root, defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'https://example.test' } } } }, {
    runtime, pluginPreparer: { prepare: async input => {
      if (input.version === '2.0.0') await gate
      if (input.version === '3.0.0') throw Error('fixture incompatible version')
      return { ...input, title: 'Shared plugin', description: '', artifact: 'artifacts/fixture', integrity: `sha512-${input.version}`, runtimeRevision: declaredRuntimeRevision(), bundlePatch: '[]', dependencies: {} }
    } }, pluginManager: { list: async () => installed, install: async () => 'applied' },
  })
  const browser = await chromium.launch({ headless: true })
  try {
    const origin = await app.start(); const page = await browser.newPage({ locale: 'en' }); page.setDefaultTimeout(15000)
    const cdp = await page.context().newCDPSession(page)
    if (process.env.DSH_PHALANX_E2E_CPU_THROTTLE) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
    await page.goto(`${origin}/bootstrap#credential=${readBootstrapCredential(root)!.credential}`)
    await page.getByLabel('Username', { exact: true }).fill('admin'); await page.getByLabel('Password', { exact: true }).fill('password')
    await page.getByRole('button', { name: 'Create administrator' }).click(); await page.waitForURL(origin + '/admin')
    const post = async (path: string, data: object) => page.request.post(origin + '/admin/api/' + path, { headers: { origin }, data })
    const list = async () => (await (await page.request.get(origin + '/admin/api/plugins')).json()) as CommunityPluginView[]
    await post('plugins', { action: 'add', packageName: 'plugin', version: '1.0.0' })
    const groups = await (await page.request.get(origin + '/admin/api/groups')).json() as CommunityGroupView[]
    const group = groups.find(row => row.isDefault)!
    await post('accounts', { username: 'member', password: 'password', email: '', groupId: group.id })
    await post(`groups/${group.id}/plugins`, { action: 'save', packages: ['plugin'] })
    await post('plugins/publication', { action: 'publish', packageName: 'plugin', published: true })
    await page.getByRole('link', { name: 'Plugin library', exact: true }).click()
    await page.getByRole('button', { name: 'View plugin plugin', exact: true }).click()
    await page.getByRole('button', { name: 'Change npm version', exact: true }).click()
    await page.getByLabel('Exact version', { exact: true }).fill('2.0.0')
    await page.getByRole('button', { name: 'Start precheck', exact: true }).click()
    await page.getByText('Checking replacement…', { exact: true }).waitFor()
    expect((await list())[0]).toMatchObject({ currentVersion: '1.0.0', published: true })
    finish()
    await page.getByRole('button', { name: 'Select this version', exact: true }).click()
    const confirmation = page.getByRole('dialog', { name: 'Confirm version change', exact: true })
    await confirmation.getByText('This affects 2 groups and 2 members.', { exact: true }).waitFor()
    await confirmation.getByRole('button', { name: 'Confirm', exact: true }).click()
    await expect.poll(async () => (await list())[0]?.currentVersion).toBe('2.0.0')
    const details = await (await page.request.get(origin + `/admin/api/groups/${group.id}/plugins`)).json()
    expect(details.pendingMembers).toEqual(['member'])
    expect((await (await page.request.get(origin + '/market/api/plugins')).json())[0].status).toBe('update')
    await page.getByRole('button', { name: 'Change npm version', exact: true }).click()
    await page.getByLabel('Exact version', { exact: true }).fill('3.0.0')
    await page.getByRole('button', { name: 'Start precheck', exact: true }).click()
    await page.getByText('Precheck failed', { exact: true }).waitFor()
    expect(await page.getByRole('button', { name: 'Select this version', exact: true }).count()).toBe(0)
    expect((await list())[0]?.currentVersion).toBe('2.0.0')
    await page.getByRole('button', { name: 'Close plugin details', exact: true }).last().click()
    await page.getByRole('button', { name: /Platform language/ }).click(); await page.getByRole('option', { name: '简体中文', exact: true }).click()
    await page.getByRole('option', { name: '简体中文', exact: true }).waitFor({ state: 'detached' })
    await page.getByRole('button', { name: '查看插件 plugin', exact: true }).click()
    await page.getByRole('button', { name: '更换 npm 版本', exact: true }).waitFor()
    await page.getByRole('button', { name: '从插件库移除', exact: true }).click()
    const removal = page.getByRole('dialog', { name: '确认移除插件', exact: true })
    await removal.getByText('将影响 2 个分组、2 位成员。', { exact: true }).waitFor()
    const evidence = process.env.DSH_PHALANX_E2E_EVIDENCE_DIR
    if (evidence) { await mkdir(evidence, { recursive: true }); await page.screenshot({ path: join(evidence, 'remove-confirmation-zh.png'), fullPage: true, animations: 'disabled' }) }
    await removal.getByRole('button', { name: '确认', exact: true }).click()
    await page.getByText('尚无插件', { exact: true }).waitFor()
    expect(await (await page.request.get(origin + '/market/api/plugins')).json()).toEqual([])
    expect((await (await page.request.get(origin + `/admin/api/groups/${group.id}/plugins`)).json()).plugins).toEqual([])
    expect(installed).toEqual([{ packageName: 'plugin', version: '1.0.0' }])
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
  } finally { finish(); await browser.close(); await app.stop(); await rm(root, { recursive: true, force: true }) }
})
