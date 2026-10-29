// Validation: T2; real credentials: none; actual Linux rootless DSH. Missing inputs must fail the T2 report gate.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import { FileSkillArtifacts } from '../src/adapters/skill-artifacts.js'
import { FileSkillDistribution } from '../src/adapters/skill-distribution.js'
import { effectiveUserDataRoot } from '../src/domain/storage-layout.js'
import { openNativeSettings, signInCommunity } from './fixtures/community-native-browser.js'
import { removeCommunityFixture } from './fixtures/owned-cleanup.js'
import { skillZip, validSkill } from './fixtures/skills/archive.js'
import { candidateApplication } from './support/candidate-application.js'
import { selectBuiltinDatabase } from './support/community-bootstrap-browser.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { assertPinnedDshRevision, runtimeSection } from './support/real-dsh-runtime.js'

it('publishes reviewed skills and presents install, selected, overridden and managed states in bilingual market tabs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'market-skills-ui-'))
  assertPinnedDshRevision(runtimeSettings)
  const runtime = runtimeSection(root, 'https://example.test', runtimeSettings)
  const app = candidateApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'market-skills-fixture-session-secret', runtime })
  const browser = await chromium.launch({ headless: true })
  try {
    const origin = await app.start(),
      admin = await browser.newPage({ locale: 'en' })
    admin.setDefaultTimeout(10000)
    expect((await admin.request.get(origin + '/market/api/skills')).status()).toBe(401)
    await admin.goto(`${origin}/bootstrap#credential=${readBootstrapCredential(root)!.credential}`)
    await selectBuiltinDatabase(admin)
    await admin.getByLabel('Username', { exact: true }).fill('admin')
    await admin.getByLabel('Password', { exact: true }).fill('password')
    await admin.getByRole('button', { name: 'Create administrator' }).click()
    await admin.waitForURL(origin + '/admin')
    const post = (path: string, data: object) => admin.request.post(origin + '/admin/api/' + path, { headers: { origin }, data })
    expect((await post('accounts', { username: 'member', password: 'password', email: '' })).status()).toBe(201)
    const preview = await (
      await admin.request.post(origin + '/admin/api/skills/upload', {
        headers: { origin, 'content-type': 'application/zip' },
        data: skillZip([{ path: 'SKILL.md', content: validSkill }]),
      })
    ).json()
    expect((await post('skills/change', { action: 'confirm', token: preview.token, revision: preview.revision })).status()).toBe(200)
    await admin.getByRole('link', { name: 'Skill library', exact: true }).click()
    await admin.getByRole('button', { name: 'View skill example-skill', exact: true }).click()
    await admin.getByRole('tab', { name: 'Publication', exact: true }).click()
    await admin.getByRole('button', { name: 'Publish to Platform App Center', exact: true }).click()
    await admin.getByText('0 members selected this skill.', { exact: true }).waitFor()
    const evidence = process.env.DSH_PHALANX_E2E_EVIDENCE_DIR
    if (evidence) await admin.screenshot({ path: join(evidence, 'skill-publication.png'), fullPage: true, animations: 'disabled' })
    await admin.getByRole('button', { name: 'Confirm', exact: true }).click()
    await admin.getByRole('button', { name: 'Unpublish', exact: true }).waitFor()
    const member = await browser.newPage({ locale: 'en' })
    member.setDefaultTimeout(10000)
    if (process.env.DSH_PHALANX_E2E_CPU_THROTTLE) await (await member.context().newCDPSession(member)).send('Emulation.setCPUThrottlingRate', { rate: 4 })
    await signInCommunity(member, origin, 'member', 'password')
    expect(
      (
        await member.request.post(origin + '/admin/api/skills/change', { headers: { origin }, data: { action: 'remove', name: 'example-skill', revision: '' } })
      ).status(),
    ).toBe(403)
    await member.getByRole('button', { name: 'Platform App Center', exact: true }).click()
    await member.getByRole('tab', { name: 'Skills', exact: true }).click()
    await member.getByText('Not installed', { exact: true }).waitFor()
    await member.getByRole('button', { name: 'View skill example-skill', exact: true }).click()
    await member.getByRole('region', { name: 'SKILL.md', exact: true }).waitFor()
    await member.getByRole('button', { name: 'Close skill details', exact: true }).click()
    await member.getByRole('button', { name: 'Install', exact: true }).click()
    await member.getByText('Installed (self-selected skill)', { exact: true }).waitFor()
    const owned = join(effectiveUserDataRoot({ dataRoot: root }), 'member/home/.agents/skills/example-skill')
    await mkdir(owned, { recursive: true })
    await writeFile(join(owned, 'SKILL.md'), validSkill)
    await member.getByRole('button', { name: 'Reload skills', exact: true }).click()
    await member.getByText('Overridden by your own skill with the same name', { exact: true }).waitFor()
    await member.getByRole('button', { name: 'Uninstall', exact: true }).click()
    await member.getByRole('button', { name: 'Install', exact: true }).waitFor()
    await member.getByRole('button', { name: 'Install', exact: true }).click()
    await member.getByRole('button', { name: 'Uninstall', exact: true }).waitFor()
    await rm(owned, { recursive: true })
    const groups = await (await admin.request.get(origin + '/admin/api/groups')).json(),
      group = groups.find((row: { isDefault: boolean }) => row.isDefault)
    const endpoint = `groups/${group.id}/skills`,
      current = await (await admin.request.get(origin + '/admin/api/' + endpoint)).json()
    expect((await post(endpoint, { action: 'save', names: ['example-skill'], revision: current.revision, confirmed: true })).status()).toBe(200)
    await member.getByRole('button', { name: 'Reload skills', exact: true }).click()
    await member.getByText('Installed (platform preinstalled)', { exact: true }).waitFor()
    expect(await member.getByRole('button', { name: 'Installed', exact: true }).isDisabled()).toBe(true)
    expect(
      (await member.request.post(origin + '/market/api/skills', { headers: { origin }, data: { action: 'uninstall', name: 'example-skill' } })).status(),
    ).toBe(409)
    // Refresh the admin detail before confirming the now-current member impact.
    await admin.getByRole('button', { name: 'Close skill details', exact: true }).click()
    await admin.getByRole('button', { name: 'View skill example-skill', exact: true }).click()
    await admin.getByRole('tab', { name: 'Publication', exact: true }).click()
    await admin.getByRole('button', { name: 'Unpublish', exact: true }).click()
    await admin.getByText('1 members selected this skill.', { exact: true }).waitFor()
    await admin.getByRole('button', { name: 'Confirm', exact: true }).click()
    await admin.getByRole('button', { name: 'Publish to Platform App Center', exact: true }).waitFor()
    await openNativeSettings(member)
    await member.getByRole('button', { name: 'English', exact: true }).click()
    await member.getByRole('menuitem', { name: '中文', exact: true }).click()
    await member.keyboard.press('Escape')
    await member.getByRole('tab', { name: '技能', exact: true }).click()
    await member.getByText('技能选择在新会话生效，无需重启实例。', { exact: true }).waitFor()
    await member.getByText('已安装（平台预装）', { exact: true }).waitFor()
    if (evidence) {
      await member.screenshot({ path: join(evidence, 'skill-market-desktop-zh.png'), fullPage: true, animations: 'disabled' })
      await member.setViewportSize({ width: 390, height: 844 })
      await member.screenshot({ path: join(evidence, 'skill-market-mobile-zh.png'), fullPage: true, animations: 'disabled' })
    }
    await member.getByRole('tab', { name: '插件', exact: true }).click()
    await member.getByText('暂无已发布的插件', { exact: true }).waitFor()
  } finally {
    await browser.close()
    await app.stop()
    await new CommunityRuntimeDriver(runtime).rebuild()
    const artifacts = new FileSkillArtifacts(join(root, 'skills/artifacts'), [])
    await new FileSkillDistribution(join(root, 'skills/members'), artifacts).synchronize([])
    await artifacts.collect([])
    await removeCommunityFixture(root)
  }
})
