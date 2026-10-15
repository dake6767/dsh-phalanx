// Validation: T1; real credentials: none; controlled browser/process fixtures. CI selects its explicit public-entry subset.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { createCommunityApplication } from '../src/composition/community-application.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { FileSkillArtifacts } from '../src/adapters/skill-artifacts.js'
import { FileSkillDistribution } from '../src/adapters/skill-distribution.js'
import { FileExecutionArtifacts } from '../src/adapters/execution-artifacts.js'
import { FileSkillLibraryStore } from '../src/adapters/skill-library-store.js'
import { FileExecutionConfigurations } from '../src/adapters/execution-configuration-store.js'
import { skillZip, validSkill } from './fixtures/skills/archive.js'
it('edits skill dependency references with the existing drawer and prevents referenced dependency deletion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skill-dependency-ui-'))
  const app = createCommunityApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'skill-dependency-fixture-secret-32', runtime: { command: '/unavailable', args: [], dataRoot: root, defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'https://example.test' } } } })
  const browser = await chromium.launch({ headless: true })
  try {
    const origin = await app.start(), page = await browser.newPage({ locale: 'en' }); page.setDefaultTimeout(10000)
    await page.goto(`${origin}/bootstrap#credential=${readBootstrapCredential(root)!.credential}`)
    await page.getByLabel('Username', { exact: true }).fill('admin'); await page.getByLabel('Password', { exact: true }).fill('password')
    await page.getByRole('button', { name: 'Create administrator' }).click(); await page.waitForURL(`${origin}/admin`)
    const preview = await (await page.request.post(origin + '/admin/api/skills/upload', { headers: { origin, 'content-type': 'application/zip' }, data: skillZip([{ path: 'SKILL.md', content: validSkill }]) })).json()
    expect((await page.request.post(origin + '/admin/api/skills/change', { headers: { origin }, data: { action: 'confirm', token: preview.token, revision: preview.revision } })).status()).toBe(200)
    expect((await page.request.post(origin + '/admin/api/runtime-dependencies', { headers: { origin }, data: { action: 'create', input: { name: 'office', prepareCommand: 'mkdir bin; printf "#!/bin/sh\\necho ready\\n" > bin/office; chmod +x bin/office', pathDirectories: ['bin'] } } })).status()).toBe(202)
    await expect.poll(async () => (await (await page.request.get(origin + '/admin/api/runtime-dependencies?name=office')).json()).stage).toBe('ready')
    await page.getByRole('link', { name: 'Skill library', exact: true }).click(); await page.getByRole('button', { name: 'View skill example-skill', exact: true }).click()
    await page.getByRole('tab', { name: 'Runtime dependencies', exact: true }).click()
    const checkbox = page.getByRole('checkbox', { name: 'office', exact: true }); await checkbox.waitFor(); expect(await checkbox.isChecked()).toBe(false)
    await page.getByRole('dialog').getByText('office', { exact: true }).first().click(); await page.getByRole('button', { name: 'Save changes', exact: true }).click()
    await page.getByText('Runtime dependency references saved.', { exact: true }).waitFor()
    expect((await (await page.request.get(origin + '/admin/api/runtime-dependencies?name=office')).json()).references).toEqual([{ kind: 'skill', name: 'example-skill' }])
    expect((await page.request.post(origin + '/admin/api/runtime-dependencies', { headers: { origin }, data: { action: 'remove', name: 'office' } })).status()).toBe(409)
    await page.reload(); await page.getByRole('button', { name: 'View skill example-skill', exact: true }).click(); await page.getByRole('tab', { name: 'Runtime dependencies', exact: true }).click()
    await expect.poll(() => checkbox.isChecked()).toBe(true)
    await page.getByRole('dialog').getByText('office', { exact: true }).first().click(); await page.getByRole('button', { name: 'Close skill details', exact: true }).click()
    await page.getByRole('dialog', { name: 'Unsaved changes', exact: true }).getByRole('button', { name: 'Save changes', exact: true }).click()
    await expect.poll(() => page.getByRole('dialog').count()).toBe(0)
    expect((await (await page.request.get(origin + '/admin/api/runtime-dependencies?name=office')).json()).references).toEqual([])
  } finally { await browser.close(); await app.stop(); const artifacts = new FileSkillArtifacts(join(root, 'skills/artifacts'), []); await new FileSkillDistribution(join(root, 'skills/members'), artifacts).synchronize([]); await artifacts.collect([]); await new FileExecutionArtifacts(join(root, 'runtime-dependencies', '.trees')).collect([]); await rm(root, { recursive: true, force: true }) }
})

