// Validation: T1; real credentials: none; controlled browser/process fixtures. CI selects its explicit public-entry subset.
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser } from 'playwright'
import { expect, it, vi } from 'vitest'
import { createCommunityApplication } from '../src/composition/community-application.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { FileSkillArtifacts } from '../src/adapters/skill-artifacts.js'
import { FileSkillDistribution } from '../src/adapters/skill-distribution.js'
import { gitFixture } from './fixtures/skills/git-repository.js'
import { validSkill } from './fixtures/skills/archive.js'
import type { CommunityApplication } from '../src/ports/community-application.js'

it('imports manifest groups from Git and reviews manual updates through the same confirmation page', async () => {
  const fixture = await gitFixture(), root = await mkdtemp(join(tmpdir(), 'community-git-'))
  let browser: Browser | undefined, app: CommunityApplication | undefined
  const skill = (name: string, text = 'A useful skill') => validSkill.replace('example-skill', name).replace('A useful skill', text)
  try {
    const first = await fixture.commit({ 'skills/one/SKILL.md': skill('one'), 'skills/gone/SKILL.md': skill('gone'), 'skills/other/SKILL.md': skill('other'), '.claude-plugin/plugin.json': JSON.stringify({ name: 'fixture-pack', description: 'Repository group', skills: ['./skills/one', './skills/gone'] }) })
    vi.stubEnv('HTTPS_PROXY', fixture.proxy); vi.stubEnv('GIT_SSL_CAINFO', fixture.caFile)
    app = createCommunityApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'git-fixture-session-secret-32-bytes', runtime: { command: '/unavailable-dsh', args: [], dataRoot: root, defaultModel: { provider: 'deepseek-official', model: 'deepseek-chat', upstream: { baseUrl: 'https://api.deepseek.com' } } } })
    const origin = await app.start(); browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({ locale: 'en' }); page.setDefaultTimeout(15_000)
    await page.goto(`${origin}/bootstrap#credential=${readBootstrapCredential(root)!.credential}`)
    await page.getByLabel('Username', { exact: true }).fill('admin'); await page.getByLabel('Password', { exact: true }).fill('password')
    await page.getByRole('button', { name: 'Create administrator' }).click(); await page.waitForURL(`${origin}/admin`)
    await page.getByRole('link', { name: 'Skill library', exact: true }).click(); await page.getByRole('button', { name: 'Import skill', exact: true }).click()
    await page.getByRole('tab', { name: 'Git repository', exact: true }).click(); await page.getByLabel('Public Git source', { exact: true }).fill(fixture.url)
    await page.getByRole('button', { name: 'Preview skill', exact: true }).click()
    await page.getByRole('heading', { name: 'fixture-pack', exact: true }).waitFor(); await page.getByRole('heading', { name: 'Other skills', exact: true }).waitFor()
    expect(await page.getByRole('checkbox', { name: 'Create suggested pack fixture-pack', exact: true }).isChecked()).toBe(true)
    await page.getByRole('button', { name: 'Confirm import', exact: true }).click()
    await page.getByRole('button', { name: 'View skill one', exact: true }).click(); await page.getByRole('tab', { name: 'Version management', exact: true }).click()
    await page.getByText(first, { exact: true }).waitFor()
    const second = await fixture.commit({ 'skills/one/SKILL.md': skill('one', 'Updated one'), 'skills/gone/SKILL.md': null, 'skills/new/SKILL.md': skill('new') })
    await page.getByRole('button', { name: 'Check skill updates', exact: true }).click(); await page.getByRole('button', { name: 'Check skill updates', exact: true }).click()
    await page.getByRole('heading', { name: 'Deleted from source', exact: true }).waitFor()
    await page.getByText('Affected skill packs: fixture-pack', { exact: true }).waitFor()
    expect(await page.getByRole('checkbox', { name: 'other', exact: true }).isChecked()).toBe(false)
    expect(await page.getByRole('checkbox', { name: 'Create suggested pack fixture-pack', exact: true }).isChecked()).toBe(false)
    await page.getByText('Changed skill', { exact: true }).waitFor(); await page.getByText('New skill', { exact: true }).waitFor()
    await page.getByText('Replace existing one', { exact: true }).click(); await page.getByText('Remove missing gone', { exact: true }).click()
    const evidence = process.env.DSH_PHALANX_E2E_EVIDENCE_DIR
    if (evidence) { await mkdir(evidence, { recursive: true }); await page.screenshot({ path: join(evidence, 'git-update-desktop.png'), fullPage: true }) }
    await page.getByRole('button', { name: 'Confirm replacement', exact: true }).click(); await page.getByRole('button', { name: 'View skill new', exact: true }).waitFor()
    const rows = await (await page.request.get(origin + '/admin/api/skills')).json()
    expect(rows.map((row: { name: string }) => row.name).sort()).toEqual(['new', 'one', 'other'])
    expect(rows.find((row: { name: string }) => row.name === 'one').source.commit).toBe(second)
    await page.getByRole('button', { name: /Platform language/ }).click(); await page.getByRole('menuitemradio', { name: '简体中文', exact: true }).click()
    await page.getByRole('button', { name: '导入技能', exact: true }).click(); await page.getByRole('tab', { name: 'Git 仓库', exact: true }).click()
    await page.getByLabel('公开 Git 来源', { exact: true }).fill(fixture.url); await page.getByRole('button', { name: '预览技能', exact: true }).click()
    await page.getByRole('heading', { name: '其他技能', exact: true }).waitFor(); await page.setViewportSize({ width: 390, height: 844 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    if (evidence) await page.screenshot({ path: join(evidence, 'git-import-mobile-zh.png'), fullPage: true })
    await page.getByRole('button', { name: '取消', exact: true }).last().click()
  } finally {
    await browser?.close(); await app?.stop(); vi.unstubAllEnvs()
    const artifacts = new FileSkillArtifacts(join(root, 'skills/artifacts'), []); await new FileSkillDistribution(join(root, 'skills/members'), artifacts).synchronize([]); await artifacts.collect([])
    await rm(root, { recursive: true, force: true }); await fixture.close()
  }
}, 60_000)
