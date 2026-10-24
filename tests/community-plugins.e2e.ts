// Validation: T1; real credentials: none; controlled browser/process fixtures. CI selects its explicit public-entry subset.
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser } from 'playwright'
import { afterEach, expect, it, vi } from 'vitest'
import { PlatformProcessHost } from '../src/adapters/platform-process-host.js'
import { createCommunityApplication } from '../src/composition/community-application.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import type { CommunityApplication } from '../src/ports/community-application.js'
import { FileExecutionArtifacts } from '../src/adapters/execution-artifacts.js'
import { PluginPreparationError } from '../src/domain/plugin-library.js'
let app: CommunityApplication | undefined
let browser: Browser | undefined
let root: string | undefined
afterEach(async () => {
  try { await browser?.close(); await app?.stop(); if (root) { await new FileExecutionArtifacts(join(root, 'runtime-dependencies/.trees')).collect([]); await rm(root, { recursive: true, force: true }) } }
  finally { vi.restoreAllMocks() }
})
it('shows library empty, preparing, failed and available states with retry, details and Chinese copy', async () => {
  // This controlled UI case prepares its resource on the host, independent of installed Podman images.
  vi.spyOn(PlatformProcessHost.prototype, 'detect').mockResolvedValue()
  root = await mkdtemp(join(tmpdir(), 'community-plugins-'))
  let release!: () => void
  const prepared = new Promise<void>(resolve => { release = resolve })
  let calls = 0
  app = createCommunityApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'plugins-fixture-session-secret-32-bytes', runtime: { command: '/unavailable-dsh', args: [], dataRoot: root, defaultModel: { provider: 'deepseek-official', model: 'deepseek-chat', upstream: { baseUrl: 'https://api.deepseek.com' } } } }, {
    pluginArchiveInspector: { inspect: async archive => { expect((await readFile(archive)).toString()).toMatch(/^private-fixture/); return { packageName: '@example/private', version: '1.0.0' } } },
    pluginPreparer: { prepare: async (input, progress, signal) => {
      calls++; progress('installing')
      if (calls === 1) {
        await Promise.race([prepared, new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))])
        throw new PluginPreparationError('plugin-dependency-invalid')
      }
      return { ...input, integrity: input.upload?.integrity ?? `sha512-${'A'.repeat(86)}==`, runtimeRevision: 'fixture', artifact: 'private/artifact', title: input.upload ? 'Private plugin' : 'Useful sidebar', description: 'Read files in a sidebar.', bundlePatch: '[{"insert":[{"id":"sidebar","name":"example-sidebar"}]}]', dependencies: {} }
    } },
  })
  const origin = await app.start(); browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ locale: 'en' }); page.setDefaultTimeout(15_000)
  const cdp = await page.context().newCDPSession(page)
  if (process.env.DSH_PHALANX_E2E_CPU_THROTTLE) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
  expect((await page.request.get(`${origin}/admin/api/plugins`)).status()).toBe(401)
  await page.goto(`${origin}/bootstrap#credential=${readBootstrapCredential(root)!.credential}`)
  await page.getByLabel('Username', { exact: true }).fill('admin'); await page.getByLabel('Password', { exact: true }).fill('password')
  await page.getByRole('button', { name: 'Create administrator' }).click(); await page.waitForURL(`${origin}/admin`)
  await page.getByRole('link', { name: 'Plugin library', exact: true }).click()
  await page.getByText('No plugins yet', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Add npm plugin', exact: true }).click()
  await page.getByLabel('npm package name', { exact: true }).fill('example-sidebar')
  await page.getByLabel('Exact version', { exact: true }).fill('latest')
  await page.getByRole('button', { name: 'Start precheck', exact: true }).click()
  await page.getByRole('alert').getByText('Provide an npm package name and an exact version.').waitFor()
  await page.getByLabel('Exact version', { exact: true }).fill('1.0.0')
  await page.getByRole('button', { name: 'Start precheck', exact: true }).click()
  await page.getByRole('status').getByText('Installing dependencies', { exact: true }).waitFor()
  release()
  await page.getByRole('status').getByText('Precheck failed', { exact: true }).waitFor()
  await page.setViewportSize({ width: 320, height: 844 })
  const detailsLabel = (await page.getByText('Plugin details', { exact: true }).boundingBox())!
  const retryButton = (await page.getByRole('button', { name: 'Retry precheck', exact: true }).boundingBox())!
  expect(detailsLabel.y + detailsLabel.height <= retryButton.y || detailsLabel.x + detailsLabel.width <= retryButton.x).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.getByRole('button', { name: 'Retry precheck', exact: true }).click()
  await page.getByRole('status').getByText('Available', { exact: true }).waitFor()
  expect(calls).toBe(2)
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.getByText('Read files in a sidebar.', { exact: true }).waitFor()
  const resource = await page.request.post(origin + '/admin/api/runtime-dependencies', { headers: { origin }, data: { action: 'create', input: { name: '文档.sdk-v1', type: 'resource', prepareCommand: 'printf sdk > "$RD_OUT/sdk.txt"', pathDirectories: [] } } })
  expect(resource.status(), await resource.text()).toBe(202)
  await expect.poll(async () => (await (await page.request.get(origin + '/admin/api/runtime-dependencies?name=' + encodeURIComponent('文档.sdk-v1'))).json()).stage, { timeout: 30000 }).toBe('ready')
  // The card-wide details target must include its title, while retry stays independently clickable.
  const titleBox = (await page.getByRole('heading', { name: 'Useful sidebar', exact: true }).boundingBox())!
  await page.mouse.click(titleBox.x + titleBox.width / 2, titleBox.y + titleBox.height / 2)
  await page.getByRole('dialog', { name: 'Useful sidebar', exact: true }).waitFor()
  await page.getByRole('tab', { name: 'Runtime dependencies', exact: true }).click()
  await page.getByText('文档.sdk-v1', { exact: true }).click()
  expect(await page.getByRole('checkbox', { name: '文档.sdk-v1', exact: true }).isChecked()).toBe(true)
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await page.getByText('Runtime dependency references saved.', { exact: true }).waitFor()
  expect((await (await page.request.get(origin + '/admin/api/plugins')).json())[0].runtimeDependencies).toEqual(['文档.sdk-v1'])
  await page.getByRole('tab', { name: 'Access settings', exact: true }).click()
  const accessResponse = await page.request.get(origin + '/admin/api/plugins/access?packageName=example-sidebar')
  expect(accessResponse.status(), await accessResponse.text()).toBe(200)
  await page.getByRole('button', { name: 'Add variable', exact: true }).click()
  await page.getByLabel('Environment name', { exact: true }).fill('OFFICE_SDK_ROOT')
  await page.getByLabel('Environment value', { exact: true }).fill('{dependency:undeclared}')
  await page.getByRole('button', { name: 'Save access settings', exact: true }).click()
  await page.getByRole('alert').waitFor()
  expect((await (await page.request.get(origin + '/admin/api/plugins/access?packageName=example-sidebar')).json()).environment).toEqual([])
  await page.getByLabel('Environment value', { exact: true }).fill('{dependency:文档.sdk-v1}/sdk.txt')
  await page.getByRole('button', { name: 'Save access settings', exact: true }).click()
  await page.getByText('Access saved. Affected members must restart their instances.', { exact: true }).waitFor()
  await page.getByRole('tab', { name: 'Basic settings', exact: true }).click()
  await page.getByText('Integrity (sha512)', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Close plugin details', exact: true }).click()
  const evidence = process.env.DSH_PHALANX_E2E_EVIDENCE_DIR
  if (evidence) { await mkdir(evidence, { recursive: true }); await page.screenshot({ path: join(evidence, 'plugins-desktop.png'), fullPage: true }) }
  const result = await (await page.request.get(`${origin}/admin/api/plugins`)).json()
  expect(result[0]).toMatchObject({ currentVersion: '1.0.0', published: false })
  expect(JSON.stringify(result)).not.toContain('private/artifact')
  const rejected = await page.request.post(`${origin}/admin/api/plugins`, { data: { action: 'add', packageName: 'example-sidebar', version: '1.0.0', published: true } })
  expect(rejected.status()).toBe(400); expect(await rejected.json()).toMatchObject({ code: 'plugin-action-invalid' })
  const csrf = await page.request.post(`${origin}/admin/api/plugins`, { headers: { origin: 'https://other.example.test' }, data: { action: 'retry', packageName: 'example-sidebar', version: '1.0.0' } })
  expect(csrf.status()).toBe(403)
  const upload = async (contents: string) => {
    await page.getByRole('button', { name: 'Upload plugin archive', exact: true }).click()
    await page.getByLabel('Plugin archive (.tgz)', { exact: true }).setInputFiles({ name: 'private.tgz', mimeType: 'application/gzip', buffer: Buffer.from(contents) })
    await page.getByRole('button', { name: 'Upload and precheck', exact: true }).click()
  }
  await upload('private-fixture')
  await page.getByRole('button', { name: 'View plugin @example/private', exact: true }).waitFor()
  await page.getByText('Uploaded archive', { exact: true }).waitFor()
  await upload('private-fixture')
  await page.getByRole('dialog', { name: 'Upload plugin archive', exact: true }).waitFor({ state: 'detached' })
  expect(calls).toBe(3)
  await upload('private-fixture-changed')
  await page.getByRole('alert').getByText('This package version already has different or unverified content.', { exact: true }).waitFor()
  await page.getByLabel('Plugin archive (.tgz)', { exact: true }).setInputFiles([])
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect((await (await page.request.get(`${origin}/admin/api/plugins`)).json()).length).toBe(2)
  await page.getByRole('button', { name: /Platform language/ }).click(); await page.getByRole('menuitemradio', { name: '简体中文', exact: true }).click()
  await page.getByRole('heading', { name: '插件库', exact: true }).waitFor()
  await page.getByRole('menuitemradio', { name: '简体中文', exact: true }).waitFor({ state: 'detached' })
  await page.getByRole('button', { name: /按发布状态筛选/ }).click()
  await page.getByRole('option', { name: '已上线平台应用中心', exact: true }).click()
  await page.getByText('没有符合筛选条件的插件。', { exact: true }).waitFor()
  await page.getByRole('button', { name: /按发布状态筛选/ }).click()
  await page.getByRole('option', { name: '未发布', exact: true }).click()
  await page.getByRole('option', { name: '未发布', exact: true }).waitFor({ state: 'detached' })
  expect(await page.getByRole('button', { name: /^查看插件 / }).count()).toBe(2)
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  if (evidence) await page.screenshot({ path: join(evidence, 'plugins-mobile.png'), fullPage: true })
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
  expect(errors).toEqual([])
})
