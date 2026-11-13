// Validation: T2; real credentials: none; installed platform composition and actual Linux rootless DSH.
import { memberSpacePath } from './support/real-dsh-runtime.js'
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it, vi } from 'vitest'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import { FileExecutionArtifacts } from '../src/adapters/execution-artifacts.js'
import { FileSkillArtifacts } from '../src/adapters/skill-artifacts.js'
import { FileSkillDistribution } from '../src/adapters/skill-distribution.js'
import { withSuiteCatalogContentHash } from '../src/domain/suite-catalog-document.js'
import { validationDownloadSelection } from './support/validation-downloads.js'
import type { CommunityApplication } from '../src/ports/community-application.js'
import { removeCommunityFixture } from './fixtures/owned-cleanup.js'
import { gitFixture } from './fixtures/skills/git-repository.js'
import type { SuiteCatalogServerFixture } from './fixtures/suite-catalog-server.js'
import { rawSuiteCatalogFixture, signedBytes, throwawaySigningKey } from './fixtures/suite-catalog-server.js'
import { openTestAccounts, withTestDatabase, type createCommunityApplication } from './support/community-application.js'
import { openCommunityHttpEntry } from './support/community-http-entry.js'
import { communityEntryUrl } from './support/community-space.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { assertPinnedDshRevision, runtimeSection } from './support/real-dsh-runtime.js'

