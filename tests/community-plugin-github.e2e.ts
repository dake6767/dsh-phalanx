// Validation: T1; real credentials: none; controlled browser with a fake GitHub proxy and the host-local packer.
import { createServer } from 'node:http'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { declaredRuntimeRevision } from '../src/adapters/runtime-revision.js'
import { execFileText } from '../src/adapters/runtime-command.js'
import { cleanupOwned, removeCommunityFixture } from './fixtures/owned-cleanup.js'
import { createCommunityApplication } from './support/community-application.js'
import { selectBuiltinDatabase } from './support/community-bootstrap-browser.js'
import { fakeGithub, hostPluginSourcePacker } from './support/plugin-github.js'

/** Reads a packed archive's real identity; the update precheck packs a new version into the upload store. */
const packedIdentity = async (archive: string): Promise<{ packageName: string; version: string }> => {
  const manifest = JSON.parse(await execFileText('tar', ['-xzOf', archive, 'package/package.json'], { timeout: 30_000 })) as {
    name: string
    version: string
  }
  return { packageName: manifest.name, version: manifest.version }
}

it('adds a GitHub plugin with its real package name, pinned commit and source, then updates it to a new commit in English and Chinese', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-github-ui-'))
  const commit = 'dcd348e0bec148af45bc0b1a8f33ef82c44aeeef'
  const next = 'b4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3'
  const repositoryFiles = (version: string) => ({
    'package.json': JSON.stringify({
      name: '@fixture/liang-skin',
      version,
      main: './src/index.js',
      exports: { '.': './src/index.js', './client': './lib/client.js' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }),
    'src/index.js': 'export {}',
    'lib/client.js': 'export {}',
    'cordis.patch.yml': '[]',
  })
  const github = fakeGithub()
  github.setRepository('kingOfSoySauce/dsh-liang-skin', { commit, files: repositoryFiles('0.1.15-settings.4') })
  const proxy = createServer(async (request, response) => {
    if (!(await github.handle(request, response))) {
      response.writeHead(404)
      response.end()
    }
  })
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))
  const address = proxy.address()
  if (!address || typeof address === 'string') throw Error('Missing proxy fixture address')
  const app = createCommunityApplication(
    {
      listen: { host: '127.0.0.1', port: 0 },
      sessionSecret: 'plugin-github-ui-fixture-secret-value',
      downloadSources: {
        preset: 'official',
        overrides: { githubApi: `http://127.0.0.1:${address.port}/gh-api/`, githubAssets: `http://127.0.0.1:${address.port}/gh-assets/` },
      },
      runtime: {
        command: '/unavailable',
        args: [],
        dataRoot: root,
        defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'https://example.test' } },
      },
    },
    {
      pluginArchiveInspector: {
        inspect: async archive =>
          archive.includes('/incoming/') ? await packedIdentity(archive) : { packageName: '@fixture/liang-skin', version: '0.1.15-settings.4' },
      },
      pluginSourcePacker: hostPluginSourcePacker,
      pluginPreparer: {
        prepare: async input => ({
          packageName: input.packageName,
          version: input.version,
          title: 'Liang skin',
          description: 'Adaptive reasoning slider skin.',
          artifact: 'artifacts/fixture',
          integrity: input.upload!.integrity,
          runtimeRevision: declaredRuntimeRevision(),
          bundlePatch: '[]',
          dependencies: {},
        }),
      },
    },
  )
  const origin = await app.start()
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({ locale: 'en' })
    page.setDefaultTimeout(15_000)
    await page.goto(`${origin}/bootstrap#credential=${readBootstrapCredential(root)!.credential}`)
    await selectBuiltinDatabase(page)
    await page.getByLabel('Username', { exact: true }).fill('admin')
    await page.getByLabel('Password', { exact: true }).fill('password')
    await page.getByRole('button', { name: 'Create administrator' }).click()
    await page.waitForURL(`${origin}/admin`)
    await page.getByRole('link', { name: 'Plugin library', exact: true }).click()
    await page.getByRole('button', { name: 'Add plugin', exact: true }).click()
    const adding = page.getByRole('dialog', { name: 'Add plugin', exact: true })
    await adding.getByText('Use pkg, pkg@1.2.3, pkg@latest, @scope/pkg, github:owner/repo or a GitHub repository URL.', { exact: true }).waitFor()
    await adding.getByLabel('Plugin identifier', { exact: true }).fill('https://github.com/kingOfSoySauce/dsh-liang-skin/tree/main')
    await adding.getByRole('button', { name: 'Start precheck', exact: true }).click()
    await adding
      .getByRole('alert')
      .getByText(/^Branches, tags and commits cannot be chosen\./u)
      .waitFor()
    await adding.getByLabel('Plugin identifier', { exact: true }).fill('https://github.com/kingOfSoySauce/dsh-liang-skin')
    await adding.getByRole('button', { name: 'Start precheck', exact: true }).click()
    await adding.getByRole('status').getByText('Precheck passed', { exact: true }).waitFor()
    await adding.getByText('Resolved to 0.1.15-settings.4 (dcd348e)', { exact: true }).waitFor()
    await adding.getByText('Package name: @fixture/liang-skin', { exact: true }).waitFor()
    await adding.getByText('Source: GitHub kingOfSoySauce/dsh-liang-skin', { exact: true }).waitFor()
    await adding.getByText(`Pinned commit: ${commit}`, { exact: true }).waitFor()
    const evidence = process.env.DSH_PHALANX_E2E_EVIDENCE_DIR
    if (evidence) {
      await mkdir(evidence, { recursive: true })
      await page.screenshot({ path: join(evidence, 'plugin-github-precheck.png'), fullPage: true, animations: 'disabled' })
    }
    await adding.getByRole('button', { name: 'Confirm and add', exact: true }).click()
    await adding.waitFor({ state: 'detached' })
    await page.getByText('0.1.15-settings.4 (dcd348e)', { exact: true }).waitFor()
    await page.getByText('GitHub kingOfSoySauce/dsh-liang-skin', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'View plugin @fixture/liang-skin', exact: true }).click()
    await page.getByRole('tab', { name: 'Basic settings', exact: true }).click()
    await page.getByText('Updates come from the GitHub repository recorded when it was added.', { exact: true }).waitFor()
    expect(await page.getByRole('button', { name: 'Upload replacement', exact: true }).count()).toBe(0)
    await page.getByRole('button', { name: 'Check for updates', exact: true }).click()
    await page.getByText('dcd348e is the latest commit', { exact: true }).waitFor()
    // A new commit on the default branch prompts even before anyone packs it; the update keeps the GitHub source.
    github.setRepository('kingOfSoySauce/dsh-liang-skin', { commit: next, files: repositoryFiles('0.1.16-settings.1') })
    await page.getByRole('button', { name: 'Check for updates', exact: true }).click()
    await page.getByText('New commit b4b5c6d available', { exact: true }).waitFor()
    if (evidence) await page.screenshot({ path: join(evidence, 'plugin-github-update.png'), fullPage: true, animations: 'disabled' })
    await page.getByRole('button', { name: 'Precheck update', exact: true }).click()
    await page.getByRole('button', { name: 'Select this version', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Select this version', exact: true }).click()
    const confirmation = page.getByRole('dialog', { name: 'Confirm version change', exact: true })
    await confirmation.getByText('0.1.15-settings.4 → 0.1.16-settings.1', { exact: true }).waitFor()
    await confirmation.getByRole('button', { name: 'Confirm', exact: true }).click()
    await page.getByText('0.1.16-settings.1 (b4b5c6d)', { exact: true }).first().waitFor()
    if (evidence) await page.screenshot({ path: join(evidence, 'plugin-github-detail.png'), fullPage: true, animations: 'disabled' })
    await page.getByRole('button', { name: 'Check for updates', exact: true }).click()
    await page.getByText('b4b5c6d is the latest commit', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Close plugin details', exact: true }).last().click()
    await page.getByRole('button', { name: /Platform language/ }).click()
    await page.getByRole('menuitemradio', { name: '简体中文', exact: true }).click()
    await page.getByRole('menuitemradio', { name: '简体中文', exact: true }).waitFor({ state: 'detached' })
    await page.getByRole('button', { name: '添加插件', exact: true }).click()
    const zh = page.getByRole('dialog', { name: '添加插件', exact: true })
    await zh.getByLabel('插件标识', { exact: true }).fill('github:kingOfSoySauce/dsh-liang-skin')
    await zh.getByRole('button', { name: '开始预检', exact: true }).click()
    await zh.getByRole('status').getByText('预检失败', { exact: true }).waitFor()
    await zh.getByText('插件库中已存在此包。', { exact: true }).waitFor()
    await zh.getByText(`固定提交: ${next}`, { exact: true }).waitFor()
    await zh.getByRole('button', { name: '取消', exact: true }).click()
    await page.getByRole('button', { name: '查看插件 @fixture/liang-skin', exact: true }).click()
    await page.getByRole('tab', { name: '基础设置', exact: true }).click()
    await page.getByText('更新沿用添加时记录的 GitHub 仓库。', { exact: true }).waitFor()
    await page.getByRole('button', { name: '检查更新', exact: true }).click()
    await page.getByText('b4b5c6d 已是最新提交', { exact: true }).waitFor()
  } finally {
    await cleanupOwned(
      () => browser.close(),
      () => app.stop(),
      () => new Promise<void>((resolve, reject) => proxy.close(error => (error ? reject(error) : resolve()))),
      () => removeCommunityFixture(root),
    )
  }
})
