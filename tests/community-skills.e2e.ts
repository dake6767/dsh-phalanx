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
afterEach(async () => { await browser?.close(); await app?.stop(); if (root) await rm(root, { recursive: true, force: true }) })
it('imports, previews, replaces and removes skills in the member/plugin page framework without fetching markdown resources', async () => {
  root = await mkdtemp(join(tmpdir(), 'community-skills-'))
  app = createCommunityApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'skills-fixture-session-secret-32-bytes', runtime: { command: '/unavailable-dsh', args: [], dataRoot: root, defaultModel: { provider: 'deepseek-official', model: 'deepseek-chat', upstream: { baseUrl: 'https://api.deepseek.com' } } } })
  const origin = await app.start(); browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ locale: 'en' }); page.setDefaultTimeout(10_000)
  const evidence = process.env.DSH_PHALANX_E2E_EVIDENCE_DIR
  if (evidence) await mkdir(evidence, { recursive: true })
  const screenshot = async (name: string) => { if (evidence) await page.screenshot({ path: join(evidence, name), fullPage: true, animations: 'disabled' }) }
  const external: string[] = []; page.on('request', request => { if (request.url().includes('untrusted.example')) external.push(request.url()) })
  expect((await page.request.get(`${origin}/admin/api/skills`)).status()).toBe(401)
  await page.goto(`${origin}/bootstrap#credential=${readBootstrapCredential(root)!.credential}`)
  await page.getByLabel('Username', { exact: true }).fill('admin'); await page.getByLabel('Password', { exact: true }).fill('password')
  await page.getByRole('button', { name: 'Create administrator' }).click(); await page.waitForURL(`${origin}/admin`)
  await page.getByRole('link', { name: 'Skill library', exact: true }).click()
  await page.getByText('No skills yet', { exact: true }).waitFor()
  const upload = async (body: string) => {
    await page.getByRole('button', { name: 'Import skill', exact: true }).click()
    await page.getByLabel('Skill archive (.zip)', { exact: true }).setInputFiles({ name: 'skill.zip', mimeType: 'application/zip', buffer: skillZip([{ path: 'SKILL.md', content: body }, { path: '_meta.json', content: 'opaque market metadata' }]) })
    await page.getByRole('button', { name: 'Preview skill', exact: true }).click()
    await page.getByRole('dialog').getByText('_meta.json', { exact: true }).waitFor()
  }
  await upload(validSkill + '\n# Safe preview\n![remote](https://untrusted.example/image.png)\n<script>alert(1)</script>')
  expect(await (await page.request.get(`${origin}/admin/api/skills`)).json()).toEqual([])
  await page.getByRole('button', { name: 'Confirm import', exact: true }).click()
  await screenshot('skills-list-desktop.png')
  await page.getByRole('button', { name: 'View skill example-skill', exact: true }).click()
  await page.getByRole('dialog').getByRole('heading', { name: 'Safe preview' }).waitFor()
  await screenshot('skill-details-desktop.png')
  expect(await page.getByRole('dialog').locator('img').count()).toBe(0); expect(external).toEqual([])
  await page.getByRole('button', { name: 'Close skill details', exact: true }).click()
  await upload(validSkill.replace('A useful skill', 'Updated skill'))
  await page.getByText('Changes apply to new sessions. Running tasks using this skill may fail.', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Confirm replacement', exact: true }).click()
  expect(await (await page.request.get(`${origin}/admin/api/skills`)).json()).toEqual([expect.objectContaining({ name: 'example-skill', description: 'Updated skill', published: false })])
  const csrf = await page.request.post(`${origin}/admin/api/skills/change`, { headers: { origin: 'https://other.example.test' }, data: { action: 'remove', name: 'example-skill', revision: 'invalid' } })
  expect(csrf.status()).toBe(403)
  await page.getByRole('button', { name: 'View skill example-skill', exact: true }).click()
  await page.getByRole('tab', { name: 'Version management', exact: true }).click()
  await page.getByRole('button', { name: 'Remove skill', exact: true }).click()
  await page.getByRole('button', { name: 'Confirm removal', exact: true }).click()
  await page.getByText('No skills yet', { exact: true }).waitFor()
  await page.getByRole('button', { name: /Platform language/ }).click(); await page.getByRole('option', { name: '简体中文', exact: true }).click()
  await page.getByRole('heading', { name: '技能库', exact: true }).waitFor()
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await screenshot('skills-empty-mobile-zh.png')
})