it('imports a catalog skill near the file and size limits, distributes it and discovers and reads it in a real member session', async () => {
  assertPinnedDshRevision(runtimeSettings)
  expect(process.platform).toBe('linux')
  expect(runtimeSettings.containerImage).toBeTruthy()
  const installed = process.env.DSH_PHALANX_INSTALL_ROOT
  if (!installed) throw new Error('An installed platform is required')
  const build = JSON.parse(await readFile(join(installed, 'build-info.json'), 'utf8'))
  expect(build.commit).toBe(process.env.DSH_PHALANX_CANDIDATE_SHA)
  expect(build.platform).toBe('linux/' + (process.arch === 'arm64' ? 'arm64' : 'amd64'))
  // The signed test catalog needs its own trust key; use the installed public composition entry with fixture bindings.
  const compiled = (await import(pathToFileURL(join(installed, 'dist/composition/community-application.js')).href)) as {
    createCommunityApplication: typeof createCommunityApplication
  }
  const git = await gitFixture({ host: 'github.com', repository: 'fixture/catalog.git' }),
    root = await mkdtemp(join(tmpdir(), 'catalog-large-'))
  const overlay = join(root, 'observer.json')
  const runtime = { ...runtimeSection(root, 'https://example.test', runtimeSettings), patches: [overlay] },
    inventory = process.env.DSH_PHALANX_E2E_HOST_PUBLIC_ADDRESSES
  // This large repository must not spawn auto maintenance while its owner removes the fixture.
  git.git(['config', 'gc.auto', '0'])
  git.git(['config', 'maintenance.auto', 'false'])
  const accounts = await openTestAccounts(root)
  let app: CommunityApplication | undefined, catalog: SuiteCatalogServerFixture | undefined, primaryFailure: unknown
  const cleanupErrors: unknown[] = []
  try {
    const markdown = '---\nname: catalog-large\ndescription: CATALOG_LARGE_RESOURCES\n---\nRead templates in this skill.\n'
    const resourceCount = 16380,
      resourceBytes = 4096
    const script =
      '#!/bin/sh\ncase "$1:$2:$TEAM_KEY" in --backend:first:fictional-first|--backend:second:fictional-second) echo BACKEND_READY;; --backend:first:fictional-rotated) echo BACKEND_ROTATED;; *) exit 19;; esac\n'
    const files: Record<string, string> = { 'skill/SKILL.md': markdown, 'skill/scripts/catalog-check.sh': script }
    for (let i = 0; i < resourceCount; i++) files[`skill/templates/r${String(i).padStart(5, '0')}.txt`] = `RESOURCE_${i}\n`.padEnd(resourceBytes, 'x')
    const expectedFiles = resourceCount + 2
    const expectedBytes = resourceCount * resourceBytes + Buffer.byteLength(markdown) + Buffer.byteLength(script)
    const commit = await git.commit(files),
      text = { en: 'Large templates', 'zh-CN': '大型模板' }
    const key = throwawaySigningKey()
    const archiveSha = '981eb83f9c887dbb478ee64f8868727d9a83c9e1a89bd2d5d61eea17e0ea0ccb'
    const definition = withSuiteCatalogContentHash({
      kind: 'suite',
      id: 'large',
      version: '1.0.0',
      engines: { platform: '>=0.1.35' },
      adapters: [],
      title: text,
      description: text,
      source: text,
      identity: text,
      dependencies: [],
      items: [
        { kind: 'skill', source: { type: 'git', url: git.url, commit, path: 'skill' }, names: ['catalog-large'] },
        {
          kind: 'skill-pack',
          name: 'large-pack',
          description: 'Catalog description',
          skills: ['catalog-large'],
          note: 'Read the catalog templates before drafting.',
        },
        {
          kind: 'runtime-dependency',
          name: 'catalog-tools',
          type: 'resource',
          paths: [],
          commands: [],
          downloads: [
            {
              source: 'github-assets',
              url: 'https://codeload.github.com/dake6767/dsh-phalanx-catalog/tar.gz/90d0a97acf88eb3c33b6e06e9f89df4a95aadf7d',
              sha256: { amd64: archiveSha, arm64: archiveSha },
              target: 'fixture.tgz',
              timeout: { connectSeconds: 15, totalSeconds: 60 },
            },
          ],
        },
        {
          kind: 'execution',
          skill: 'catalog-large',
          runtimeDependency: 'catalog-tools',
          delegated: [{ command: 'catalog-check', source: 'scripts/catalog-check.sh', blocked: [] }],
          variables: [
            { name: 'TEAM_KEY', purpose: text },
            { name: 'ENDPOINT', optional: true, purpose: text },
          ],
          serviceSlots: [
            {
              id: 'image',
              label: text,
              commands: ['catalog-check'],
              backends: ['first', 'second'].map(id => ({
                id,
                label: text,
                selector: { kind: 'option', name: '--backend', value: id },
                fields: [
                  { name: 'TEAM_KEY', type: 'secret', required: true },
                  { name: 'ENDPOINT', type: 'url', required: false },
                ],
              })),
            },
          ],
        },
      ],
    })
    catalog = await rawSuiteCatalogFixture(await signedBytes([definition], key), [key])
    // The skill Git proxy answers only github.com. The isolated preparer fetches the pinned codeload bytes directly.
    const noProxy = [process.env.no_proxy ?? process.env.NO_PROXY ?? '', 'codeload.github.com'].filter(Boolean).join(',')
    vi.stubEnv('NO_PROXY', noProxy)
    vi.stubEnv('no_proxy', noProxy)
    vi.stubEnv('HTTPS_PROXY', git.proxy)
    vi.stubEnv('GIT_SSL_CAINFO', git.caFile)
    await writeFile(overlay, JSON.stringify([{ insert: [{ id: 'skills-observer', name: '/dsh-phalanx/home/skills-observer.mjs' }] }]))
    const downloads = validationDownloadSelection()
    app = compiled.createCommunityApplication(
      withTestDatabase({
        downloadSources: { ...downloads, overrides: { ...downloads.overrides, githubAssets: '' } },
        listen: { host: '127.0.0.1', port: 0 },
        runtime,
        ...(inventory === undefined ? {} : { network: { hostPublicAddresses: inventory.split(',').filter(Boolean) } }),
      }),
      { suiteCatalog: { address: catalog.address, trustedKeys: catalog.trustedKeys } },
    )
    await accounts.createFirstAdmin({ username: 'admin', password: 'password', email: '' })
    await accounts.create({ username: 'member', password: 'password', email: '' })
    const origin = await app.start()
    const home = join(await memberSpacePath(root, 'member'), 'home')
    await mkdir(home, { recursive: true, mode: 0o700 })
    await copyFile('tests/fixtures/skill-observer.mjs', join(home, 'skills-observer.mjs'))
    const login = async (username: string) => {
      const response = await fetch(origin + '/login', {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ username, password: 'password' }),
      })
      expect(response.status, await response.clone().text()).toBe(303)
      return response.headers
        .getSetCookie()
        .map(value => value.split(';')[0])
        .join('; ')
    }
    const admin = await login('admin')
    const api = async (path: string, body?: object) => {
      const response = await fetch(origin + '/admin/api/' + path, {
        method: body ? 'POST' : 'GET',
        headers: { cookie: admin, origin, 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
      expect(response.ok, await response.clone().text()).toBe(true)
      return response.json()
    }
    await api('suites')
    await api('suites', { action: 'install', input: { id: 'large', requestId: 'request-catalog-large-001', publish: false } })
    const installation = async () => (await api('suites')).installations.find((row: { id: string }) => row.id === 'large')
    await expect.poll(async () => (await installation())?.status, { timeout: 180000 }).toMatch(/^(installed|failed)$/u)
    const installedSuite = await installation()
    expect(installedSuite?.status, JSON.stringify({ code: installedSuite?.failureCode, log: installedSuite?.log })).toBe('installed')
    await catalog.close()
    catalog = undefined
    const adminSkills = `groups/${(await accounts.get('admin'))!.groupId}/skills`
    await api(adminSkills, { action: 'save', names: ['catalog-large'], revision: (await api(adminSkills)).revision, confirmed: true })
    const servicePath = 'skills/execution/services?name=catalog-large'
    const fresh = await api(servicePath)
    expect(fresh.identity).toMatchObject({ id: 'large', version: '1.0.0' })
    const denied = await fetch(origin + '/admin/api/' + servicePath, { headers: { cookie: await login('member') } })
    expect(denied.status).toBe(403)
    let state = fresh
    const change = async (backend: string, input: object) => {
      state = await api(servicePath, { revision: state.revision, change: { slot: 'image', backend, ...input } })
      expect(JSON.stringify(state)).not.toContain('fictional-')
    }
    await change('first', { action: 'save', values: { ENDPOINT: 'https://example.test/images' } })
    expect(state.slots[0].backends[0]).toMatchObject({ enabled: false, complete: false })
    const stale = await fetch(origin + '/admin/api/' + servicePath, {
      method: 'POST',
      headers: { cookie: admin, origin, 'content-type': 'application/json' },
      body: JSON.stringify({ revision: fresh.revision, change: { slot: 'image', backend: 'first', action: 'disable' } }),
    })
    expect(stale.status).toBe(409)
    await change('first', { action: 'save', values: { TEAM_KEY: 'fictional-first' } })
    await change('second', { action: 'save', values: { TEAM_KEY: 'fictional-second' } })
    await change('first', { action: 'enable' })
    await change('second', { action: 'enable' })
    const trial = (backend: string) => api('execution/trial', { owner: 'skill:catalog-large', line: 'catalog-check --backend ' + backend })
    expect(await trial('first')).toMatchObject({ exitCode: 0, stdout: 'BACKEND_READY\n' })
    expect(await trial('second')).toMatchObject({ exitCode: 0, stdout: 'BACKEND_READY\n' })
    await change('first', { action: 'save', values: { TEAM_KEY: 'fictional-rotated' } })
    expect(await trial('first')).toMatchObject({ exitCode: 0, stdout: 'BACKEND_ROTATED\n' })
    await change('first', { action: 'disable' })
    await change('first', { action: 'save', values: { TEAM_KEY: '' } })
    expect(state.slots[0].backends[0]).toMatchObject({ enabled: false, complete: true })
    expect((await trial('first')).exitCode).not.toBe(0)
    await change('first', { action: 'clear', field: 'TEAM_KEY', confirmed: true })
    expect(state.slots[0].backends[0]).toMatchObject({ enabled: false, complete: false })
    expect(await trial('second')).toMatchObject({ exitCode: 0, stdout: 'BACKEND_READY\n' })
    const pack = await api('skill-packs/detail?name=large-pack')
    expect(
      await api('skill-packs', { action: 'save-display', name: 'large-pack', revision: pack.revision, display: { displayName: 'Local title' } }),
    ).toMatchObject({ name: 'large-pack', displayName: 'Local title', description: 'Catalog description', skills: ['catalog-large'] })
    const detail = await api('skills/detail?name=catalog-large')
    expect(detail.files).toHaveLength(expectedFiles)
    expect(detail.source.commit).toBe(commit)
    const endpoint = `groups/${(await accounts.get('member'))!.groupId}/skills`,
      group = await api(endpoint),
      start = performance.now()
    await api(endpoint, { action: 'save', names: ['catalog-large'], revision: group.revision, confirmed: true })
    const distributionMs = performance.now() - start
    const cookie = (await openCommunityHttpEntry(origin, await login('member'), 300000)).cookie
    const observe = async (body: object) => {
      const response = await fetch(communityEntryUrl(origin, cookie) + 'skills-fixture', {
        method: 'POST',
        headers: { cookie, origin, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      expect(response.status, await response.clone().text()).toBe(200)
      return response.json()
    }
    const { sessionId } = await observe({ operation: 'create' }),
      skill = await observe({ operation: 'get', sessionId, name: 'catalog-large' })
    expect(skill?.description).toBe('CATALOG_LARGE_RESOURCES')
    const command = `python3 - <<'PY'\nfrom pathlib import Path\np=Path(${JSON.stringify(skill.resourceBase.path)})\nfiles=[f for f in p.rglob('*') if f.is_file()]\nassert len(files)==${expectedFiles}, len(files)\nassert sum(f.stat().st_size for f in files)==${expectedBytes}\nassert (p/'templates/r00000.txt').read_text().startswith('RESOURCE_0\\n')\nassert (p/'templates/r16379.txt').read_text().startswith('RESOURCE_16379\\n')\nprint('CATALOG_RESOURCES_READ')\nPY`
    const result = (await observe({ operation: 'tool', sessionId, name: 'bash', args: { description: 'Verify catalog resources', command, timeoutMs: 10000 } }))
      .value
    expect(result, result?.stderr?.text).toMatchObject({ exitCode: 0, stdout: { text: 'CATALOG_RESOURCES_READ\n' } })
    const evidence = process.env.DSH_PHALANX_E2E_EVIDENCE_DIR
    if (!evidence) throw new Error('An evidence directory is required')
    await mkdir(evidence, { recursive: true })
    await writeFile(
      join(evidence, 'catalog-distribution.json'),
      JSON.stringify({
        files: expectedFiles,
        bytes: expectedBytes,
        distributionMs,
        discovered: true,
        firstAndLastRead: true,
        installedCommit: build.commit,
      }) + '\n',
    )
  } catch (error) {
    primaryFailure = error
  } finally {
    const artifacts = new FileSkillArtifacts(join(root, 'skills/artifacts'), [])
    for (const clean of [
      () => app?.stop(),
      () => new CommunityRuntimeDriver(runtime).rebuild(),
      () => new FileSkillDistribution(join(root, 'skills/members'), artifacts).synchronize([]),
      () => artifacts.collect([]),
      () => new FileExecutionArtifacts(join(root, 'runtime-dependencies', '.trees')).collect([]),
      () => accounts.close(),
      () => catalog?.close(),
      () => git.close(),
      () => removeCommunityFixture(root),
    ])
      try {
        await clean()
      } catch (error) {
        cleanupErrors.push(error)
      }
    vi.unstubAllEnvs()
  }
  if (cleanupErrors.length) throw new AggregateError(primaryFailure ? [primaryFailure, ...cleanupErrors] : cleanupErrors, 'Catalog size fixture cleanup failed')
  if (primaryFailure) throw primaryFailure
}, 600000)
