// Validation: T1; real credentials: none; controlled browser/process fixtures. CI selects its explicit public-entry subset.
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { FileExecutionArtifacts } from '../src/adapters/execution-artifacts.js'
import { FileSkillArtifacts } from '../src/adapters/skill-artifacts.js'
import { FileSkillDistribution } from '../src/adapters/skill-distribution.js'
import { removeCommunityFixture } from './fixtures/owned-cleanup.js'
import { skillZip, validSkill } from './fixtures/skills/archive.js'
import { createCommunityApplication } from './support/community-application.js'
import { selectBuiltinDatabase } from './support/community-bootstrap-browser.js'
it('edits skill dependency references with the existing drawer and prevents referenced dependency deletion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skill-dependency-ui-'))
  const app = createCommunityApplication({
    listen: { host: '127.0.0.1', port: 0 },
    sessionSecret: 'skill-dependency-fixture-secret-32',
    runtime: {
      command: '/unavailable',
      args: [],
      dataRoot: root,
      defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'https://example.test' } },
    },
  })
  const browser = await chromium.launch({ headless: true })
  try {
    const origin = await app.start(),
      page = await browser.newPage({ locale: 'en' })
    page.setDefaultTimeout(10000)
    await page.goto(`${origin}/bootstrap#credential=${readBootstrapCredential(root)!.credential}`)
    await selectBuiltinDatabase(page)
    await page.getByLabel('Username', { exact: true }).fill('admin')
    await page.getByLabel('Password', { exact: true }).fill('password')
    await page.getByRole('button', { name: 'Create administrator' }).click()
    await page.waitForURL(`${origin}/admin`)
    const preview = await (
      await page.request.post(origin + '/admin/api/skills/upload', {
        headers: { origin, 'content-type': 'application/zip' },
        data: skillZip([{ path: 'SKILL.md', content: validSkill }]),
      })
    ).json()
    expect(
      (
        await page.request.post(origin + '/admin/api/skills/change', {
          headers: { origin },
          data: { action: 'confirm', token: preview.token, revision: preview.revision },
        })
      ).status(),
    ).toBe(200)
    expect(
      (
        await page.request.post(origin + '/admin/api/runtime-dependencies', {
          headers: { origin },
          data: {
            action: 'create',
            input: {
              name: 'office',
              prepareCommand: 'mkdir bin; printf "#!/bin/sh\\necho ready\\n" > bin/office; chmod +x bin/office',
              pathDirectories: ['bin'],
            },
          },
        })
      ).status(),
    ).toBe(202)
    await expect.poll(async () => (await (await page.request.get(origin + '/admin/api/runtime-dependencies?name=office')).json()).stage).toBe('ready')
    await page.getByRole('link', { name: 'Skill library', exact: true }).click()
    await page.getByRole('button', { name: 'View skill example-skill', exact: true }).click()
    await page.getByRole('tab', { name: 'Runtime dependencies', exact: true }).click()
    const checkbox = page.getByRole('checkbox', { name: 'office', exact: true })
    await checkbox.waitFor()
    expect(await checkbox.isChecked()).toBe(false)
    await page.getByRole('dialog').getByText('office', { exact: true }).first().click()
    await page.getByRole('button', { name: 'Save changes', exact: true }).click()
    await page.getByText('Runtime dependency references saved.', { exact: true }).waitFor()
    expect((await (await page.request.get(origin + '/admin/api/runtime-dependencies?name=office')).json()).references).toEqual([
      { kind: 'skill', name: 'example-skill' },
    ])
    expect(
      (await page.request.post(origin + '/admin/api/runtime-dependencies', { headers: { origin }, data: { action: 'remove', name: 'office' } })).status(),
    ).toBe(409)
    await page.reload()
    await page.getByRole('button', { name: 'View skill example-skill', exact: true }).click()
    await page.getByRole('tab', { name: 'Runtime dependencies', exact: true }).click()
    await expect.poll(() => checkbox.isChecked()).toBe(true)
    await page.getByRole('dialog').getByText('office', { exact: true }).first().click()
    await page.getByRole('button', { name: 'Close skill details', exact: true }).click()
    await page.getByRole('dialog', { name: 'Unsaved changes', exact: true }).getByRole('button', { name: 'Save changes', exact: true }).click()
    await expect.poll(() => page.getByRole('dialog').count()).toBe(0)
    expect((await (await page.request.get(origin + '/admin/api/runtime-dependencies?name=office')).json()).references).toEqual([])
  } finally {
    await browser.close()
    await app.stop()
    const artifacts = new FileSkillArtifacts(join(root, 'skills/artifacts'), [])
    await new FileSkillDistribution(join(root, 'skills/members'), artifacts).synchronize([])
    await artifacts.collect([])
    await new FileExecutionArtifacts(join(root, 'runtime-dependencies', '.trees')).collect([])
    await removeCommunityFixture(root)
  }
})
