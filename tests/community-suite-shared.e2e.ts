// Validation: T1; real credentials: none; controlled browser/process fixtures. CI selects its explicit public-entry subset.
import { spawnSync } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it, vi } from 'vitest'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { FileExecutionArtifacts } from '../src/adapters/execution-artifacts.js'
import type { SuiteCatalogEntry } from '../src/domain/suite-catalog.js'
import { removeCommunityFixture } from './fixtures/owned-cleanup.js'
import { validSkill } from './fixtures/skills/archive.js'
import { gitFixture } from './fixtures/skills/git-repository.js'
import { legacySuiteCatalogFixture } from './fixtures/suite-catalog-server.js'
import { createCommunityApplication } from './support/community-application.js'
import { selectBuiltinDatabase } from './support/community-bootstrap-browser.js'

it('installs a shared dependency with the first suite, keeps it for the second and offers its removal last', async () => {
  const fixture = await gitFixture({ host: 'github.com', repository: 'dsh-phalanx-fixtures/skills.git' }),
    root = await mkdtemp(join(tmpdir(), 'suite-shared-'))
  const skill = (name: string) => validSkill.replace('example-skill', name).replace('A useful skill', `${name} skill`)
  const commit = await fixture.commit({ 'alpha/SKILL.md': skill('alpha-render'), 'beta/SKILL.md': skill('beta-render') })
  const tool = (name: string) => `mkdir bin; printf "#!/bin/sh\\necho ${name}\\n" > bin/${name}; chmod +x bin/${name}`
  const text = (en: string) => ({ en, 'zh-CN': en })
  const suite = (id: string): SuiteCatalogEntry => ({
    category: 'suite',
    id,
    version: '1',
    title: text(`Suite ${id}`),
    description: text('Video suite'),
    source: text('fixture'),
    identity: text('No credentials.'),
    dependencies: ['shared-tool'],
    items: [
      {
        kind: 'runtime-dependency',
        name: `${id}-cli`,
        prepareCommands: { amd64: tool(`${id}-cli`), arm64: tool(`${id}-cli`) },
        pathDirectories: ['bin'],
        checkCommand: `${id}-cli`,
        commands: [`${id}-cli`],
      },
      {
        kind: 'skill',
        source: { type: 'git', url: fixture.url, commit, path: id },
        names: [`${id}-render`],
        runtimeDependency: `${id}-cli`,
        catalogDependencies: ['shared-tool'],
      },
      { kind: 'skill-pack', name: `${id}-suite`, description: `${id} pack`, note: 'The platform provides the tools.', skills: [`${id}-render`] },
    ],
  })
  const presets: readonly SuiteCatalogEntry[] = [
    {
      category: 'dependency',
      id: 'shared-tool',
      version: '1',
      title: text('Shared tool'),
      description: text('Shared'),
      source: text('fixture'),
      items: [
        {
          kind: 'runtime-dependency',
          name: 'shared-tool',
          prepareCommands: { amd64: tool('shared-tool'), arm64: tool('shared-tool') },
          pathDirectories: ['bin'],
          checkCommand: 'shared-tool',
          commands: ['shared-tool'],
        },
      ],
    },
    suite('alpha'),
    suite('beta'),
  ]
  vi.stubEnv('HTTPS_PROXY', fixture.proxy)
  vi.stubEnv('GIT_SSL_CAINFO', fixture.caFile)
  const catalogFixture = await legacySuiteCatalogFixture(presets)
  const app = createCommunityApplication(
    {
      downloadSources: catalogFixture.downloadSources,
      listen: { host: '127.0.0.1', port: 0 },
      sessionSecret: 'suite-shared-fixture-secret-000032',
      runtime: {
        command: '/unavailable',
        args: [],
        dataRoot: root,
        defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'https://example.test' } },
      },
    },
    { suiteCatalog: { address: catalogFixture.address, trustedKeys: catalogFixture.trustedKeys } },
  )
  const browser = await chromium.launch({ headless: true })
  try {
    const origin = await app.start(),
      page = await browser.newPage({ locale: 'en', viewport: { width: 1440, height: 1000 } })
    page.setDefaultTimeout(30000)
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`${origin}/bootstrap#credential=${readBootstrapCredential(root)!.credential}`)
    await selectBuiltinDatabase(page)
    await page.getByLabel('Username', { exact: true }).fill('admin')
    await page.getByLabel('Password', { exact: true }).fill('password')
    await page.getByRole('button', { name: 'Create administrator' }).click()
    await page.waitForURL(`${origin}/admin`)
    await page.locator('nav.nav-list').getByRole('link', { name: 'Skill library', exact: true }).click()
    await page.getByRole('tab', { name: 'Skill catalog', exact: true }).click()
    const card = (name: string) => page.locator('.plugin-library-card').filter({ hasText: name })
    const dependencies = async () =>
      ((await (await page.request.get(origin + '/admin/api/runtime-dependencies')).json()) as { name: string }[]).map(row => row.name).sort()
    const install = async (name: string, action: string) => {
      await card(name).getByRole('button', { name: 'Install', exact: true }).click()
      const dialog = page.getByRole('dialog', { name })
      await dialog.getByText(`Shared tool · ${action}`, { exact: true }).waitFor()
      await dialog.getByRole('button', { name: 'Install entry', exact: true }).click()
      await card(name).getByText('Installed', { exact: true }).first().waitFor({ timeout: 60000 })
    }
    await card('Suite alpha').getByText('Shared tool', { exact: true }).waitFor()
    await install('Suite alpha', 'Installed together with this tool')
    expect(await page.getByRole('button', { name: 'View catalog entry Shared tool', exact: true }).count()).toBe(0)
    await install('Suite beta', 'Already in the library; reused without preparing again')
    expect(await dependencies()).toEqual(['alpha-cli', 'beta-cli', 'shared-tool'])

    await card('Suite alpha').getByRole('button', { name: 'Uninstall', exact: true }).click()
    const first = page.getByRole('dialog', { name: 'Suite alpha' })
    await first
      .getByText('Shared tool stays installed because it is still used by: Skills · beta-render, Catalog entry · Suite beta', { exact: true })
      .waitFor()
    await first.getByRole('button', { name: 'Confirm uninstall', exact: true }).click()
    await card('Suite alpha').getByText('Not installed', { exact: true }).waitFor()
    await expect.poll(dependencies).toEqual(['beta-cli', 'shared-tool'])

    await card('Suite beta').getByRole('button', { name: 'Uninstall', exact: true }).click()
    const last = page.getByRole('dialog', { name: 'Suite beta' })
    await expect.poll(() => last.getByRole('checkbox', { name: 'Also remove Shared tool; nothing else uses it' }).isChecked()).toBe(true)
    await last.getByRole('button', { name: 'Confirm uninstall', exact: true }).click()
    expect(await page.getByRole('button', { name: 'View catalog entry Shared tool', exact: true }).count()).toBe(0)
    await expect.poll(dependencies).toEqual([])
    expect(errors).toEqual([])
  } finally {
    await browser.close()
    await app.stop()
    await catalogFixture.close()
    vi.unstubAllEnvs()
    await new FileExecutionArtifacts(join(root, 'runtime-dependencies', '.trees')).collect([])
    spawnSync('chmod', ['-R', 'u+w', root])
    await removeCommunityFixture(root)
    await fixture.close()
  }
})
