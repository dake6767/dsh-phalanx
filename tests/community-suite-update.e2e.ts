// Validation: T1; real credentials: none; controlled browser/process fixtures. CI selects its explicit public-entry subset.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { spawnSync } from 'node:child_process'
import { expect, it, vi } from 'vitest'
import { createCommunityApplication } from '../src/composition/community-application.js'
import { legacySuiteCatalogFixture, type SuiteCatalogServerFixture } from './fixtures/suite-catalog-server.js'
import { FileExecutionArtifacts } from '../src/adapters/execution-artifacts.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { gitFixture } from './fixtures/skills/git-repository.js'
import { validSkill } from './fixtures/skills/archive.js'
import type { SuiteCatalogEntry } from '../src/domain/suite-catalog.js'
import type { CommunityRuntimeDependencyView } from '../src/domain/admin-contract.js'

it('offers an update after a platform upgrade, previews the differences and switches without losing grants or credentials', async () => {
  const fixture = await gitFixture(), root = await mkdtemp(join(tmpdir(), 'suite-update-'))
  const skill = (name: string, description: string) => validSkill.replace('example-skill', name).replace('A useful skill', description)
  const first = await fixture.commit({ 'skills/chat-send/SKILL.md': skill('chat-send', 'Send chat messages') })
  const second = await fixture.commit({ 'skills/chat-send/SKILL.md': skill('chat-send', 'Send chat messages and files'), 'skills/chat-read/SKILL.md': skill('chat-read', 'Read chat history') })
  const tool = (output: string) => `mkdir bin; printf "#!/bin/sh\\necho ${output}\\n" > bin/chat-cli; chmod +x bin/chat-cli`
  const text = (en: string) => ({ en, 'zh-CN': en })
  const suite = (version: string, commit: string, names: readonly string[], prepare: string, variables: readonly string[]): SuiteCatalogEntry => ({ category: 'suite', id: 'chat', version, title: text('Chat suite'), description: text('Chat'), source: text('fixture'), identity: text('Team token.'), dependencies: [],
    items: [
      { kind: 'runtime-dependency', name: 'chat-tools', prepareCommands: { amd64: prepare, arm64: prepare }, pathDirectories: ['bin'], checkCommand: 'chat-cli', commands: ['chat-cli'] },
      { kind: 'skill', source: { type: 'git', url: fixture.url, commit, path: 'skills' }, names: [...names] },
      { kind: 'execution', skill: 'chat-send', runtimeDependency: 'chat-tools', delegated: [{ command: 'chat-cli', blocked: ['auth'] }], variables: variables.map(name => ({ name, purpose: text(name) })) },
      { kind: 'skill-pack', name: 'chat', description: 'Chat pack', note: 'The platform provides chat-cli.', skills: [...names] },
    ] })
  vi.stubEnv('HTTPS_PROXY', fixture.proxy); vi.stubEnv('GIT_SSL_CAINFO', fixture.caFile)
  // The signed online catalog publishes version 1, then version 2 for the same suite id after a platform upgrade.
  const start = (catalog: SuiteCatalogServerFixture, port = 0) => createCommunityApplication({ downloadSources: catalog.downloadSources, listen: { host: '127.0.0.1', port }, sessionSecret: 'suite-update-fixture-secret-000032', runtime: { command: '/unavailable', args: [], dataRoot: root, defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'https://example.test' } } } }, { suiteCatalog: { address: catalog.address, trustedKeys: catalog.trustedKeys } })
  const firstCatalog = await legacySuiteCatalogFixture([suite('1', first, ['chat-send'], tool('v1'), ['CHAT_TOKEN'])])
  let secondCatalog: SuiteCatalogServerFixture | undefined
  let app = start(firstCatalog)
  const browser = await chromium.launch({ headless: true })
  try {
    let origin = await app.start()
    const page = await browser.newPage({ locale: 'en', viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(30000)
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
    await page.goto(`${origin}/bootstrap#credential=${readBootstrapCredential(root)!.credential}`)
    await page.getByLabel('Username', { exact: true }).fill('admin'); await page.getByLabel('Password', { exact: true }).fill('password')
    await page.getByRole('button', { name: 'Create administrator' }).click(); await page.waitForURL(`${origin}/admin`)
    const install = await page.request.post(origin + '/admin/api/suites', { headers: { origin }, data: { action: 'install', input: { id: 'chat', requestId: 'request-aaaaaaaaaaaa1', publish: true, credentials: { CHAT_TOKEN: 'team-token' } } } })
    expect(install.status()).toBe(202)
    await expect.poll(async () => ((await (await page.request.get(origin + '/admin/api/suites')).json()) as { installations: { status: string }[] }).installations[0]?.status, { timeout: 60000 }).toBe('installed')
    const before = ((await (await page.request.get(origin + '/admin/api/runtime-dependencies')).json()) as CommunityRuntimeDependencyView[]).find(row => row.name === 'chat-tools')!

    // Platform upgrade: the same data, a catalog with version 2. Nothing changes until the administrator updates.
    const port = Number(new URL(origin).port)
    await app.stop()
    secondCatalog = await legacySuiteCatalogFixture([suite('2', second, ['chat-send', 'chat-read'], tool('v2'), ['CHAT_TOKEN', 'CHAT_REGION'])])
    app = start(secondCatalog, port); origin = await app.start()
    await page.goto(origin + '/login'); await page.getByLabel('Username', { exact: true }).fill('admin'); await page.getByLabel('Password', { exact: true }).fill('password')
    await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await page.waitForURL(origin + '/admin')
    expect(((await (await page.request.get(origin + '/admin/api/runtime-dependencies')).json()) as CommunityRuntimeDependencyView[]).find(row => row.name === 'chat-tools')?.current?.id).toBe(before.current?.id)
    await page.getByRole('link', { name: 'Suite catalog', exact: true }).click()
    const card = page.locator('.plugin-library-card').filter({ hasText: 'Chat suite' })
    await card.getByText('Update available', { exact: true }).waitFor()
    await card.getByRole('button', { name: 'Update', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Chat suite' })
    await dialog.getByText('Version 1.0.0 → 2.0.0', { exact: true }).waitFor()
    await dialog.getByText('Skills added: chat-read', { exact: true }).waitFor()
    await dialog.getByText('Skills updated: chat-send', { exact: true }).waitFor()
    await dialog.getByText('Skill pack chat: adds chat-read; removes —', { exact: true }).waitFor()
    await dialog.getByText('New credentials: CHAT_REGION. Delegated execution stays off until they are saved.', { exact: true }).waitFor()
    await dialog.getByRole('button', { name: 'Confirm update', exact: true }).click()
    await card.getByText('Missing credentials', { exact: true }).waitFor({ timeout: 60000 })
    const after = ((await (await page.request.get(origin + '/admin/api/runtime-dependencies')).json()) as CommunityRuntimeDependencyView[]).find(row => row.name === 'chat-tools')!
    expect(after.current?.id).not.toBe(before.current?.id)
    const skills = (await (await page.request.get(origin + '/admin/api/skills')).json()) as { name: string }[]
    expect(skills.map(row => row.name).sort()).toEqual(['chat-read', 'chat-send'])
    const packs = (await (await page.request.get(origin + '/admin/api/skill-packs')).json()) as { packs: { name: string, skills: string[], published: boolean }[] }
    expect(packs.packs.find(row => row.name === 'chat')).toMatchObject({ skills: ['chat-send', 'chat-read'], published: true })
    await page.getByRole('button', { name: /Platform language/ }).click(); await page.getByRole('menuitemradio', { name: '简体中文', exact: true }).click()
    await card.getByText('缺少凭据', { exact: true }).waitFor()
    expect(errors).toEqual([])
  } finally {
    await browser.close(); await app.stop(); await firstCatalog.close(); await secondCatalog?.close(); vi.unstubAllEnvs()
    await new FileExecutionArtifacts(join(root, 'runtime-dependencies', '.trees')).collect([])
    spawnSync('chmod', ['-R', 'u+w', root])
    await rm(root, { recursive: true, force: true }); await fixture.close()
  }
})
