// Validation: T1; real credentials: none; controlled browser/process fixtures. CI selects its explicit public-entry subset.
import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { runtimeSkillNames } from '../src/adapters/runtime-skills.js'
import { FileSkillArtifacts } from '../src/adapters/skill-artifacts.js'
import { FileSkillDistribution } from '../src/adapters/skill-distribution.js'
import { removeCommunityFixture } from './fixtures/owned-cleanup.js'
import { skillZip } from './fixtures/skills/archive.js'
import { createCommunityApplication, openTestAccounts } from './support/community-application.js'
import { withSkillFacts } from './support/skill-facts.js'

it('marks a retained skill conflicting with the upgraded runtime and stops distribution without deleting its content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'skill-conflict-ui-'))
  const accounts = await openTestAccounts(root)
  const account = await accounts.createFirstAdmin({ username: 'admin', password: 'password', email: '' })
  await accounts.close()
  const name = runtimeSkillNames()[0]!,
    artifacts = new FileSkillArtifacts(join(root, 'skills/artifacts'), [])
  async function* content() {
    yield skillZip([{ path: 'SKILL.md', content: `---\nname: ${name}\ndescription: Imported before the runtime bundled this name\n---\nRetained content` }])
  }
  const upload = await artifacts.accept(content(), new AbortController().signal)
  await withSkillFacts(root, library =>
    library.save({
      name,
      description: upload.description,
      hash: upload.hash,
      importedAt: 0,
      published: true,
    }),
  )
  const app = createCommunityApplication({
    listen: { host: '127.0.0.1', port: 0 },
    sessionSecret: 'conflict-runtime-upgrade-fixture-secret',
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
    await page.goto(origin + '/login')
    await page.getByLabel('Username', { exact: true }).fill('admin')
    await page.getByLabel('Password', { exact: true }).fill('password')
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await page.waitForURL(origin + '/admin')
    await page.getByRole('link', { name: 'Skill library', exact: true }).click()
    await page.getByText('Conflicts with a bundled runtime skill. Distribution is paused.', { exact: true }).waitFor()
    const rows = await (await page.request.get(origin + '/admin/api/skills')).json()
    expect(rows[0]).toMatchObject({ name, hash: upload.hash, conflict: true })
    expect(await readdir(join(root, 'skills/members', account.spaceId, 'live'))).toEqual([])
    expect((await artifacts.read(upload.hash)).markdown).toContain('Retained content')
  } finally {
    await browser.close()
    await app.stop()
    await new FileSkillDistribution(join(root, 'skills/members'), artifacts).synchronize([])
    await artifacts.collect([])
    await removeCommunityFixture(root)
  }
})
