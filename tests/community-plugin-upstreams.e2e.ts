import { mkdtemp, mkdir, rm, stat, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { createCommunityApplication } from '../src/composition/community-application.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { declaredRuntimeRevision } from '../src/adapters/runtime-revision.js'

it('configures write-only upstream credentials using HeroUI and retains Chinese and mobile layouts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-upstream-ui-'))
  const app = createCommunityApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'plugin-upstream-ui-fixture-secret-value', runtime: { command: '/unavailable', args: [], dataRoot: root, defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'https://example.test' } } } }, {
    pluginPreparer: { prepare: async input => ({ ...input, title: 'Shared plugin', description: '', artifact: 'artifacts/fixture', integrity: 'sha512-fixture', runtimeRevision: declaredRuntimeRevision(), bundlePatch: '[]', dependencies: {} }) },
  })
  const browser = await chromium.launch({ headless: true })
  try {
    const origin = await app.start(); const page = await browser.newPage({ locale: 'en' }); page.setDefaultTimeout(15000)
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
    await page.goto(`${origin}/bootstrap#credential=${readBootstrapCredential(root)!.credential}`)
    await page.getByLabel('Username', { exact: true }).fill('admin'); await page.getByLabel('Password', { exact: true }).fill('password')
    await page.getByRole('button', { name: 'Create administrator' }).click(); await page.waitForURL(origin + '/admin')
    await page.request.post(origin + '/admin/api/plugins', { headers: { origin }, data: { action: 'add', packageName: 'plugin', version: '1.0.0' } })
    await page.getByRole('link', { name: 'Plugin library', exact: true }).click()
    await page.getByRole('button', { name: 'View plugin plugin', exact: true }).click()
    await page.getByRole('button', { name: 'Add upstream', exact: true }).click()
    await page.getByLabel('Upstream name', { exact: true }).fill('search')
    await page.getByLabel('Upstream address', { exact: true }).fill('http://127.0.0.1:9999/api')
    await page.getByLabel('Platform credential', { exact: true }).fill('fictional-write-only-key')
    await page.getByRole('button', { name: 'Save changes', exact: true }).click()
    await page.getByText('Credential configured', { exact: true }).waitFor()
    const api = origin + '/admin/api/plugins/upstreams?packageName=plugin'
    const saved = await (await page.request.get(api)).text()
    expect(saved).not.toContain('fictional-write-only-key'); expect(JSON.parse(saved)[0].hasCredential).toBe(true)
    expect((await stat(join(root, 'plugin-upstreams.json'))).mode & 0o777).toBe(0o600)
    await page.getByRole('button', { name: 'Edit upstream', exact: true }).click()
    expect(await page.getByLabel('Platform credential', { exact: true }).inputValue()).toBe('')
    await page.getByLabel('Upstream address', { exact: true }).fill('https://service.example.test/v2')
    await page.getByRole('button', { name: 'Save changes', exact: true }).click()
    expect(await readFile(join(root, 'plugin-upstreams.json'), 'utf8')).toContain('fictional-write-only-key')
    await page.getByRole('button', { name: 'Edit upstream', exact: true }).click()
    await page.getByRole('button', { name: 'Clear saved credential', exact: true }).click()
    await page.getByRole('button', { name: 'Save changes', exact: true }).click()
    await page.getByText('Credential not configured', { exact: true }).waitFor()
    expect(await readFile(join(root, 'plugin-upstreams.json'), 'utf8')).not.toContain('fictional-write-only-key')
    await page.getByRole('button', { name: 'Close plugin details', exact: true }).click()
    await page.getByRole('button', { name: /Platform language/ }).click(); await page.getByRole('option', { name: '简体中文', exact: true }).click()
    await page.getByRole('option', { name: '简体中文', exact: true }).waitFor({ state: 'detached' })
    await page.getByRole('button', { name: '查看插件 plugin', exact: true }).click()
    await page.getByRole('button', { name: '编辑上游', exact: true }).click()
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByLabel('平台凭据', { exact: true }).waitFor()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    const evidence = process.env.DSH_PHALANX_E2E_EVIDENCE_DIR
    if (evidence) { await mkdir(evidence, { recursive: true }); await page.screenshot({ path: join(evidence, 'upstream-editor-zh.png'), fullPage: true, animations: 'disabled' }) }
    await page.getByRole('button', { name: '删除上游', exact: true }).click()
    await page.getByRole('button', { name: '确认', exact: true }).click()
    expect(await (await page.request.get(api)).json()).toEqual([])
    expect(errors).toEqual([])
  } finally { await browser.close(); await app.stop(); await rm(root, { recursive: true, force: true }) }
})
