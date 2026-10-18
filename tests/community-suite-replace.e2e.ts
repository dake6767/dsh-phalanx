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
import type { CommunityRuntimeDependencyView, CommunitySkillImportPreview } from '../src/domain/admin-contract.js'

it('replaces confirmed manual entries in place, reuses a manual shared tool and switches it to the catalog version', async () => {
  const fixture = await gitFixture(), root = await mkdtemp(join(tmpdir(), 'suite-replace-'))
  const commit = await fixture.commit({ 'skills/chat-send/SKILL.md': validSkill.replace('example-skill', 'chat-send').replace('A useful skill', 'Send chat messages') })
  const tool = (name: string, output: string) => `mkdir bin; printf "#!/bin/sh\\necho ${output}\\n" > bin/${name}; chmod +x bin/${name}`
  const text = (en: string) => ({ en, 'zh-CN': en })
  const presets: readonly SuiteCatalogEntry[] = [
    { category: 'dependency', id: 'shared-tool', version: '1', title: text('Shared tool'), description: text('Shared'), source: text('fixture'),
      items: [{ kind: 'runtime-dependency', name: 'shared-tool', prepareCommands: { amd64: tool('shared-tool', 'catalog'), arm64: tool('shared-tool', 'catalog') }, pathDirectories: ['bin'], checkCommand: 'shared-tool', commands: ['shared-tool'] }] },
    { category: 'suite', id: 'chat', version: '1', title: text('Chat suite'), description: text('Chat'), source: text('fixture'), identity: text('No credentials.'), dependencies: ['shared-tool'],
      items: [
        { kind: 'runtime-dependency', name: 'chat-tools', prepareCommands: { amd64: tool('chat-cli', 'catalog'), arm64: tool('chat-cli', 'catalog') }, pathDirectories: ['bin'], checkCommand: 'chat-cli', commands: ['chat-cli'] },
        { kind: 'skill', source: { type: 'git', url: fixture.url, commit, path: 'skills' }, names: ['chat-send'], runtimeDependency: 'chat-tools', catalogDependencies: ['shared-tool'] },
        { kind: 'skill-pack', name: 'chat', description: 'Chat pack', note: 'The platform provides the tools.', skills: ['chat-send'] },
      ] }]
  vi.stubEnv('HTTPS_PROXY', fixture.proxy); vi.stubEnv('GIT_SSL_CAINFO', fixture.caFile)
  const catalogFixture = await legacySuiteCatalogFixture(presets)
  const app = createCommunityApplication({ downloadSources: catalogFixture.downloadSources, listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'suite-replace-fixture-secret-00032', runtime: { command: '/unavailable', args: [], dataRoot: root, defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'https://example.test' } } } }, { suiteCatalog: { address: catalogFixture.address, trustedKeys: catalogFixture.trustedKeys } })
  const browser = await chromium.launch({ headless: true })
  try {
    const origin = await app.start(), page = await browser.newPage({ locale: 'en', viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(30000)
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
    await page.goto(`${origin}/bootstrap#credential=${readBootstrapCredential(root)!.credential}`)
    await page.getByLabel('Username', { exact: true }).fill('admin'); await page.getByLabel('Password', { exact: true }).fill('password')
    await page.getByRole('button', { name: 'Create administrator' }).click(); await page.waitForURL(`${origin}/admin`)
    const post = async (path: string, data: unknown) => { const response = await page.request.post(origin + path, { headers: { origin }, data }); expect(response.ok(), await response.text()).toBe(true); return response.json() }
    const dependencies = async () => (await (await page.request.get(origin + '/admin/api/runtime-dependencies')).json()) as CommunityRuntimeDependencyView[]
    // The 0.1.15 manual setup: the suite CLI and the shared tool as manual dependencies, and the skill imported from the same repository.
    for (const [name, command] of [['my-chat', 'chat-cli'], ['my-shared', 'shared-tool']] as const)
      await post('/admin/api/runtime-dependencies', { action: 'create', input: { name, prepareCommand: tool(command, 'manual'), pathDirectories: ['bin'], checkCommand: command } })
    await expect.poll(async () => (await dependencies()).map(row => row.stage), { timeout: 60000 }).toEqual(['ready', 'ready'])
    const preview = await post('/admin/api/skills/import/git', { source: fixture.url }) as CommunitySkillImportPreview
    await post('/admin/api/skills/import/confirm', { token: preview.token, names: ['chat-send'], replacements: [], packs: [] })

    await page.getByRole('link', { name: 'Suite catalog', exact: true }).click()
    const card = (name: string) => page.locator('.plugin-library-card').filter({ hasText: name })
    await card('Chat suite').getByRole('button', { name: 'Install', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Chat suite' })
    await dialog.getByText('Shared tool · Your manual dependency my-shared is used; its version is not pinned', { exact: true }).waitFor()
    await dialog.getByText('These manual entries will be replaced by the catalog version:', { exact: true }).waitFor()
    await dialog.getByText('Runtime dependencies · my-chat', { exact: true }).waitFor(); await dialog.getByText('Skills · chat-send', { exact: true }).waitFor()
    // Installing stays unavailable until the administrator confirms the takeover.
    expect(await dialog.getByRole('button', { name: 'Install entry', exact: true }).isDisabled()).toBe(true)
    await dialog.getByText('Replace these manual entries', { exact: true }).click()
    await dialog.getByRole('button', { name: 'Install entry', exact: true }).click()
    await card('Chat suite').getByText('Installed', { exact: true }).first().waitFor({ timeout: 60000 })
    const replaced = await dependencies()
    expect(replaced.find(row => row.name === 'my-chat')).toMatchObject({ source: 'suite-catalog', references: [{ kind: 'skill', name: 'chat-send' }] })
    expect(replaced.find(row => row.name === 'my-shared')).toMatchObject({ source: 'manual' })
    const skills = (await (await page.request.get(origin + '/admin/api/skills')).json()) as { name: string, suiteOrigin?: string, runtimeDependencies?: string[] }[]
    expect(skills.find(row => row.name === 'chat-send')).toMatchObject({ runtimeDependencies: ['my-chat', 'my-shared'] })

    // The shared tool is satisfied by the manual dependency until the administrator switches it from the dependency details.
    await card('Shared tool').getByText('Your manual dependency my-shared is used; its version is not pinned', { exact: true }).waitFor()
    await page.getByRole('link', { name: 'Runtime dependencies', exact: true }).click()
    await page.getByRole('button', { name: 'View dependency my-shared', exact: true }).click()
    const details = page.getByRole('dialog', { name: 'my-shared', exact: true })
    await details.getByText('Used by Chat suite instead of the catalog version', { exact: true }).waitFor()
    await details.getByRole('button', { name: 'Switch to the catalog version', exact: true }).click()
    await page.waitForURL(`${origin}/admin/suites`)
    const shared = page.getByRole('dialog', { name: 'Shared tool' })
    await shared.getByText('Runtime dependencies · my-shared', { exact: true }).waitFor()
    await shared.getByText('Replace these manual entries', { exact: true }).click()
    await shared.getByRole('button', { name: 'Install entry', exact: true }).click()
    await card('Shared tool').getByText('Installed', { exact: true }).first().waitFor({ timeout: 60000 })
    await expect.poll(async () => (await dependencies()).find(row => row.name === 'my-shared')?.source, { timeout: 60000 }).toBe('suite-catalog')
    expect((await dependencies()).find(row => row.name === 'my-shared')?.references).toEqual([{ kind: 'skill', name: 'chat-send' }])
    await page.getByRole('button', { name: 'View suite entry Chat suite', exact: true }).click()
    await page.getByRole('heading', { name: 'Replaced manual entries', exact: true }).waitFor()
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: /Platform language/ }).click(); await page.getByRole('menuitemradio', { name: '简体中文', exact: true }).click()
    await page.getByRole('button', { name: '查看套件条目 Chat suite', exact: true }).click()
    await page.getByRole('heading', { name: '已替代的手动条目', exact: true }).waitFor()
    expect(errors).toEqual([])
  } finally {
    await browser.close(); await app.stop(); await catalogFixture.close(); vi.unstubAllEnvs()
    await new FileExecutionArtifacts(join(root, 'runtime-dependencies', '.trees')).collect([])
    spawnSync('chmod', ['-R', 'u+w', root])
    await rm(root, { recursive: true, force: true }); await fixture.close()
  }
})
