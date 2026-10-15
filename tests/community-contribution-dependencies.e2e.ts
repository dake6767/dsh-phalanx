// Validation: T1; real credentials: none; controlled browser/process fixtures. CI selects its explicit public-entry subset.
import { chmod, lstat, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { createCommunityApplication } from '../src/composition/community-application.js'
import { CommunityAccountStore } from '../src/adapters/community-account-store.js'
import { FileCommunityModelAccess } from '../src/adapters/community-model-access.js'
import { skillZip, validSkill } from './fixtures/skills/archive.js'

it('matches existing commands and prepares missing dependencies within the contribution adoption drawer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contribution-dependency-admin-'))
  const accounts = new CommunityAccountStore(join(root, 'community-accounts.db'))
  await accounts.createFirstAdmin({ username: 'admin', password: 'password', email: '' })
  await accounts.create({ username: 'member', password: 'password', email: '' })
  const member = accounts.get('member')!, token = new FileCommunityModelAccess(join(root, 'model-access.json')).forUser('member', member.spaceId)
  const app = createCommunityApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'contribution-dependency-admin-secret', runtime: { command: '/unavailable', args: [], dataRoot: root, defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'https://example.test' } } }, modelGateway: { upstreamApiKey: 'fictional-model-key' } })
  const browser = await chromium.launch({ headless: true })
  const prepare = (name: string) => `mkdir bin; printf '#!/bin/sh\necho ready\n' > bin/${name}; chmod +x bin/${name}`
  try {
    const origin = await app.start(), page = await browser.newPage({ locale: 'en', viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' }); page.setDefaultTimeout(15000)
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
    await page.request.post(origin + '/login', { headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, data: 'username=admin&password=password' })
    const post = (path: string, data: unknown) => page.request.post(origin + '/admin/api/' + path, { headers: { origin }, data })
    expect((await post('runtime-dependencies', { action: 'create', input: { name: 'existing-lark', prepareCommand: prepare('lark-cli'), pathDirectories: ['bin'] } })).status()).toBe(202)
    await expect.poll(async () => (await (await page.request.get(origin + '/admin/api/runtime-dependencies?name=existing-lark')).json()).stage).toBe('ready')
    expect((await post('runtime-dependencies', { action: 'update', name: 'existing-lark', input: { name: 'existing-lark', prepareCommand: 'exit 1', pathDirectories: ['bin'] } })).status()).toBe(202)
    await expect.poll(async () => (await (await page.request.get(origin + '/admin/api/runtime-dependencies?name=existing-lark')).json()).stage).toBe('failed')
    const declaration = { purpose: 'Team documents', requiredCommands: [{ name: 'lark-cli', purpose: 'Member must log in themselves', installation: prepare('lark-cli') }, { name: 'officecli', purpose: 'Read documents', installation: prepare('officecli') }], execution: { commands: [], variables: [], prepare: 'OBSOLETE_DO_NOT_PREFILL' } }
    const response = await fetch(origin + '/contributions?action=submit', { method: 'POST', headers: { 'x-api-key': token, 'x-contribution-declaration': Buffer.from(JSON.stringify(declaration)).toString('base64url') }, body: new Uint8Array(skillZip([{ path: 'SKILL.md', content: validSkill + '\n```sh\nlark-cli docs list\nofficecli read report.docx\n```' }])) })
    expect(response.status, await response.clone().text()).toBe(200)
    await page.goto(origin + '/admin/skills?locale=en'); await page.getByRole('tab', { name: 'Member contributions', exact: true }).click()
    await page.getByRole('button', { name: 'Review contribution', exact: true }).click()
    await page.getByRole('button', { name: 'Adopt contribution', exact: true }).click()
    await page.getByRole('heading', { name: 'Required commands', exact: true }).waitFor()
    expect(await page.getByRole('checkbox', { name: 'existing-lark', exact: true }).isChecked()).toBe(true)
    expect(await page.getByRole('button', { name: 'Continue to distribution', exact: true }).isEnabled()).toBe(false)
    expect(await page.getByLabel('Preparation command (optional)', { exact: true }).count()).toBe(0)
    expect(await page.locator('body').innerText()).not.toContain('OBSOLETE_DO_NOT_PREFILL')
    await page.getByRole('button', { name: 'Prepare this command', exact: true }).click()
    expect(await page.getByLabel('Dependency name', { exact: true }).inputValue()).toBe('officecli')
    expect(await page.getByLabel('Prepare command', { exact: true }).inputValue()).toBe(prepare('officecli'))
    await page.getByLabel('PATH directories', { exact: true }).fill('bin')
    await page.getByRole('button', { name: 'Start preparation', exact: true }).click()
    await expect.poll(() => page.getByRole('checkbox', { name: 'officecli', exact: true }).isChecked(), { timeout: 15000 }).toBe(true)
    await expect.poll(() => page.getByRole('button', { name: 'Continue to distribution', exact: true }).isEnabled()).toBe(true)
    const evidence = process.env.DSH_PHALANX_E2E_EVIDENCE_DIR
    if (evidence) await page.screenshot({ path: join(evidence, 'contribution-dependencies-desktop.png'), fullPage: true })
    await page.getByRole('button', { name: 'Continue to distribution', exact: true }).click()
    await page.getByRole('button', { name: 'Confirm adoption', exact: true }).click()
    await page.getByRole('button', { name: 'Finish adoption', exact: true }).waitFor()
    const skills = await (await page.request.get(origin + '/admin/api/skills')).json()
    expect(skills[0].runtimeDependencies).toEqual(['existing-lark', 'officecli'])
    expect(skills[0].published).toBe(false)
    expect(errors).toEqual([])
  } finally {
    await browser.close(); await app.stop(); accounts.close()
    const writable = async (path: string): Promise<void> => { if ((await lstat(path)).isDirectory()) { await chmod(path, 0o700); for (const name of await readdir(path)) await writable(join(path, name)) } }
    await writable(root); await rm(root, { recursive: true, force: true })
  }
})