it('refreshes the execution form after approving a legacy preparation migration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skill-approval-migration-ui-'))
  const artifacts = new FileSkillArtifacts(join(root, 'skills/artifacts'), [])
  const skill = await artifacts.accept((async function* () { yield skillZip([{ path: 'SKILL.md', content: validSkill }]) })(), new AbortController().signal)
  new FileSkillLibraryStore(join(root, 'skills/library.json')).save({ name: skill.name, description: skill.description, hash: skill.hash, importedAt: 0, published: false })
  new FileExecutionConfigurations(join(root, 'execution/configuration.json')).save('skill:' + skill.name, { enabled: true, awaitingPreparation: true, commands: [{ command: 'echo', blocked: [] }], variables: [], prepare: 'mkdir bin; printf "#!/bin/sh\\necho approved\\n" > bin/approval-helper; chmod +x bin/approval-helper' })
  const app = createCommunityApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'skill-approval-fixture-secret-32', runtime: { command: '/unavailable', args: [], dataRoot: root, defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'https://example.test' } } } })
  const browser = await chromium.launch({ headless: true })
  try {
    const origin = await app.start(), page = await browser.newPage({ locale: 'en' })
    await page.goto(`${origin}/bootstrap#credential=${readBootstrapCredential(root)!.credential}`)
    await page.getByLabel('Username', { exact: true }).fill('admin'); await page.getByLabel('Password', { exact: true }).fill('password')
    await page.getByRole('button', { name: 'Create administrator' }).click(); await page.waitForURL(`${origin}/admin`)
    await page.getByRole('link', { name: 'Skill library', exact: true }).click(); await page.getByRole('button', { name: 'View skill example-skill', exact: true }).click()
    await page.getByRole('tab', { name: 'Platform execution', exact: true }).click()
    await page.getByRole('button', { name: 'Approve execution', exact: true }).click()
    const execution = async () => (await (await page.request.get(origin + '/admin/api/skills/execution?name=example-skill')).json())
    await expect.poll(async () => (await execution()).preparation?.stage, { timeout: 15000 }).toBe('ready')
    const dependencies = (await execution()).runtimeDependencies
    expect(dependencies).toHaveLength(1)
    await expect.poll(() => page.getByRole('button', { name: 'Approve execution', exact: true }).count()).toBe(0)
    expect(await page.getByRole('button', { name: 'Save execution settings', exact: true }).isEnabled()).toBe(false)
    await page.getByLabel('Command line', { exact: true }).fill('echo approved')
    await expect.poll(() => page.getByRole('button', { name: 'Run command', exact: true }).isEnabled(), { timeout: 10000 }).toBe(true)
    expect(await page.getByRole('checkbox', { name: dependencies[0], exact: true }).isChecked()).toBe(true)
    await expect.poll(() => page.getByText('approval-helper', { exact: true }).count(), { timeout: 10000 }).toBe(1)
    expect(await page.getByText('No usable dependency version', { exact: true }).count()).toBe(0)
    await page.getByRole('button', { name: 'Close skill details', exact: true }).click()
    expect(await page.getByRole('dialog', { name: 'Unsaved changes', exact: true }).count()).toBe(0)
    expect((await execution()).runtimeDependencies).toEqual(dependencies)
  } finally {
    await browser.close(); await app.stop(); await new FileSkillDistribution(join(root, 'skills/members'), artifacts).synchronize([]); await artifacts.collect([])
    await new FileExecutionArtifacts(join(root, 'runtime-dependencies', '.trees')).collect([]); await rm(root, { recursive: true, force: true })
  }
})
