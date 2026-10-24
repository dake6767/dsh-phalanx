// Validation: T2; real credentials: none; installed platform composition and actual Linux rootless DSH.
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it, vi } from 'vitest'
import type { CommunityApplication } from '../src/ports/community-application.js'
import type { SuiteCatalogServerFixture } from './fixtures/suite-catalog-server.js'
import type { createCommunityApplication } from '../src/composition/community-application.js'
import { CommunityAccountStore } from '../src/adapters/community-account-store.js'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import { FileSkillArtifacts } from '../src/adapters/skill-artifacts.js'
import { FileSkillDistribution } from '../src/adapters/skill-distribution.js'
import { openCommunityHttpEntry } from './support/community-http-entry.js'
import { communityEntryUrl } from './support/community-space.js'
import { runtimeSection, assertPinnedDshRevision } from './support/real-dsh-runtime.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { gitFixture } from './fixtures/skills/git-repository.js'
import { legacySuiteCatalogFixture } from './fixtures/suite-catalog-server.js'

it('imports a catalog skill near the file and size limits, distributes it and discovers and reads it in a real member session', async () => {
  assertPinnedDshRevision(runtimeSettings)
  expect(process.platform).toBe('linux'); expect(runtimeSettings.containerImage).toBeTruthy()
  const installed = process.env.DSH_PHALANX_INSTALL_ROOT
  if (!installed) throw new Error('An installed platform is required')
  const build = JSON.parse(await readFile(join(installed, 'build-info.json'), 'utf8'))
  expect(build.commit).toBe(process.env.DSH_PHALANX_CANDIDATE_SHA)
  expect(build.platform).toBe('linux/' + (process.arch === 'arm64' ? 'arm64' : 'amd64'))
  // The signed test catalog needs its own trust key; use the installed public composition entry with fixture bindings.
  const compiled = await import(pathToFileURL(join(installed, 'dist/composition/community-application.js')).href) as { createCommunityApplication: typeof createCommunityApplication }
  const git = await gitFixture({ host: 'github.com', repository: 'fixture/catalog.git' }), root = await mkdtemp(join(tmpdir(), 'catalog-large-'))
  const overlay = join(root, 'observer.json')
  const runtime = { ...runtimeSection(root, 'https://example.test', runtimeSettings), patches: [overlay] }, inventory = process.env.DSH_PHALANX_E2E_HOST_PUBLIC_ADDRESSES
  const accounts = new CommunityAccountStore(join(root, 'community-accounts.db'))
  let app: CommunityApplication | undefined, catalog: SuiteCatalogServerFixture | undefined, primaryFailure: unknown
  const cleanupErrors: unknown[] = []
  try {
    const markdown = '---\nname: catalog-large\ndescription: CATALOG_LARGE_RESOURCES\n---\nRead templates in this skill.\n'
    const resourceCount = 16380, resourceBytes = 4096
    const files: Record<string, string> = { 'skill/SKILL.md': markdown }
    for (let i = 0; i < resourceCount; i++) files[`skill/templates/r${String(i).padStart(5, '0')}.txt`] = (`RESOURCE_${i}\n`).padEnd(resourceBytes, 'x')
    const commit = await git.commit(files), text = { en: 'Large templates', 'zh-CN': '大型模板' }
    catalog = await legacySuiteCatalogFixture([{ category: 'suite', id: 'large', version: '1', title: text, description: text, source: text, identity: text, dependencies: [], items: [{ kind: 'skill', source: { type: 'git', url: git.url, commit, path: 'skill' }, names: ['catalog-large'] }] }])
    vi.stubEnv('HTTPS_PROXY', git.proxy); vi.stubEnv('GIT_SSL_CAINFO', git.caFile)
    await writeFile(overlay, JSON.stringify([{ id: 'tools', config: { mode: 'native' } }, { insert: [{ id: 'skills-observer', name: '/dsh-phalanx/home/skills-observer.mjs' }] }]))
    app = compiled.createCommunityApplication({ downloadSources: catalog.downloadSources, listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'catalog-large-container-fixture-session-secret', runtime, ...(inventory === undefined ? {} : { network: { hostPublicAddresses: inventory.split(',').filter(Boolean) } }) }, { suiteCatalog: { address: catalog.address, trustedKeys: catalog.trustedKeys } })
    await accounts.createFirstAdmin({ username: 'admin', password: 'password', email: '' }); await accounts.create({ username: 'member', password: 'password', email: '' })
    const home = join(root, 'users/member/home'); await mkdir(home, { recursive: true, mode: 0o700 }); await copyFile('tests/fixtures/skill-observer.mjs', join(home, 'skills-observer.mjs'))
    const origin = await app.start()
    const login = async (username: string) => { const response = await fetch(origin + '/login', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username, password: 'password' }) }); expect(response.status, await response.clone().text()).toBe(303); return response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') }
    const admin = await login('admin')
    const api = async (path: string, body?: object) => { const response = await fetch(origin + '/admin/api/' + path, { method: body ? 'POST' : 'GET', headers: { cookie: admin, origin, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); expect(response.ok, await response.clone().text()).toBe(true); return response.json() }
    await api('suites'); await api('suites', { action: 'install', input: { id: 'large', requestId: 'request-catalog-large-001', publish: false } })
    await expect.poll(async () => (await api('suites')).installations[0], { timeout: 180000 }).toMatchObject({ status: 'installed' })
    const detail = await api('skills/detail?name=catalog-large')
    expect(detail.files).toHaveLength(resourceCount + 1)
    expect(detail.source.commit).toBe(commit)
    const endpoint = `groups/${accounts.get('member')!.groupId}/skills`, group = await api(endpoint), start = performance.now()
    await api(endpoint, { action: 'save', names: ['catalog-large'], revision: group.revision, confirmed: true })
    const distributionMs = performance.now() - start
    const cookie = (await openCommunityHttpEntry(origin, await login('member'), 300000)).cookie
    const observe = async (body: object) => { const response = await fetch(communityEntryUrl(origin, cookie) + 'skills-fixture', { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify(body) }); expect(response.status, await response.clone().text()).toBe(200); return response.json() }
    const { sessionId } = await observe({ operation: 'create' }), skill = await observe({ operation: 'get', sessionId, name: 'catalog-large' })
    expect(skill?.description).toBe('CATALOG_LARGE_RESOURCES')
    const command = `python3 - <<'PY'\nfrom pathlib import Path\np=Path(${JSON.stringify(skill.resourceBase.path)})\nfiles=[f for f in p.rglob('*') if f.is_file()]\nassert len(files)==${resourceCount + 1}, len(files)\nassert sum(f.stat().st_size for f in files)==${resourceCount * resourceBytes + Buffer.byteLength(markdown)}\nassert (p/'templates/r00000.txt').read_text().startswith('RESOURCE_0\\n')\nassert (p/'templates/r16379.txt').read_text().startswith('RESOURCE_16379\\n')\nprint('CATALOG_RESOURCES_READ')\nPY`
    const result = (await observe({ operation: 'tool', sessionId, name: 'bash', args: { description: 'Verify catalog resources', command, timeoutMs: 10000 } })).value
    expect(result, result?.stderr?.text).toMatchObject({ exitCode: 0, stdout: { text: 'CATALOG_RESOURCES_READ\n' } })
    const evidence = process.env.DSH_PHALANX_E2E_EVIDENCE_DIR
    if (!evidence) throw new Error('An evidence directory is required')
    await mkdir(evidence, { recursive: true }); await writeFile(join(evidence, 'catalog-distribution.json'), JSON.stringify({ files: resourceCount + 1, bytes: resourceCount * resourceBytes + Buffer.byteLength(markdown), distributionMs, discovered: true, firstAndLastRead: true, installedCommit: build.commit }) + '\n')
  } catch (error) { primaryFailure = error } finally {
    const artifacts = new FileSkillArtifacts(join(root, 'skills/artifacts'), [])
    for (const clean of [() => app?.stop(), () => new CommunityRuntimeDriver(runtime).rebuild(), () => new FileSkillDistribution(join(root, 'skills/members'), artifacts).synchronize([]), () => artifacts.collect([]), () => accounts.close(), () => catalog?.close(), () => git.close(), () => rm(root, { recursive: true, force: true })]) try { await clean() } catch (error) { cleanupErrors.push(error) }
    vi.unstubAllEnvs()
  }
  if (cleanupErrors.length) throw new AggregateError(primaryFailure ? [primaryFailure, ...cleanupErrors] : cleanupErrors, 'Catalog size fixture cleanup failed')
  if (primaryFailure) throw primaryFailure
}, 600000)
