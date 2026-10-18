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

it('installs a member sign-in suite with the login command shown and no credential step or delegated execution', async () => {
  const fixture = await gitFixture(), root = await mkdtemp(join(tmpdir(), 'suite-member-login-'))
  const commit = await fixture.commit({ 'skills/team-chat/SKILL.md': validSkill.replace('example-skill', 'team-chat').replace('A useful skill', 'Team chat skill') })
  const preparation = 'mkdir bin; printf "#!/bin/sh\\necho chat-cli\\n" > bin/chat-cli; chmod +x bin/chat-cli'
  const login = { en: 'Each member signs in as themselves: run `chat-cli auth init` and scan the QR code.', 'zh-CN': '成员以本人身份登录：执行 `chat-cli auth init` 并扫码。' }
  const presets: readonly SuiteCatalogEntry[] = [{ category: 'suite', id: 'chat-suite', version: '1', title: { en: 'Chat suite', 'zh-CN': '聊天套件' }, description: { en: 'Member sign-in CLI', 'zh-CN': '成员登录 CLI' },
    source: { en: 'fixture', 'zh-CN': '夹具' }, identity: login, dependencies: [],
    items: [
      { kind: 'runtime-dependency', name: 'chat-tools', prepareCommands: { amd64: preparation, arm64: preparation }, pathDirectories: ['bin'], checkCommand: 'chat-cli', commands: ['chat-cli'] },
      { kind: 'skill', source: { type: 'git', url: fixture.url, commit, path: 'skills' }, names: ['team-chat'], runtimeDependency: 'chat-tools' },
      { kind: 'skill-pack', name: 'chat-suite', description: 'Chat pack', note: 'Each member signs in with chat-cli auth init.', skills: ['team-chat'] },
    ] }]
  vi.stubEnv('HTTPS_PROXY', fixture.proxy); vi.stubEnv('GIT_SSL_CAINFO', fixture.caFile)
  const catalogFixture = await legacySuiteCatalogFixture(presets)
  const app = createCommunityApplication({ downloadSources: catalogFixture.downloadSources, listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'suite-login-fixture-secret-0000032', runtime: { command: '/unavailable', args: [], dataRoot: root, defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'https://example.test' } } } }, { suiteCatalog: { address: catalogFixture.address, trustedKeys: catalogFixture.trustedKeys } })
  const browser = await chromium.launch({ headless: true })
  try {
    const origin = await app.start(), page = await browser.newPage({ locale: 'en', viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(30000)
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
    await page.goto(`${origin}/bootstrap#credential=${readBootstrapCredential(root)!.credential}`)
    await page.getByLabel('Username', { exact: true }).fill('admin'); await page.getByLabel('Password', { exact: true }).fill('password')
    await page.getByRole('button', { name: 'Create administrator' }).click(); await page.waitForURL(`${origin}/admin`)
    await page.getByRole('link', { name: 'Suite catalog', exact: true }).click()
    const card = page.locator('.plugin-library-card').filter({ hasText: 'Chat suite' })
    await card.getByRole('button', { name: 'Install', exact: true }).click()
    const wizard = page.getByRole('dialog', { name: 'Chat suite' })
    await wizard.getByText(login.en, { exact: true }).waitFor()
    await wizard.getByText('Access and publication (optional)', { exact: true }).waitFor()
    expect(await wizard.getByText('Team credentials (optional)').count()).toBe(0)
    expect(await wizard.locator('input[type="password"]').count()).toBe(0)
    await wizard.getByRole('button', { name: 'Install entry', exact: true }).click()
    await card.getByText('Installed', { exact: true }).first().waitFor({ timeout: 60000 })
    const installation = (await (await page.request.get(origin + '/admin/api/suites')).json()).installations[0]
    expect(installation.entries.map((row: { kind: string }) => row.kind)).toEqual(['runtime-dependency', 'skill', 'skill-pack'])
    expect(installation.missingCredentials).toBeUndefined()
    expect((await page.request.get(origin + '/admin/api/skills/execution?name=team-chat')).status()).toBe(200)
    expect(await (await page.request.get(origin + '/admin/api/skills/execution?name=team-chat')).json()).toMatchObject({ enabled: false, commands: [], variables: [] })
    await card.getByRole('button', { name: 'View suite entry Chat suite', exact: true }).click()
    const details = page.getByRole('dialog', { name: 'Chat suite' })
    await details.getByText(login.en, { exact: true }).waitFor()
    expect(await details.getByText('Team credentials', { exact: true }).count()).toBe(0)
    // Cancelling the confirmation changes nothing.
    await details.getByRole('button', { name: 'Detach chat-suite from the suite', exact: true }).click()
    const cancelled = page.getByRole('dialog', { name: 'Detach chat-suite from the suite?' })
    await cancelled.getByText('Its grants, publication and references do not change.', { exact: true }).waitFor()
    await cancelled.getByRole('button', { name: 'Cancel', exact: true }).click()
    await cancelled.waitFor({ state: 'detached' })
    expect((await (await page.request.get(origin + '/admin/api/suites')).json()).installations[0].entries).toHaveLength(3)
    // Detach the pack: confirmation explains the consequences, the badge goes away and the pack becomes editable.
    await details.getByRole('button', { name: 'Detach chat-suite from the suite', exact: true }).click()
    const confirm = page.getByRole('dialog', { name: 'Detach chat-suite from the suite?' })
    await confirm.getByText('The entry becomes an ordinary library entry you can edit. It no longer follows suite updates and stays when the suite is uninstalled.', { exact: true }).waitFor()
    await confirm.getByRole('button', { name: 'Detach from suite', exact: true }).click()
    await confirm.waitFor({ state: 'detached' })
    await expect.poll(async () => (await (await page.request.get(origin + '/admin/api/suites')).json()).installations[0].entries.map((row: { kind: string }) => row.kind)).toEqual(['runtime-dependency', 'skill'])
    const packs = (await (await page.request.get(origin + '/admin/api/skill-packs')).json())
    expect(packs.packs.find((row: { name: string }) => row.name === 'chat-suite').suiteOrigin).toBeUndefined()
    expect((await page.request.post(origin + '/admin/api/skill-packs', { headers: { origin }, data: { action: 'save', revision: packs.revision, pack: { name: 'chat-suite', description: 'Edited chat pack', skills: ['team-chat'], instructions: 'Edited.', published: false } } })).status()).toBe(200)
    await page.keyboard.press('Escape')
    await page.context().addCookies([{ name: 'dsh-phalanx.lang', value: 'zh-CN', url: origin }])
    await page.reload()
    await page.locator('.plugin-library-card').filter({ hasText: '聊天套件' }).getByRole('button', { name: '查看套件条目 聊天套件', exact: true }).click()
    const zhDetails = page.getByRole('dialog', { name: '聊天套件' })
    await zhDetails.getByText(login['zh-CN'], { exact: true }).waitFor()
    await zhDetails.getByRole('button', { name: '让 team-chat 脱离套件', exact: true }).click()
    const zhConfirm = page.getByRole('dialog', { name: '让 team-chat 脱离套件？' })
    await zhConfirm.getByText('该条目会变成可编辑的普通条目，之后不再随套件更新，卸载套件时也会保留。', { exact: true }).waitFor()
    await zhConfirm.getByRole('button', { name: '脱离套件', exact: true }).click()
    await zhConfirm.waitFor({ state: 'detached' })
    await zhDetails.getByRole('button', { name: '关闭套件条目详情', exact: true }).click()
    await page.getByRole('link', { name: '技能库', exact: true }).click()
    const skillCard = page.locator('.plugin-library-card').filter({ hasText: 'team-chat' })
    await skillCard.waitFor()
    expect(await skillCard.getByText('来自套件 聊天套件').count()).toBe(0)
    expect(errors).toEqual([])
  } finally {
    await browser.close(); await app.stop(); await catalogFixture.close(); vi.unstubAllEnvs()
    await new FileExecutionArtifacts(join(root, 'runtime-dependencies', '.trees')).collect([])
    spawnSync('chmod', ['-R', 'u+w', root])
    await rm(root, { recursive: true, force: true }); await fixture.close()
  }
})
