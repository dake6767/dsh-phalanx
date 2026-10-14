import { FileSkillArtifacts } from '../src/adapters/skill-artifacts.js'
import { FileSkillDistribution } from '../src/adapters/skill-distribution.js'
import { FileExecutionArtifacts } from '../src/adapters/execution-artifacts.js'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser } from 'playwright'
import { afterEach, expect, it } from 'vitest'
import { createCommunityApplication } from '../src/composition/community-application.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import type { CommunityApplication } from '../src/ports/community-application.js'
import { skillZip, validSkill } from './fixtures/skills/archive.js'
let app: CommunityApplication | undefined, browser: Browser | undefined, root: string | undefined
// Skills are immutable while available; removal through the public API releases their files.
afterEach(async () => { await browser?.close(); await app?.stop(); if (root) { const artifacts = new FileSkillArtifacts(join(root, 'skills/artifacts'), []); await new FileSkillDistribution(join(root, 'skills/members'), artifacts).synchronize([]); await artifacts.collect([]); await new FileExecutionArtifacts(join(root, 'execution/artifacts')).collect([]); await rm(root, { recursive: true, force: true }) } })
it('reviews multiple import candidates, confirms replacements and keeps orchestration out of the plain library', async () => {
  root = await mkdtemp(join(tmpdir(), 'community-skills-'))
  app = createCommunityApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'skills-fixture-session-secret-32-bytes', runtime: { command: '/unavailable-dsh', args: [], dataRoot: root, defaultModel: { provider: 'deepseek-official', model: 'deepseek-chat', upstream: { baseUrl: 'https://api.deepseek.com' } } } })
  const origin = await app.start(); browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ locale: 'en' }); page.setDefaultTimeout(10_000)
  // HTTP deployments do not expose this secure-context API; form row identities must work without it.
  await page.addInitScript(() => { Object.defineProperty(Crypto.prototype, 'randomUUID', { value: undefined, configurable: true }) })
  const evidence = process.env.DSH_PHALANX_E2E_EVIDENCE_DIR
  if (evidence) await mkdir(evidence, { recursive: true })
  const screenshot = async (name: string) => { if (evidence) await page.screenshot({ path: join(evidence, name), fullPage: true, animations: 'disabled' }) }
  expect((await page.request.get(`${origin}/admin/api/skills`)).status()).toBe(401)
  await page.goto(`${origin}/bootstrap#credential=${readBootstrapCredential(root)!.credential}`)
  await page.getByLabel('Username', { exact: true }).fill('admin'); await page.getByLabel('Password', { exact: true }).fill('password')
  await page.getByRole('button', { name: 'Create administrator' }).click(); await page.waitForURL(`${origin}/admin`)
  const existing = await (await page.request.post(origin + '/admin/api/skills/upload', { headers: { origin, 'content-type': 'application/zip' }, data: skillZip([{ path: 'SKILL.md', content: validSkill.replace('example-skill', 'one') }]) })).json()
  expect((await page.request.post(origin + '/admin/api/skills/change', { headers: { origin }, data: { action: 'confirm', token: existing.token, revision: existing.revision } })).status()).toBe(200)
  await page.getByRole('link', { name: 'Skill library', exact: true }).click()
  await page.getByRole('button', { name: 'Import skill', exact: true }).click()
  const multi = skillZip([
    { path: 'meta/SKILL.md', content: validSkill.replace('example-skill', 'research-flow').replace('description: A useful skill', 'description: Research workflow\norchestration:\n  children: [one, two]') },
    { path: 'one/SKILL.md', content: validSkill.replace('example-skill', 'one').replace('A useful skill', 'Updated one') },
    { path: 'one/.env', content: 'FIXTURE_TOKEN=fictional-candidate-credential' },
    { path: 'two/SKILL.md', content: validSkill.replace('example-skill', 'two') },
    { path: 'hidden/SKILL.md', content: validSkill.replace('example-skill', 'internal-skill').replace('description: A useful skill', 'description: A useful skill\nmetadata:\n  internal: true') },
  ])
  await page.getByLabel('Skill archive (.zip)', { exact: true }).setInputFiles({ name: 'bundle.zip', mimeType: 'application/zip', buffer: multi })
  await page.getByRole('button', { name: 'Preview skill', exact: true }).click()
  await page.getByRole('heading', { name: 'Import candidates', exact: true }).waitFor()
  expect(await page.getByLabel('Pack name', { exact: true }).inputValue()).toBe('research-flow')
  expect(await page.getByRole('checkbox', { name: 'Also create a skill pack', exact: true }).isChecked()).toBe(true)
  expect(await page.getByRole('checkbox', { name: 'research-flow', exact: true }).isDisabled()).toBe(true)
  expect(await page.getByRole('region', { name: 'Import candidate internal-skill', exact: true }).count()).toBe(0)
  await page.getByText('Show internal skills', { exact: true }).click()
  await page.getByRole('region', { name: 'Import candidate internal-skill', exact: true }).waitFor()
  expect(await page.getByRole('checkbox', { name: 'internal-skill', exact: true }).isChecked()).toBe(false)
  await page.getByText('Possible credentials in this skill. Review before sharing.', { exact: true }).waitFor()
  expect(await page.getByRole('button', { name: 'Confirm replacement', exact: true }).isDisabled()).toBe(true)
  expect((await (await page.request.get(origin + '/admin/api/skills')).json()).map((row: { name: string }) => row.name)).toEqual(['one'])
  await screenshot('multi-skill-import-desktop.png')
  await page.getByText('Replace existing one', { exact: true }).click()
  await page.getByRole('button', { name: 'Confirm replacement', exact: true }).click()
  await page.getByRole('button', { name: 'View skill two', exact: true }).waitFor()
  const skills = await (await page.request.get(origin + '/admin/api/skills')).json()
  expect(skills.map((row: { name: string }) => row.name)).toEqual(['one', 'two'])
  expect(skills.every((row: { packs: string[] }) => row.packs.includes('research-flow'))).toBe(true)
  const packs = await (await page.request.get(origin + '/admin/api/skill-packs')).json()
  expect(packs.packs[0]).toMatchObject({ name: 'research-flow', skills: ['one', 'two'], published: false })
  await page.getByRole('button', { name: /Platform language/ }).click(); await page.getByRole('menuitemradio', { name: '简体中文', exact: true }).click()
  await page.getByRole('button', { name: '导入技能', exact: true }).click()
  await page.getByLabel('技能压缩包（.zip）', { exact: true }).setInputFiles({ name: 'bundle.zip', mimeType: 'application/zip', buffer: multi })
  await page.getByRole('button', { name: '预览技能', exact: true }).click()
  await page.getByRole('heading', { name: '导入候选集', exact: true }).waitFor()
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await screenshot('multi-skill-import-mobile-zh.png')
  await page.getByRole('button', { name: '取消', exact: true }).last().click()
})
