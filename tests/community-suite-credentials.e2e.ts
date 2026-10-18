// Validation: T1; real credentials: none; controlled browser/process fixtures. CI selects its explicit public-entry subset.
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Page } from 'playwright'
import { spawnSync } from 'node:child_process'
import { expect, it, vi } from 'vitest'
import { createCommunityApplication } from '../src/composition/community-application.js'
import { legacySuiteCatalogFixture } from './fixtures/suite-catalog-server.js'
import { FileExecutionArtifacts } from '../src/adapters/execution-artifacts.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { gitFixture } from './fixtures/skills/git-repository.js'
import { validSkill } from './fixtures/skills/archive.js'
import type { SuiteCatalogEntry } from '../src/domain/suite-catalog.js'

const secret = 'fixture-team-secret-value'

it('installs a delegated suite while skipping credentials, fills them in later, and installs again with credentials in the wizard', async () => {
  const fixture = await gitFixture(), root = await mkdtemp(join(tmpdir(), 'suite-credentials-'))
  const commit = await fixture.commit({ 'skill/SKILL.md': validSkill.replace('example-skill', 'team-cli').replace('A useful skill', 'Team CLI skill') })
  const preparation = 'mkdir bin; printf "#!/bin/sh\\necho team-cli\\n" > bin/team-cli; chmod +x bin/team-cli'
  const presets: readonly SuiteCatalogEntry[] = [{ category: 'suite', id: 'team-suite', version: '1',
    title: { en: 'Team suite', 'zh-CN': '团队套件' }, description: { en: 'Delegated CLI with a team key', 'zh-CN': '使用团队凭据的代执行 CLI' },
    source: { en: 'fixture', 'zh-CN': '夹具' }, identity: { en: 'Uses the team key through platform delegated execution.', 'zh-CN': '经平台代执行使用团队凭据。' }, dependencies: [],
    items: [
      { kind: 'runtime-dependency', name: 'team-tools', prepareCommands: { amd64: preparation, arm64: preparation }, pathDirectories: ['bin'], checkCommand: 'team-cli', commands: ['team-cli'] },
      { kind: 'skill', source: { type: 'git', url: fixture.url, commit, path: 'skill' }, names: ['team-cli'] },
      { kind: 'execution', skill: 'team-cli', runtimeDependency: 'team-tools', delegated: [{ command: 'team-cli', blocked: ['auth'] }], variables: [{ name: 'TEAM_KEY', purpose: { en: 'Team API key', 'zh-CN': '团队 API key' } }] },
      { kind: 'skill-pack', name: 'team-suite', description: 'Team suite pack', note: 'The platform provides team-cli and its credentials.', skills: ['team-cli'] },
    ] }]
  vi.stubEnv('HTTPS_PROXY', fixture.proxy); vi.stubEnv('GIT_SSL_CAINFO', fixture.caFile)
  const catalogFixture = await legacySuiteCatalogFixture(presets)
  const app = createCommunityApplication({ downloadSources: catalogFixture.downloadSources, listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'suite-credential-fixture-secret-32', runtime: { command: '/unavailable', args: [], dataRoot: root, defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'https://example.test' } } } }, { suiteCatalog: { address: catalogFixture.address, trustedKeys: catalogFixture.trustedKeys } })
  const browser = await chromium.launch({ headless: true })
  try {
    const origin = await app.start(), page = await browser.newPage({ locale: 'en', viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(30000)
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
    await page.goto(`${origin}/bootstrap#credential=${readBootstrapCredential(root)!.credential}`)
    await page.getByLabel('Username', { exact: true }).fill('admin'); await page.getByLabel('Password', { exact: true }).fill('password')
    await page.getByRole('button', { name: 'Create administrator' }).click(); await page.waitForURL(`${origin}/admin`)
    await page.getByRole('link', { name: 'Suite catalog', exact: true }).click()
    const card = page.locator('.plugin-library-card').filter({ hasText: 'Team suite' })
    const execution = async () => (await (await page.request.get(origin + '/admin/api/skills/execution?name=team-cli')).json()) as { enabled: boolean, suiteOrigin?: string, variables: { name: string, configured: boolean }[] }

    // Path one: skip the credential step, then fill it in from the suite details.
    await openWizard(page, card)
    const wizard = page.getByRole('dialog', { name: 'Team suite' })
    await wizard.getByText('Team credentials (optional)', { exact: true }).waitFor()
    await wizard.getByText('Uses the team key through platform delegated execution.', { exact: true }).waitFor()
    await wizard.getByText('Delegated execution · team-cli · TEAM_KEY').waitFor()
    await wizard.getByRole('button', { name: 'Install entry', exact: true }).click()
    await card.getByText('Missing credentials', { exact: true }).waitFor({ timeout: 60000 })
    expect(await execution()).toMatchObject({ enabled: false, suiteOrigin: 'suite:team-suite', variables: [{ name: 'TEAM_KEY', configured: false }] })
    expect((await page.request.post(origin + '/admin/api/skills/execution?name=team-cli', { headers: { origin }, data: { enabled: true, commands: [{ command: 'team-cli', blocked: [] }], variables: [{ name: 'TEAM_KEY', secret: true, value: 'x' }] } })).status()).toBe(403)
    await card.getByRole('button', { name: 'View suite entry Team suite', exact: true }).click()
    const details = page.getByRole('dialog', { name: 'Team suite' })
    await details.getByText('Delegated execution is off until these credentials are saved: TEAM_KEY').waitFor()
    await details.getByLabel('TEAM_KEY').fill(secret)
    await details.getByRole('button', { name: 'Save credentials', exact: true }).click()
    await details.getByText('Credentials are saved. Delegated execution is on.', { exact: true }).waitFor()
    expect(await execution()).toMatchObject({ enabled: true, variables: [{ name: 'TEAM_KEY', configured: true }] })
    await details.getByRole('button', { name: 'Close suite entry details', exact: true }).click()
    await card.getByText('Installed', { exact: true }).first().waitFor()
    const catalog = await (await page.request.get(origin + '/admin/api/suites')).text()
    expect(catalog).not.toContain(secret)
    expect(JSON.stringify(await execution())).not.toContain(secret)
    expect(await filesContaining(root, secret)).toEqual(['execution/configuration.json'])

    await uninstall(page, card)
    await expect.poll(async () => (await page.request.get(origin + '/admin/api/skills/execution?name=team-cli')).status()).toBe(404)

    // Path two: enter the credential in the wizard, so execution is enabled once the install completes.
    await openWizard(page, card)
    await wizard.getByLabel('TEAM_KEY').fill(secret)
    await wizard.getByRole('button', { name: 'Install entry', exact: true }).click()
    await card.getByText('Installed', { exact: true }).first().waitFor({ timeout: 60000 })
    expect(await execution()).toMatchObject({ enabled: true, variables: [{ name: 'TEAM_KEY', configured: true }] })
    expect(await filesContaining(root, secret)).toEqual(['execution/configuration.json'])
    await uninstall(page, card)
    expect(await filesContaining(root, secret)).toEqual([])
    await expect.poll(async () => (await (await page.request.get(origin + '/admin/api/runtime-dependencies')).json())).toHaveLength(0)

    // Chinese copy for the skip path: wizard step, missing-credential status and the details form.
    await page.context().addCookies([{ name: 'dsh-phalanx.lang', value: 'zh-CN', url: origin }])
    await page.reload()
    const zhCard = page.locator('.plugin-library-card').filter({ hasText: '团队套件' })
    await zhCard.getByText('未安装', { exact: true }).waitFor()
    await zhCard.getByRole('button', { name: '安装', exact: true }).click()
    const zhWizard = page.getByRole('dialog', { name: '团队套件' })
    await zhWizard.getByText('团队凭据（可选）', { exact: true }).waitFor()
    await zhWizard.getByText('可以跳过这一步。凭据全部保存之前，代执行保持关闭。', { exact: true }).waitFor()
    await zhWizard.getByText('代执行 · team-cli · TEAM_KEY').waitFor()
    await zhWizard.getByRole('button', { name: '安装条目', exact: true }).click()
    await zhCard.getByText('缺少凭据', { exact: true }).waitFor({ timeout: 60000 })
    await zhCard.getByRole('button', { name: '查看套件条目 团队套件', exact: true }).click()
    await page.getByRole('dialog', { name: '团队套件' }).getByText('保存以下凭据之前，代执行保持关闭：TEAM_KEY').waitFor()
    expect(errors).toEqual([])
  } finally {
    await browser.close(); await app.stop(); await catalogFixture.close(); vi.unstubAllEnvs()
    await new FileExecutionArtifacts(join(root, 'runtime-dependencies', '.trees')).collect([])
    spawnSync('chmod', ['-R', 'u+w', root])
    await rm(root, { recursive: true, force: true }); await fixture.close()
  }
})

async function openWizard(page: Page, card: ReturnType<Page['locator']>) {
  await card.getByText('Not installed', { exact: true }).waitFor()
  await card.getByRole('button', { name: 'Install', exact: true }).click()
  await page.getByRole('dialog', { name: 'Team suite' }).getByText('This entry will install:', { exact: true }).waitFor()
}
async function uninstall(page: Page, card: ReturnType<Page['locator']>) {
  await card.getByRole('button', { name: 'Uninstall', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Team suite' })
  await dialog.getByText('Delegated execution · team-cli').waitFor()
  await dialog.getByRole('button', { name: 'Confirm uninstall', exact: true }).click()
  await card.getByText('Not installed', { exact: true }).waitFor()
}
/** Only the protected execution configuration may hold the credential; member projections and records never do. */
async function filesContaining(root: string, value: string): Promise<readonly string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true })
  const files = entries.filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name))
  const matches = await Promise.all(files.map(async file => (await readFile(file)).includes(value) ? [file.slice(root.length + 1)] : []))
  return matches.flat().sort()
}
