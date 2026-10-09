import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { createCommunityApplication } from '../src/composition/community-application.js'
import { CommunityAccountStore } from '../src/adapters/community-account-store.js'
import { declaredRuntimeRevision } from '../src/adapters/runtime-revision.js'
import type { CommunityRuntimePort } from '../src/ports/community-runtime.js'

it('shows incompatible library and granted group state in English and Chinese and restores a compatible version', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-compatibility-ui-'))
  const accounts = new CommunityAccountStore(join(root, 'community-accounts.db'))
  await accounts.createFirstAdmin({ username: 'admin', email: '', password: 'password' }); accounts.close()
  const current = { packageName: 'plugin', version: '1.0.0', artifact: 'artifacts/fixture', integrity: 'sha512-1.0.0', runtimeRevision: 'old', title: 'Shared plugin', description: '', bundlePatch: '[]', dependencies: {} }
  await mkdir(join(root, 'plugins'))
  await writeFile(join(root, 'plugins/library.json'), JSON.stringify({ schema: 1, plugins: [{ packageName: 'plugin', version: '1.0.0', stage: 'available', current, published: true }] }))
  const instance = { userId: 'admin', origin: 'http://example.test', launchUrl: 'http://example.test', processId: 1 }
  const runtime: CommunityRuntimePort = { ensure: async () => instance, restart: async () => instance, recover: async () => instance, reclaim: async () => 'not-running', terminate: async () => {}, status: () => ({ state: 'stopped' }), stopAll: async () => {}, reconcileStartupContainers: async () => ({ adopted: [], swept: [] }) }
  const app = createCommunityApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'plugin-compatibility-ui-fixture-secret', runtime: { command: '/unavailable', args: [], dataRoot: root, defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'https://example.test' } } } }, {
    runtime, pluginPreparer: { prepare: async input => { if (input.version === '1.0.0') throw Error('incompatible'); return { ...current, ...input, integrity: 'sha512-2.0.0', runtimeRevision: declaredRuntimeRevision() } } },
  })
  const browser = await chromium.launch({ headless: true })
  try {
    const origin = await app.start(); const page = await browser.newPage({ locale: 'en' }); page.setDefaultTimeout(15000)
    await page.goto(origin + '/login'); await page.getByLabel('Username', { exact: true }).fill('admin'); await page.getByLabel('Password', { exact: true }).fill('password')
    await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await page.goto(origin + '/admin/plugins')
    await page.getByText('Incompatible with the current version', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'View plugin plugin', exact: true }).click()
    await page.getByText('Publication paused until a compatible version is selected.', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Close plugin details', exact: true }).last().click()
    await page.getByRole('button', { name: /Platform language/ }).click(); await page.getByRole('option', { name: '简体中文', exact: true }).click()
    await page.getByText('与当前版本不兼容', { exact: true }).waitFor()
    await page.getByRole('link', { name: '分组管理', exact: true }).click()
    await page.getByRole('row').filter({ hasText: '管理员分组' }).getByRole('button', { name: '详情', exact: true }).click()
    await page.getByText('与当前版本不兼容', { exact: true }).waitFor()
    const evidence = process.env.DSH_PHALANX_E2E_EVIDENCE_DIR
    if (evidence) { await mkdir(evidence, { recursive: true }); await page.screenshot({ path: join(evidence, 'incompatible-group-zh.png'), fullPage: true, animations: 'disabled' }) }
    await page.getByRole('button', { name: '关闭分组详情', exact: true }).last().click()
    await page.getByRole('link', { name: '插件库', exact: true }).click()
    await page.getByRole('button', { name: '查看插件 plugin', exact: true }).click()
    await page.getByText('发布已暂停，选用兼容版本后恢复。', { exact: true }).waitFor()
    await page.getByRole('button', { name: '更换 npm 版本', exact: true }).click()
    await page.getByLabel('精确版本', { exact: true }).fill('2.0.0')
    await page.getByRole('button', { name: '开始预检', exact: true }).click()
    await page.getByRole('button', { name: '选用此版本', exact: true }).click()
    await page.getByRole('dialog', { name: '确认更换版本', exact: true }).getByRole('button', { name: '确认', exact: true }).click()
    await expect.poll(async () => (await (await page.request.get(origin + '/admin/api/plugins')).json())[0].published).toBe(true)
    await expect.poll(() => page.getByText('与当前版本不兼容', { exact: true }).count()).toBe(0)
  } finally { await browser.close(); await app.stop(); await rm(root, { recursive: true, force: true }) }
})
