import { createServer } from 'node:http'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
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

it('creates ordered packs, grants them, installs them in the market and reviews safe deletion', async () => {
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
    for (const name of ['one', 'two', 'three']) {
      const preview = await (await admin.request.post(origin + '/admin/api/skills/upload', { headers: { origin, 'content-type': 'application/zip' }, data: skillZip([{ path: 'SKILL.md', content: validSkill.replace('example-skill', name) }]) })).json()
      expect((await post('skills/change', { action: 'confirm', token: preview.token, revision: preview.revision })).status()).toBe(200)
    }
    await admin.goto(origin + '/admin/skills?locale=en')
    await admin.getByRole('tab', { name: 'Skill packs', exact: true }).click()
    await admin.getByRole('button', { name: 'Create skill pack', exact: true }).click()
    await admin.getByLabel('Pack name', { exact: true }).fill('research-before')
    await admin.getByLabel('Pack description', { exact: true }).fill('Research workflow')
    const editor = admin.getByRole('dialog')
    for (const name of ['one', 'two', 'three']) await editor.getByText(name, { exact: true }).click()
    await admin.getByRole('button', { name: 'Move three up', exact: true }).click()
    await admin.getByLabel('Orchestration instructions (optional)', { exact: true }).fill('Start with one, then three and two.')
    await editor.getByText('Published to marketplace', { exact: true }).click()
    await admin.getByRole('button', { name: 'Save skill pack', exact: true }).click()
    await admin.getByRole('button', { name: 'View skill pack research-before', exact: true }).click()
    await admin.getByLabel('Pack name', { exact: true }).fill('research')
    await admin.getByRole('button', { name: 'Save skill pack', exact: true }).click()
    await admin.getByRole('button', { name: 'View skill pack research', exact: true }).waitFor()
    const pack = (await (await admin.request.get(origin + '/admin/api/skill-packs')).json()).packs[0]
    expect(pack).toMatchObject({ skills: ['one', 'three', 'two'], published: true })
    const csrf = await admin.request.post(origin + '/admin/api/skill-packs', { headers: { origin: 'https://other.example.test' }, data: { action: 'remove', name: 'research', deleteSkills: false, revision: pack.revision } })
    expect(csrf.status()).toBe(403)
    const evidence = process.env.DSH_PHALANX_E2E_EVIDENCE_DIR
    if (evidence) { await mkdir(evidence, { recursive: true }); await admin.screenshot({ path: join(evidence, 'skill-packs-desktop.png'), fullPage: true, animations: 'disabled' }) }
    await admin.getByRole('link', { name: 'Group management', exact: true }).click()
    await admin.getByRole('row').filter({ hasText: 'Ordinary group' }).getByRole('button', { name: 'Details', exact: true }).click()
    await admin.getByRole('tab', { name: 'Skills', exact: true }).click()
    await admin.getByRole('dialog').getByText('research', { exact: true }).click()
    await admin.getByRole('button', { name: 'Save grants', exact: true }).click()
    await admin.getByRole('button', { name: 'Confirm action', exact: true }).click()
    await expect.poll(() => admin.getByRole('button', { name: 'Save grants', exact: true }).isDisabled()).toBe(true)
    const member = await browser.newPage({ locale: 'en' }); member.setDefaultTimeout(10000)
    await member.request.post(origin + '/login', { headers: { origin }, form: { username: 'member', password: 'password' }, maxRedirects: 0 })
    await member.goto(origin + '/market?locale=en')
    await member.getByRole('tab', { name: 'Skills', exact: true }).click()
    const market = member.getByRole('region', { name: 'Skill packs', exact: true })
    await market.getByText('Installed (platform preinstalled)', { exact: true }).waitFor()
    expect(await market.getByRole('button', { name: 'Installed', exact: true }).isDisabled()).toBe(true)
    const groups = await (await admin.request.get(origin + '/admin/api/groups')).json(), group = groups.find((row: { isDefault: boolean }) => row.isDefault)
    const endpoint = 'groups/' + group.id + '/skills', current = await (await admin.request.get(origin + '/admin/api/' + endpoint)).json()
    expect((await post(endpoint, { action: 'save', names: ['two'], packs: [], revision: current.revision, confirmed: true })).status()).toBe(200)
    await member.getByRole('button', { name: 'Reload skills', exact: true }).click()
    await market.getByRole('button', { name: 'Install', exact: true }).click()
    await market.getByText('Installed (self-selected pack)', { exact: true }).waitFor()
    await market.getByRole('button', { name: 'Uninstall', exact: true }).click()
    await market.getByText('Not installed', { exact: true }).waitFor()
    await market.getByRole('button', { name: 'Install', exact: true }).click()
    await market.getByText('Installed (self-selected pack)', { exact: true }).waitFor()
    expect((await member.request.get(origin + '/admin/api/skill-packs')).status()).toBe(403)
    expect((await (await member.request.get(origin + '/market/api/skills')).json()).skills.find((row: { name: string }) => row.name === 'one')).toMatchObject({ selectable: false })
    await admin.goto(origin + '/admin/skills?locale=en')
    await admin.getByRole('tab', { name: 'Skill packs', exact: true }).click()
    await admin.getByRole('button', { name: 'View skill pack research', exact: true }).click()
    await admin.getByRole('button', { name: 'Remove skill pack', exact: true }).click()
    await admin.getByText('Also delete eligible skills', { exact: true }).click()
    await admin.getByText('two: Directly granted to a group', { exact: true }).waitFor()
    await admin.getByText('1 member selections', { exact: true }).waitFor()
    if (evidence) await admin.screenshot({ path: join(evidence, 'skill-pack-removal.png'), fullPage: true, animations: 'disabled' })
    await admin.getByRole('button', { name: 'Confirm removal', exact: true }).click()
    await admin.getByText('No skill packs yet', { exact: true }).waitFor()
    expect((await (await admin.request.get(origin + '/admin/api/skills')).json()).map((row: { name: string }) => row.name)).toEqual(['two'])
    await admin.getByRole('button', { name: /Platform language/ }).click(); await admin.getByRole('option', { name: '简体中文', exact: true }).click()
    await admin.getByRole('button', { name: '创建技能包', exact: true }).click()
    await admin.getByLabel('技能包名称', { exact: true }).waitFor()
    await admin.setViewportSize({ width: 390, height: 844 })
    expect(await admin.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    if (evidence) await admin.screenshot({ path: join(evidence, 'skill-pack-mobile-zh.png'), fullPage: true, animations: 'disabled' })
  } finally {
    await browser.close(); await app.stop(); await new Promise<void>(resolve => native.close(() => resolve()))
    const artifacts = new FileSkillArtifacts(join(root, 'skills/artifacts'), [])
    await new FileSkillDistribution(join(root, 'skills/members'), artifacts).synchronize([]); await artifacts.collect([])
    await rm(root, { recursive: true, force: true })
  }
})
