// Validation: T1; real credentials: none; controlled browser/process fixtures. CI selects its explicit public-entry subset.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { spawnSync } from 'node:child_process'
import { expect, it, vi } from 'vitest'
import { createCommunityApplication } from '../src/composition/community-application.js'
import { legacySuiteCatalogFixture } from './fixtures/suite-catalog-server.js'
import { FileExecutionArtifacts } from '../src/adapters/execution-artifacts.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { gitFixture } from './fixtures/skills/git-repository.js'
import { validSkill } from './fixtures/skills/archive.js'
import type { SuiteCatalogEntry } from '../src/domain/suite-catalog.js'

it('installs a suite through the wizard with grants and publication, then uninstalls with impact review', async () => {
  const fixture = await gitFixture({ host: 'github.com', repository: 'dsh-phalanx-fixtures/skills.git' }), root = await mkdtemp(join(tmpdir(), 'suite-officecli-'))
  const skill = (name: string) => validSkill.replace('example-skill', name).replace('A useful skill', `${name} skill`)
  const commit = await fixture.commit({ 'skills/one/SKILL.md': skill('one'), 'skills/two/SKILL.md': skill('two') })
  const preparation = 'mkdir bin; printf "#!/bin/sh\\necho suite-cli\\n" > bin/suite-cli; chmod +x bin/suite-cli'
  const presets: readonly SuiteCatalogEntry[] = [{ category: 'suite', id: 'fixture-suite', version: '1',
    title: { en: 'Fixture suite', 'zh-CN': '夹具套件' }, description: { en: 'Two skills with a shared CLI', 'zh-CN': '两个技能与一个共用 CLI' },
    source: { en: 'fixture', 'zh-CN': '夹具' }, identity: { en: 'Runs in the member workspace without credentials.', 'zh-CN': '在成员工作区内运行，无需凭据。' }, dependencies: [],
    items: [
      { kind: 'runtime-dependency', name: 'suite-cli', prepareCommands: { amd64: preparation, arm64: preparation }, pathDirectories: ['bin'], checkCommand: 'suite-cli', commands: ['suite-cli'] },
      { kind: 'skill', source: { type: 'git', url: fixture.url, commit, path: 'skills' }, names: ['one', 'two'], runtimeDependency: 'suite-cli' },
      { kind: 'skill-pack', name: 'fixture-suite', description: 'Fixture suite pack', note: 'The platform provides suite-cli on PATH.', skills: ['one', 'two'] },
    ] }]
  vi.stubEnv('HTTPS_PROXY', fixture.proxy); vi.stubEnv('GIT_SSL_CAINFO', fixture.caFile)
  const catalogFixture = await legacySuiteCatalogFixture(presets)
  const app = createCommunityApplication({ downloadSources: catalogFixture.downloadSources, listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'suite-officecli-fixture-secret-32', runtime: { command: '/unavailable', args: [], dataRoot: root, defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'https://example.test' } } } }, { suiteCatalog: { address: catalogFixture.address, trustedKeys: catalogFixture.trustedKeys } })
  const browser = await chromium.launch({ headless: true })
  try {
    const origin = await app.start(), page = await browser.newPage({ locale: 'en', viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(30000)
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
    await page.goto(`${origin}/bootstrap#credential=${readBootstrapCredential(root)!.credential}`)
    await page.getByLabel('Username', { exact: true }).fill('admin'); await page.getByLabel('Password', { exact: true }).fill('password')
    await page.getByRole('button', { name: 'Create administrator' }).click(); await page.waitForURL(`${origin}/admin`)
    const groups = (await (await page.request.get(origin + '/admin/api/groups')).json()).filter((group: { kind: string }) => group.kind === 'ordinary')
    const group = groups[0] as { id: string, name: string } | undefined
    expect(group).toBeDefined()
    await page.getByRole('link', { name: 'Suite catalog', exact: true }).click()
    const card = page.locator('.plugin-library-card').filter({ hasText: 'Fixture suite' })
    await card.getByText('Not installed', { exact: true }).waitFor()
    await card.getByRole('button', { name: 'Install', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Fixture suite' })
    await dialog.getByText('This entry will install:', { exact: true }).waitFor()
    await dialog.getByText('Skill pack · fixture-suite · 2 skills').waitFor()
    await dialog.getByText(`Grant to ${group!.name}`, { exact: true }).click()
    await dialog.getByText('Publish to the platform app center', { exact: true }).click()
    await dialog.getByRole('button', { name: 'Install entry', exact: true }).click()
    await card.getByText('Installed', { exact: true }).first().waitFor({ timeout: 60000 })
    const installations = (await (await page.request.get(origin + '/admin/api/suites')).json()).installations
    expect(installations[0]).toMatchObject({ id: 'fixture-suite', status: 'installed', entries: [
      { kind: 'runtime-dependency', name: 'suite-cli' }, { kind: 'skill', name: 'one' }, { kind: 'skill', name: 'two' }, { kind: 'skill-pack', name: 'fixture-suite' }] })
    const skills = await (await page.request.get(origin + '/admin/api/skills')).json()
    expect(skills.find((row: { name: string }) => row.name === 'one')).toMatchObject({ suiteOrigin: 'suite:fixture-suite', runtimeDependencies: ['suite-cli'] })
    const packs = (await (await page.request.get(origin + '/admin/api/skill-packs')).json()).packs
    expect(packs.find((row: { name: string }) => row.name === 'fixture-suite')).toMatchObject({ published: true, suiteOrigin: 'suite:fixture-suite', skills: ['one', 'two'] })
    const dependency = await (await page.request.get(origin + '/admin/api/runtime-dependencies?name=suite-cli')).json()
    expect(dependency).toMatchObject({ source: 'suite-catalog', stage: 'ready', current: { commands: ['suite-cli'] } })
    await page.getByRole('link', { name: 'Skill library', exact: true }).click()
    await page.locator('.plugin-library-card').filter({ hasText: 'one' }).getByText('From suite fixture-suite', { exact: true }).waitFor()
    await page.getByRole('link', { name: 'Suite catalog', exact: true }).click()
    await card.getByRole('button', { name: 'Uninstall', exact: true }).click()
    const uninstall = page.getByRole('dialog', { name: 'Fixture suite' })
    await uninstall.getByText('This will remove:', { exact: true }).waitFor()
    await uninstall.getByText('Uninstall impact', { exact: true }).waitFor()
    await uninstall.getByText(new RegExp(`Granted to: .*${group!.name}`)).waitFor()
    await uninstall.getByText(/0 members selected this pack/).first().waitFor()
    expect((await page.request.post(origin + '/admin/api/skill-packs', { headers: { origin }, data: { action: 'save', pack: { name: 'fixture-suite', description: 'tampered', skills: [], instructions: '', published: true } } })).status()).toBeGreaterThanOrEqual(400)
    await uninstall.getByRole('button', { name: 'Confirm uninstall', exact: true }).click()
    await card.getByText('Not installed', { exact: true }).waitFor()
    await expect.poll(async () => (await (await page.request.get(origin + '/admin/api/suites')).json()).installations).toHaveLength(0)
    await expect.poll(async () => (await (await page.request.get(origin + '/admin/api/runtime-dependencies')).json())).toHaveLength(0)
    expect(errors).toEqual([])
  } finally {
    await browser.close(); await app.stop(); await catalogFixture.close(); vi.unstubAllEnvs()
    await new FileExecutionArtifacts(join(root, 'runtime-dependencies', '.trees')).collect([])
    spawnSync('chmod', ['-R', 'u+w', root])
    await rm(root, { recursive: true, force: true }); await fixture.close()
  }
})
