// Validation: T1; real credentials: none; controlled browser/process fixtures. CI selects its explicit public-entry subset.
import { spawnSync } from 'node:child_process'
import { mkdtemp, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Page } from 'playwright'
import { expect, it, vi } from 'vitest'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { FileExecutionArtifacts } from '../src/adapters/execution-artifacts.js'
import type { SuiteCatalogDocumentEntry } from '../src/domain/suite-catalog-document.js'
import type { SuiteCatalogEntry } from '../src/domain/suite-catalog.js'
import { removeCommunityFixture } from './fixtures/owned-cleanup.js'
import { validSkill } from './fixtures/skills/archive.js'
import { gitFixture } from './fixtures/skills/git-repository.js'
import { legacySuiteCatalogFixture } from './fixtures/suite-catalog-server.js'
import { createCommunityApplication } from './support/community-application.js'
import { selectBuiltinDatabase } from './support/community-bootstrap-browser.js'

const secret = 'fixture-team-secret-value'

it('installs a delegated suite while skipping credentials, fills them in later, and installs again with credentials in the wizard', async () => {
  const fixture = await gitFixture({ host: 'github.com', repository: 'dsh-phalanx-fixtures/skills.git' }),
    root = await mkdtemp(join(tmpdir(), 'suite-credentials-'))
  const commit = await fixture.commit({ 'skill/SKILL.md': validSkill.replace('example-skill', 'team-cli').replace('A useful skill', 'Team CLI skill') })
  const preparation = 'mkdir bin; printf "#!/bin/sh\\necho team-cli\\n" > bin/team-cli; chmod +x bin/team-cli'
  const presets: readonly SuiteCatalogEntry[] = [
    {
      category: 'suite',
      id: 'team-suite',
      version: '1',
      title: { en: 'Team suite', 'zh-CN': '团队套件' },
      description: { en: 'Delegated CLI with a team key', 'zh-CN': '使用团队凭据的代执行 CLI' },
      source: { en: 'fixture', 'zh-CN': '夹具' },
      identity: { en: 'Uses the team key through platform delegated execution.', 'zh-CN': '经平台代执行使用团队凭据。' },
      dependencies: [],
      items: [
        {
          kind: 'runtime-dependency',
          name: 'team-tools',
          prepareCommands: { amd64: preparation, arm64: preparation },
          pathDirectories: ['bin'],
          checkCommand: 'team-cli',
          commands: ['team-cli'],
        },
        { kind: 'skill', source: { type: 'git', url: fixture.url, commit, path: 'skill' }, names: ['team-cli'] },
        {
          kind: 'execution',
          skill: 'team-cli',
          runtimeDependency: 'team-tools',
          delegated: [{ command: 'team-cli', blocked: ['auth'] }],
          variables: [{ name: 'TEAM_KEY', purpose: { en: 'Team API key', 'zh-CN': '团队 API key' } }],
        },
        {
          kind: 'skill-pack',
          name: 'team-suite',
          description: 'Team suite pack',
          note: 'The platform provides team-cli and its credentials.',
          skills: ['team-cli'],
        },
      ],
    },
  ]
  vi.stubEnv('HTTPS_PROXY', fixture.proxy)
  vi.stubEnv('GIT_SSL_CAINFO', fixture.caFile)
  const catalogFixture = await legacySuiteCatalogFixture(presets)
  const app = createCommunityApplication(
    {
      downloadSources: catalogFixture.downloadSources,
      listen: { host: '127.0.0.1', port: 0 },
      sessionSecret: 'suite-credential-fixture-secret-32',
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
    await page.getByRole('button', { name: /^(Skip for now and finish installation|暂时跳过，完成安装)$/u }).click()
    await page.waitForURL(`${origin}/admin`)
    await page.locator('nav.nav-list').getByRole('link', { name: 'Skill library', exact: true }).click()
    await page.getByRole('tab', { name: 'Skill catalog', exact: true }).click()
    const card = page.locator('.plugin-library-card').filter({ hasText: 'Team suite' })
    const execution = async () =>
      (await (await page.request.get(origin + '/admin/api/skills/execution?name=team-cli')).json()) as {
        enabled: boolean
        commands: { command: string; blockedOptions?: string[]; shortOptionsWithValue?: string[] }[]
        suiteOrigin?: string
        variables: { name: string; configured: boolean }[]
      }

    // Path one: skip the credential step, then fill it in from the suite details.
    await openWizard(page, card)
    const wizard = page.getByRole('dialog', { name: 'Team suite' })
    await wizard.getByText('Team credentials (optional)', { exact: true }).waitFor()
    await wizard.getByText('Uses the team key through platform delegated execution.', { exact: true }).waitFor()
    await wizard.getByText('Delegated execution · team-cli · TEAM_KEY').waitFor()
    await wizard.getByRole('button', { name: 'Install entry', exact: true }).click()
    await wizard.getByText('Missing credentials', { exact: true }).first().waitFor({ timeout: 60000 })
    expect(await execution()).toMatchObject({ enabled: false, suiteOrigin: 'suite:team-suite', variables: [{ name: 'TEAM_KEY', configured: false }] })
    expect(
      (
        await page.request.post(origin + '/admin/api/skills/execution?name=team-cli', {
          headers: { origin },
          data: { enabled: true, commands: [{ command: 'team-cli', blocked: [] }], variables: [{ name: 'TEAM_KEY', secret: true, value: 'x' }] },
        })
      ).status(),
    ).toBe(403)
    const details = page.getByRole('dialog', { name: 'Team suite' })
    await details.getByText('Delegated execution is off until these credentials are saved: TEAM_KEY').waitFor()
    await details.getByLabel('TEAM_KEY').fill(secret)
    await details.getByRole('button', { name: 'Save credentials', exact: true }).click()
    await details.getByText('Credentials are saved. Delegated execution is on.', { exact: true }).waitFor()
    expect(await execution()).toMatchObject({ enabled: true, variables: [{ name: 'TEAM_KEY', configured: true }] })
    await details.getByRole('button', { name: 'Close catalog entry details', exact: true }).click()
    await card.getByText('Installed', { exact: true }).first().waitFor()
    catalogFixture.fail(true)
    await page.reload()
    const outside = page.getByRole('button', { name: 'Catalog entry details', exact: true })
    await outside.click()
    const offline = page.getByRole('dialog', { name: 'team-suite', exact: true })
    await offline.getByLabel('TEAM_KEY', { exact: true }).fill(secret)
    await offline.getByRole('button', { name: 'Save credentials', exact: true }).click()
    await offline.getByText('Credentials saved.', { exact: true }).waitFor()
    await offline.getByRole('button', { name: 'Close catalog entry details', exact: true }).click()
    catalogFixture.fail(false)
    await page.reload()
    const catalog = await (await page.request.get(origin + '/admin/api/suites')).text()
    expect(catalog).not.toContain(secret)
    expect(JSON.stringify(await execution())).not.toContain(secret)
    expect(await filesContaining(root, secret)).toEqual([])

    const expertsBefore = await (await page.request.get(origin + '/admin/api/experts')).json()
    expect(
      (
        await page.request.post(origin + '/admin/api/experts', {
          headers: { origin },
          data: {
            revision: expertsBefore.revision,
            expert: {
              name: 'Catalog reader',
              description: 'Reads team guides',
              icon: 'R',
              persona: 'Read the guides.',
              skills: ['team-cli'],
              skillPacks: ['team-suite'],
              model: null,
            },
          },
        })
      ).status(),
    ).toBe(200)
    await uninstall(page, card, 'Catalog reader')
    const expertsAfter = await (await page.request.get(origin + '/admin/api/experts')).json()
    expect(expertsAfter.experts[0]).toMatchObject({ name: 'Catalog reader', skills: [], skillPacks: [] })
    await expect.poll(async () => (await page.request.get(origin + '/admin/api/skills/execution?name=team-cli')).status()).toBe(404)

    // Path two: enter the credential in the wizard, so execution is enabled once the install completes.
    await openWizard(page, card)
    await wizard.getByLabel('TEAM_KEY').fill(secret)
    await wizard.getByRole('button', { name: 'Install entry', exact: true }).click()
    await wizard.getByText('Installed', { exact: true }).first().waitFor({ timeout: 60000 })
    await wizard.getByRole('button', { name: 'Close catalog entry details', exact: true }).click()
    expect(await execution()).toMatchObject({ enabled: true, variables: [{ name: 'TEAM_KEY', configured: true }] })
    expect(await filesContaining(root, secret)).toEqual([])
    await uninstall(page, card)
    expect(await filesContaining(root, secret)).toEqual([])
    await expect.poll(async () => await (await page.request.get(origin + '/admin/api/runtime-dependencies')).json()).toHaveLength(0)

    // Optional provider alternatives: skipping all is off, and filling one does not require another provider.
    const original = (await (await fetch(catalogFixture.address)).json()) as { entries: SuiteCatalogDocumentEntry[] }
    catalogFixture.publish(
      original.entries.map(entry =>
        entry.kind !== 'suite'
          ? entry
          : {
              ...entry,
              version: '2.0.0',
              items: entry.items.map(item =>
                item.kind === 'execution'
                  ? {
                      ...item,
                      variables: [
                        { name: 'TEAM_KEY', optional: true, purpose: { en: 'Team API key', 'zh-CN': '团队 API key' } },
                        { name: 'SECOND_KEY', optional: true, purpose: { en: 'Second provider API key', 'zh-CN': '另一个后端的 API key' } },
                      ],
                    }
                  : item,
              ),
            },
      ),
    )
    await page.reload()
    await openWizard(page, card)
    await wizard.getByRole('button', { name: 'Install entry', exact: true }).click()
    await wizard.getByText('Installed', { exact: true }).first().waitFor({ timeout: 60000 })
    await details.getByText('Delegated execution is off. Configure a backend when needed.', { exact: true }).waitFor()
    expect(await details.getByText('Credentials are saved. Delegated execution is on.', { exact: true }).count()).toBe(0)
    await details.getByLabel('TEAM_KEY').fill(secret)
    await details.getByRole('button', { name: 'Save credentials', exact: true }).click()
    await details.getByText('Credentials are saved. Delegated execution is on.', { exact: true }).waitFor()
    expect(await execution()).toMatchObject({
      enabled: true,
      variables: [
        { name: 'TEAM_KEY', configured: true },
        { name: 'SECOND_KEY', configured: false },
      ],
    })
    expect(await details.getByText('A credential is saved. Leave blank to keep it. Second provider API key', { exact: true }).count()).toBe(0)
    await details.getByRole('button', { name: 'Close catalog entry details', exact: true }).click()
    await uninstall(page, card)
    catalogFixture.publish(original.entries)
    await page.reload()

    // Chinese copy for the skip path: wizard step, missing-credential status and the details form.
    await page.context().addCookies([{ name: 'dsh-phalanx.lang', value: 'zh-CN', url: origin }])
    await page.reload()
    const zhCard = page.locator('.plugin-library-card').filter({ hasText: '团队套件' })
    await zhCard.getByText('未安装', { exact: true }).waitFor()
    await zhCard.getByRole('button', { name: '查看广场条目 团队套件', exact: true }).click()
    const zhWizard = page.getByRole('dialog', { name: '团队套件' })
    await zhWizard.getByText('团队凭据（可选）', { exact: true }).waitFor()
    await zhWizard.getByText('可以跳过这一步。凭据全部保存之前，代执行保持关闭。', { exact: true }).waitFor()
    await zhWizard.getByText('代执行 · team-cli · TEAM_KEY').waitFor()
    await zhWizard.getByRole('button', { name: '安装条目', exact: true }).click()
    await zhWizard.getByText('缺少凭据', { exact: true }).waitFor({ timeout: 60000 })
    await page.getByRole('dialog', { name: '团队套件' }).getByText('保存以下凭据之前，代执行保持关闭：TEAM_KEY').waitFor()
    await zhWizard.getByRole('button', { name: '关闭广场条目详情', exact: true }).click()
    await page.context().addCookies([{ name: 'dsh-phalanx.lang', value: 'en', url: origin }])
    await page.reload()
    await uninstall(page, card)

    await page.setViewportSize({ width: 560, height: 720 })
    const backendLabel = { en: 'Chat backend', 'zh-CN': '对话后端' }
    catalogFixture.publish(
      original.entries.map(entry =>
        entry.kind === 'suite'
          ? {
              ...entry,
              version: '3.0.0',
              engines: { platform: '>=0.1.35' },
              items: entry.items.map(item =>
                item.kind === 'execution'
                  ? {
                      ...item,
                      delegated: item.delegated.map(command => ({ ...command, blockedShortOptions: ['-b'], shortOptionsWithValue: ['-o'] })),
                      variables: [
                        ...item.variables,
                        ...['TEAM_URL', 'TEAM_PROVIDER', 'SECOND_KEY', 'SECOND_URL', 'SECOND_ALIAS'].map(name => ({ name, purpose: backendLabel })),
                      ],
                      serviceSlots: [
                        {
                          id: 'chat',
                          label: backendLabel,
                          commands: ['team-cli'],
                          backends: [
                            {
                              id: 'compatible',
                              label: { en: 'Compatible API', 'zh-CN': '兼容接口' },
                              selector: { kind: 'environment', name: 'TEAM_PROVIDER', value: 'compatible' },
                              fields: [
                                { name: 'TEAM_URL', type: 'url', required: true },
                                { name: 'TEAM_KEY', type: 'secret', required: true },
                              ],
                            },
                            {
                              id: 'second',
                              label: { en: 'Second API', 'zh-CN': '第二接口' },
                              selector: { kind: 'environment', name: 'TEAM_PROVIDER', value: 'second' },
                              fields: [
                                { name: 'SECOND_KEY', type: 'secret', required: false, requiredGroup: 'provider-key' },
                                { name: 'SECOND_URL', type: 'url', required: false },
                                { name: 'SECOND_ALIAS', type: 'secret', required: false, requiredGroup: 'provider-key' },
                              ],
                            },
                          ],
                        },
                      ],
                    }
                  : item,
              ),
            }
          : entry,
      ),
    )
    await page.reload()
    await openWizard(page, card)
    await wizard.getByText('Compatible API', { exact: true }).click()
    const installButton = wizard.getByRole('button', { name: 'Install entry', exact: true })
    expect(
      await installButton.evaluate(button => {
        const { top, bottom, left, right } = button.getBoundingClientRect()
        return top >= 0 && bottom <= window.innerHeight && left >= 0 && right <= window.innerWidth
      }),
    ).toBe(true)
    await wizard.getByLabel('TEAM_URL', { exact: true }).fill('https://service.example.test/v1')
    await wizard.getByLabel('TEAM_KEY', { exact: true }).fill(secret)
    await wizard.getByText('Second API', { exact: true }).click()
    await wizard.getByLabel('SECOND_ALIAS', { exact: true }).fill('fixture-second-key')
    await wizard.getByRole('button', { name: 'Close catalog entry details', exact: true }).click()
    const guard = page.getByRole('dialog', { name: 'Unsaved changes', exact: true })
    await guard.getByRole('button', { name: 'Continue editing', exact: true }).click()
    expect(await wizard.getByLabel('TEAM_KEY', { exact: true }).inputValue()).toBe(secret)
    let failed = false
    await page.route('**/admin/api/skills/execution/services?name=team-cli', async route => {
      if (route.request().method() === 'POST' && !failed) {
        failed = true
        await route.fulfill({ status: 503, json: { error: 'Fixture backend save failure' } })
      } else await route.continue()
    })
    await wizard.getByRole('button', { name: 'Install entry', exact: true }).click()
    await wizard.getByText('Installation succeeded. Some setup actions still need attention.', { exact: true }).waitFor()
    const stored = async () => await (await page.request.get(origin + '/admin/api/skills/execution/services?name=team-cli')).json()
    const firstBackend = async () => (await stored()).slots[0].backends[0]
    expect((await stored()).slots[0].backends[1]).toMatchObject({ complete: false })
    await wizard.getByRole('button', { name: 'Retry setup', exact: true }).click()
    await wizard.getByText('Installation succeeded. Some setup actions still need attention.', { exact: true }).waitFor({ state: 'hidden' })
    await expect.poll(firstBackend).toMatchObject({
      complete: true,
      enabled: false,
      fields: [
        { name: 'TEAM_URL', value: 'https://service.example.test/v1' },
        { name: 'TEAM_KEY', configured: true },
      ],
    })
    await expect.poll(async () => (await stored()).slots[0].backends[1]).toMatchObject({ complete: true })
    expect(JSON.stringify(await stored())).not.toContain(secret)
    await wizard.getByRole('button', { name: 'Close catalog entry details', exact: true }).click()
    await page.getByRole('tab', { name: 'Skills', exact: true }).click()
    await page.getByRole('button', { name: 'View skills in team-suite', exact: true }).click()
    await page.getByRole('button', { name: 'View skill team-cli', exact: true }).click()
    await page.getByRole('tab', { name: 'Platform execution', exact: true }).click()
    const settings = page.getByRole('region', { name: 'Service backends', exact: true })
    await settings.locator('summary').filter({ hasText: 'Compatible API' }).click()
    expect(await settings.getByLabel('TEAM_URL', { exact: true }).inputValue()).toBe('https://service.example.test/v1')
    expect(await settings.getByLabel('TEAM_KEY', { exact: true }).inputValue()).toBe('')
    await settings.getByRole('button', { name: 'Enable', exact: true }).click()
    await expect.poll(firstBackend).toMatchObject({ enabled: true })
    await settings.getByRole('button', { name: 'Clear TEAM_KEY', exact: true }).click()
    await page.getByRole('dialog', { name: 'Clear saved credential', exact: true }).getByRole('button', { name: 'Clear saved credential', exact: true }).click()
    await expect.poll(firstBackend).toMatchObject({
      enabled: false,
      fields: [
        { name: 'TEAM_URL', value: 'https://service.example.test/v1' },
        { name: 'TEAM_KEY', configured: false },
      ],
    })
    await page.getByText('Service configuration saved.', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Close skill details', exact: true }).click()
    await page.getByRole('tab', { name: 'Skill catalog', exact: true }).click()
    const servicePath = '/admin/api/skills/execution/services?name=team-cli'
    const routePattern = '**' + servicePath
    const warning = wizard.getByText('Installation succeeded. Some setup actions still need attention.', { exact: true })
    const manual = wizard.getByText('Review and enter these values in the installed service settings.', { exact: true })
    for (const scenario of ['lost-response', 'concurrent-write']) {
      await page.unroute(routePattern)
      await uninstall(page, card)
      await openWizard(page, card)
      await wizard.getByText('Compatible API', { exact: true }).click()
      await wizard.getByLabel('TEAM_URL', { exact: true }).fill('https://service.example.test/v1')
      await wizard.getByLabel('TEAM_KEY', { exact: true }).fill(secret)
      await wizard.getByText('Second API', { exact: true }).click()
      await wizard.getByLabel('SECOND_URL', { exact: true }).fill('https://stale.example.test')
      let setupPosts = 0
      await page.route(routePattern, async route => {
        if (route.request().method() !== 'POST') return route.continue()
        setupPosts++
        if (setupPosts !== 1) return route.continue()
        const committed = await route.fetch()
        expect(committed.ok()).toBe(true)
        if (scenario === 'lost-response') {
          await route.fulfill({ status: 503, json: { error: 'Fixture lost response after commit' } })
          return
        }
        const result = await committed.json()
        const concurrent = await page.request.post(origin + servicePath, {
          headers: { origin },
          data: {
            revision: result.revision,
            change: { action: 'save', slot: 'chat', backend: 'second', values: { SECOND_URL: 'https://current.example.test' } },
          },
        })
        expect(concurrent.ok()).toBe(true)
        await route.fulfill({ response: committed })
      })
      await installButton.click()
      await warning.waitFor()
      if (scenario === 'lost-response') await wizard.getByRole('button', { name: 'Retry setup', exact: true }).click()
      await manual.waitFor()
      expect(setupPosts).toBe(1)
      expect((await firstBackend()).complete).toBe(true)
      expect((await stored()).slots[0].backends[1].fields[1].value).toBe(scenario === 'concurrent-write' ? 'https://current.example.test' : '')
      await wizard.getByRole('button', { name: 'Discard pending setup', exact: true }).click()
      await wizard.getByRole('button', { name: 'Close catalog entry details', exact: true }).click()
    }
    const detached = await page.request.post(origin + '/admin/api/suites', {
      headers: { origin },
      data: { action: 'detach', id: 'team-suite', input: { kind: 'skill', name: 'team-cli' } },
    })
    expect(detached.ok(), await detached.text()).toBe(true)
    await page.reload()
    await page.getByRole('tab', { name: 'Skills', exact: true }).click()
    await page.getByRole('button', { name: 'View skills in team-suite', exact: true }).click()
    await page.getByRole('button', { name: 'View skill team-cli', exact: true }).click()
    await page.getByRole('tab', { name: 'Platform execution', exact: true }).click()
    await page.getByRole('textbox', { name: 'Blocked first arguments', exact: true }).fill('fixture-argument')
    await page.getByRole('button', { name: 'Save execution settings', exact: true }).click()
    await expect
      .poll(async () => (await execution()).commands)
      .toMatchObject([{ command: 'team-cli', blocked: ['fixture-argument'], blockedOptions: ['-b'], shortOptionsWithValue: ['-o'] }])
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

async function openWizard(page: Page, card: ReturnType<Page['locator']>) {
  await card.getByText('Not installed', { exact: true }).waitFor()
  await card.getByRole('button', { name: 'View catalog entry Team suite', exact: true }).click()
  await page.getByRole('dialog', { name: 'Team suite' }).getByText('This entry will install:', { exact: true }).waitFor()
}
async function uninstall(page: Page, card: ReturnType<Page['locator']>, expert?: string) {
  await card.getByRole('button', { name: 'Uninstall', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Team suite' })
  await dialog.getByText('Delegated execution · team-cli').waitFor()
  // hidden in 0.1.32: uninstall still removes references without showing expert names.
  if (expert) expect(await dialog.getByText(`Will be removed from experts: ${expert}`, { exact: true }).count()).toBe(0)
  await dialog.getByRole('button', { name: 'Confirm uninstall', exact: true }).click()
  await card.getByText('Not installed', { exact: true }).waitFor()
}
/** Only the protected execution configuration may hold the credential; member projections and records never do. */
async function filesContaining(root: string, value: string): Promise<readonly string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true })
  const files = entries.filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name))
  const matches = await Promise.all(files.map(async file => ((await readFile(file)).includes(value) ? [file.slice(root.length + 1)] : [])))
  return matches.flat().sort()
}
