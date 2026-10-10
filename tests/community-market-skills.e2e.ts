import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { createCommunityApplication } from '../src/composition/community-application.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { FileSkillArtifacts } from '../src/adapters/skill-artifacts.js'
import { FileSkillDistribution } from '../src/adapters/skill-distribution.js'
import type { CommunityRuntimePort } from '../src/ports/community-runtime.js'
import { skillZip, validSkill } from './fixtures/skills/archive.js'

it('publishes reviewed skills and presents install, selected, overridden and managed states in bilingual market tabs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'market-skills-ui-'))
  const native = createServer((_req, res) => { res.writeHead(303, { 'set-cookie': 'native=fixture' }); res.end() })
  await new Promise<void>(resolve => native.listen(0, '127.0.0.1', resolve))
  const address = native.address(); if (!address || typeof address === 'string') throw Error('missing address')
  const instance = (userId: string) => ({ userId, origin: `http://127.0.0.1:${address.port}`, launchUrl: `http://127.0.0.1:${address.port}`, processId: 1 })
  const runtime: CommunityRuntimePort = { ensure: async username => instance(username), restart: async username => instance(username), recover: async username => instance(username), reclaim: async () => 'not-running', terminate: async () => {}, status: username => ({ state: 'ready', instance: instance(username) }), stopAll: async () => {}, reconcileStartupContainers: async () => ({ adopted: [], swept: [] }) }
  const app = createCommunityApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'market-skills-fixture-session-secret', runtime: { command: '/unavailable', args: [], dataRoot: root, defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'https://example.test' } } } }, { runtime, pluginManager: { list: async () => [] } })
  const browser = await chromium.launch({ headless: true })
  try {
    const origin = await app.start(), admin = await browser.newPage({ locale: 'en' }); admin.setDefaultTimeout(10000)
    expect((await admin.request.get(origin + '/market/api/skills')).status()).toBe(401)
    await admin.goto(`${origin}/bootstrap#credential=${readBootstrapCredential(root)!.credential}`)
    await admin.getByLabel('Username', { exact: true }).fill('admin'); await admin.getByLabel('Password', { exact: true }).fill('password')
    await admin.getByRole('button', { name: 'Create administrator' }).click(); await admin.waitForURL(origin + '/admin')
    const post = (path: string, data: object) => admin.request.post(origin + '/admin/api/' + path, { headers: { origin }, data })
    expect((await post('accounts', { username: 'member', password: 'password', email: '' })).status()).toBe(201)
    const preview = await (await admin.request.post(origin + '/admin/api/skills/upload', { headers: { origin, 'content-type': 'application/zip' }, data: skillZip([{ path: 'SKILL.md', content: validSkill }]) })).json()
    expect((await post('skills/change', { action: 'confirm', token: preview.token, revision: preview.revision })).status()).toBe(200)
    await admin.getByRole('link', { name: 'Skill library', exact: true }).click()
    await admin.getByRole('button', { name: 'View skill example-skill', exact: true }).click()
    await admin.getByRole('tab', { name: 'Publication', exact: true }).click()
    await admin.getByRole('button', { name: 'Publish to marketplace', exact: true }).click()
    await admin.getByText('0 members selected this skill.', { exact: true }).waitFor()
    const evidence = process.env.DSH_PHALANX_E2E_EVIDENCE_DIR
    if (evidence) await admin.screenshot({ path: join(evidence, 'skill-publication.png'), fullPage: true, animations: 'disabled' })
    await admin.getByRole('button', { name: 'Confirm', exact: true }).click()
    await admin.getByRole('button', { name: 'Unpublish', exact: true }).waitFor()
    const member = await browser.newPage({ locale: 'en' }); member.setDefaultTimeout(10000)
    await member.request.post(origin + '/login', { headers: { origin }, form: { username: 'member', password: 'password' }, maxRedirects: 0 })
    expect((await member.request.post(origin + '/admin/api/skills/change', { headers: { origin }, data: { action: 'remove', name: 'example-skill', revision: '' } })).status()).toBe(403)
    await member.goto(origin + '/market?locale=en')
    await member.getByRole('tab', { name: 'Skills', exact: true }).click()
    await member.getByText('Not installed', { exact: true }).waitFor()
    await member.getByRole('button', { name: 'View skill example-skill', exact: true }).click()
    await member.getByRole('region', { name: 'SKILL.md', exact: true }).waitFor()
    await member.getByRole('button', { name: 'Close skill details', exact: true }).click()
    await member.getByRole('button', { name: 'Install', exact: true }).click()
    await member.getByText('Installed (self-selected skill)', { exact: true }).waitFor()
    const owned = join(root, 'users/member/home/.agents/skills/example-skill'); await mkdir(owned, { recursive: true }); await writeFile(join(owned, 'SKILL.md'), validSkill)
    await member.getByRole('button', { name: 'Reload skills', exact: true }).click()
    await member.getByText('Overridden by your own skill with the same name', { exact: true }).waitFor()
    await member.getByRole('button', { name: 'Uninstall', exact: true }).click()
    await member.getByRole('button', { name: 'Install', exact: true }).waitFor()
    await member.getByRole('button', { name: 'Install', exact: true }).click()
    await member.getByRole('button', { name: 'Uninstall', exact: true }).waitFor()
    await rm(owned, { recursive: true })
    const groups = await (await admin.request.get(origin + '/admin/api/groups')).json(), group = groups.find((row: { isDefault: boolean }) => row.isDefault)
    const endpoint = `groups/${group.id}/skills`, current = await (await admin.request.get(origin + '/admin/api/' + endpoint)).json()
    expect((await post(endpoint, { action: 'save', names: ['example-skill'], revision: current.revision, confirmed: true })).status()).toBe(200)
    await member.getByRole('button', { name: 'Reload skills', exact: true }).click()
    await member.getByText('Installed (platform preinstalled)', { exact: true }).waitFor()
    expect(await member.getByRole('button', { name: 'Installed', exact: true }).isDisabled()).toBe(true)
    expect((await member.request.post(origin + '/market/api/skills', { headers: { origin }, data: { action: 'uninstall', name: 'example-skill' } })).status()).toBe(409)
    // Refresh the admin detail before confirming the now-current member impact.
    await admin.getByRole('button', { name: 'Close skill details', exact: true }).click()
    await admin.getByRole('button', { name: 'View skill example-skill', exact: true }).click()
    await admin.getByRole('tab', { name: 'Publication', exact: true }).click()
    await admin.getByRole('button', { name: 'Unpublish', exact: true }).click()
    await admin.getByText('1 members selected this skill.', { exact: true }).waitFor()
    await admin.getByRole('button', { name: 'Confirm', exact: true }).click()
    await admin.getByRole('button', { name: 'Publish to marketplace', exact: true }).waitFor()
    await member.goto(origin + '/market?locale=zh-CN'); await member.getByRole('tab', { name: '技能', exact: true }).click()
    await member.getByText('技能选择在新会话生效，无需重启实例。', { exact: true }).waitFor()
    await member.getByText('已安装（平台预装）', { exact: true }).waitFor()
    if (evidence) {
      await member.screenshot({ path: join(evidence, 'skill-market-desktop-zh.png'), fullPage: true, animations: 'disabled' })
      await member.setViewportSize({ width: 390, height: 844 })
      await member.screenshot({ path: join(evidence, 'skill-market-mobile-zh.png'), fullPage: true, animations: 'disabled' })
    }
    await member.getByRole('tab', { name: '插件', exact: true }).click(); await member.getByText('暂无已发布的插件', { exact: true }).waitFor()
  } finally {
    await browser.close(); await app.stop(); await new Promise<void>(resolve => native.close(() => resolve()))
    const artifacts = new FileSkillArtifacts(join(root, 'skills/artifacts'), [])
    await new FileSkillDistribution(join(root, 'skills/members'), artifacts).synchronize([]); await artifacts.collect([])
    await rm(root, { recursive: true, force: true })
  }
})
