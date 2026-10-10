import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { chromium } from 'playwright'
import { expect, it, vi } from 'vitest'
import { createCommunityApplication } from '../src/composition/community-application.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { FileSkillArtifacts } from '../src/adapters/skill-artifacts.js'
import { FileSkillDistribution } from '../src/adapters/skill-distribution.js'
import { skillZip, validSkill } from './fixtures/skills/archive.js'

it('keeps plugin and skill grants in group tabs, confirms new-session impact and preserves administrator grants', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skill-grants-ui-'))
  const app = createCommunityApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'skill-grants-fixture-session-32-bytes', runtime: { command: '/unavailable', args: [], dataRoot: root, defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'https://example.test' } } } })
  const browser = await chromium.launch({ headless: true })
  try {
    const origin = await app.start(), page = await browser.newPage({ locale: 'en' }); page.setDefaultTimeout(10_000)
    await page.goto(`${origin}/bootstrap#credential=${readBootstrapCredential(root)!.credential}`)
    await page.getByLabel('Username', { exact: true }).fill('admin'); await page.getByLabel('Password', { exact: true }).fill('password')
    await page.getByRole('button', { name: 'Create administrator' }).click(); await page.waitForURL(`${origin}/admin`)
    const preview = await (await page.request.post(origin + '/admin/api/skills/upload', { headers: { origin, 'content-type': 'application/zip' }, data: skillZip([{ path: 'SKILL.md', content: validSkill }]) })).json()
    expect((await page.request.post(origin + '/admin/api/skills/change', { headers: { origin }, data: { action: 'confirm', token: preview.token, revision: preview.revision } })).status()).toBe(200)
    expect((await page.request.post(origin + '/admin/api/accounts', { headers: { origin }, data: { username: 'member', email: '', password: 'password' } })).status()).toBe(201)
    await page.getByRole('link', { name: 'Group management', exact: true }).click()
    const ordinary = page.getByRole('row').filter({ hasText: 'Ordinary group' })
    await ordinary.getByRole('button', { name: 'Details', exact: true }).click()
    await page.getByRole('tab', { name: 'Skills', exact: true }).click()
    const checkbox = page.getByRole('checkbox', { name: 'example-skill', exact: true })
    await checkbox.waitFor(); expect(await checkbox.isChecked()).toBe(false)
    await page.getByRole('dialog').getByText('example-skill', { exact: true }).click(); await page.getByRole('button', { name: 'Save grants', exact: true }).click()
    await page.getByText('Changes apply to new sessions. Running tasks using this skill may fail.', { exact: true }).waitFor()
    await page.getByText('1 affected members', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Confirm action', exact: true }).click()
    await expect.poll(() => page.getByRole('button', { name: 'Save grants', exact: true }).isDisabled()).toBe(true)
    const groups = await (await page.request.get(origin + '/admin/api/groups')).json()
    expect(groups.find((group: { kind: string }) => group.kind === 'ordinary').skillCount).toBe(1)
    const failedDistribution = vi.spyOn(FileSkillDistribution.prototype, 'synchronize').mockRejectedValueOnce(new Error('Disk full'))
    await page.getByRole('dialog').getByText('example-skill', { exact: true }).click(); await page.getByRole('button', { name: 'Save grants', exact: true }).click()
    await page.getByRole('button', { name: 'Confirm action', exact: true }).click()
    await page.getByRole('button', { name: 'Retry skill synchronization', exact: true }).click()
    await expect.poll(() => page.getByRole('button', { name: 'Retry skill synchronization', exact: true }).count()).toBe(0)
    expect((await (await page.request.get(origin + '/admin/api/skills/synchronization')).json()).pending).toBe(false)
    failedDistribution.mockRestore()
    await expect.poll(() => page.getByRole('button', { name: 'Save grants', exact: true }).isDisabled()).toBe(true)
    await page.getByRole('button', { name: 'Close group details', exact: true }).last().click()
    await page.getByRole('row').filter({ hasText: 'Administrators' }).getByRole('button', { name: 'Details', exact: true }).click()
    await page.getByRole('tab', { name: 'Skills', exact: true }).click()
    await checkbox.waitFor(); expect(await checkbox.isChecked()).toBe(true); expect(await checkbox.isDisabled()).toBe(true)
    const evidence = process.env.DSH_PHALANX_E2E_EVIDENCE_DIR
    if (evidence) await page.screenshot({ path: join(evidence, 'group-skill-grants.png'), fullPage: true, animations: 'disabled' })
    await page.getByRole('button', { name: 'Close group details', exact: true }).last().click()
    await page.getByRole('link', { name: 'Skill library', exact: true }).click()
    await page.getByRole('button', { name: 'View skill example-skill', exact: true }).click()
    await page.getByRole('tab', { name: 'Version management', exact: true }).click()
    await page.getByRole('button', { name: 'Remove skill', exact: true }).click()
    const removalFailure = vi.spyOn(FileSkillDistribution.prototype, 'synchronize').mockRejectedValueOnce(new Error('Disk full'))
    await page.getByRole('button', { name: 'Confirm removal', exact: true }).click()
    await page.getByRole('button', { name: 'Retry skill synchronization', exact: true }).click()
    await page.getByText('No skills yet', { exact: true }).waitFor()
    await expect.poll(() => page.getByRole('button', { name: 'Retry skill synchronization', exact: true }).count()).toBe(0)
    expect(await page.getByRole('button', { name: 'View skill example-skill', exact: true }).count()).toBe(0)
    expect(await page.getByRole('dialog').count()).toBe(0)
    removalFailure.mockRestore()

  } finally {
    vi.restoreAllMocks()
    await browser.close(); await app.stop()
    const artifacts = new FileSkillArtifacts(join(root, 'skills/artifacts'), [])
    await new FileSkillDistribution(join(root, 'skills/members'), artifacts).synchronize([]); await artifacts.collect([])
    await rm(root, { recursive: true, force: true })
  }
})
