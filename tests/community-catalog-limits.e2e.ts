// Validation: T1; real credentials: none; signed catalog, anonymous HTTPS Git and controlled browser.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Browser } from 'playwright'
import type { CommunityApplication } from '../src/ports/community-application.js'
import type { SuiteCatalogServerFixture } from './fixtures/suite-catalog-server.js'
import { chromium } from 'playwright'
import { expect, it, vi } from 'vitest'
import { createCommunityApplication } from '../src/composition/community-application.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { FileSkillArtifacts } from '../src/adapters/skill-artifacts.js'
import { gitFixture } from './fixtures/skills/git-repository.js'
import { validSkill } from './fixtures/skills/archive.js'
import { legacySuiteCatalogFixture } from './fixtures/suite-catalog-server.js'

it('reports a catalog skill limit failure through its installation record and visible English and Chinese messages', async () => {
  const git = await gitFixture({ host: 'github.com', repository: 'fixture/catalog.git' }), root = await mkdtemp(join(tmpdir(), 'catalog-limit-'))
  let app: CommunityApplication | undefined, catalog: SuiteCatalogServerFixture | undefined, browser: Browser | undefined, primaryFailure: unknown
  const cleanupErrors: unknown[] = []
  try {
    const commit = await git.commit({ 'skill/SKILL.md': validSkill, 'skill/large.txt': 'x'.repeat(64 * 1024 * 1024 + 1 - Buffer.byteLength(validSkill)) })
    const text = { en: 'Large templates', 'zh-CN': '大型模板' }
    catalog = await legacySuiteCatalogFixture([{ category: 'suite', id: 'large', version: '1', title: text, description: text, source: text, identity: text, dependencies: [], items: [{ kind: 'skill', source: { type: 'git', url: git.url, commit, path: 'skill' }, names: ['example-skill'] }] }])
    vi.stubEnv('HTTPS_PROXY', git.proxy); vi.stubEnv('GIT_SSL_CAINFO', git.caFile)
    app = createCommunityApplication({ downloadSources: catalog.downloadSources, listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'catalog-limit-browser-fixture-session-secret', runtime: { command: '/unavailable', args: [], dataRoot: root, defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'https://example.test' } } } }, { suiteCatalog: { address: catalog.address, trustedKeys: catalog.trustedKeys } })
    browser = await chromium.launch({ headless: true })
    const origin = await app.start(), page = await browser.newPage({ locale: 'en' }); page.setDefaultTimeout(30000)
    expect((await page.request.post(origin + '/bootstrap', { headers: { origin }, form: { credential: readBootstrapCredential(root)!.credential, username: 'admin', password: 'password' }, maxRedirects: 0 })).status()).toBe(303)
    await page.goto(origin + '/admin/skills?tab=catalog')
    const card = page.locator('.plugin-library-card').filter({ hasText: 'Large templates' })
    await card.getByRole('button', { name: 'Install', exact: true }).click()
    await page.getByRole('dialog', { name: 'Large templates' }).getByRole('button', { name: 'Install entry', exact: true }).click()
    await expect.poll(async () => (await (await page.request.get(origin + '/admin/api/suites')).json()).installations[0], { timeout: 30000 }).toMatchObject({ status: 'failed', failureCode: 'skill-catalog-limit-exceeded', entries: [] })
    await card.getByText('This catalog entry exceeds the import limits: 16384 files, 128 MiB per repository and 64 MiB per skill.', { exact: true }).waitFor()
    await page.context().addCookies([{ name: 'dsh-phalanx.lang', value: 'zh-CN', url: origin }]); await page.reload()
    await page.getByText('广场条目超出导入上限：最多 16384 个文件、整个仓库 128 MiB、单技能 64 MiB。', { exact: true }).waitFor()
    expect(await (await page.request.get(origin + '/admin/api/skills')).json()).toEqual([])
  } catch (error) { primaryFailure = error } finally {
    for (const clean of [() => browser?.close(), () => app?.stop(), () => catalog?.close(), () => new FileSkillArtifacts(join(root, 'skills/artifacts'), []).collect([]), () => rm(root, { recursive: true, force: true }), () => git.close()]) try { await clean() } catch (error) { cleanupErrors.push(error) }
    vi.unstubAllEnvs()
  }
  if (cleanupErrors.length) throw new AggregateError(primaryFailure ? [primaryFailure, ...cleanupErrors] : cleanupErrors, 'Catalog limit browser cleanup failed')
  if (primaryFailure) throw primaryFailure
}, 90000)
