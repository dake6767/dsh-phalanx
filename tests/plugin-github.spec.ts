import { randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { cleanupPluginHttpFixture, pluginHttpFixture, stopPluginHttpApplication } from './support/plugin-http.js'
import { prepareAndConfirmNpmPlugin } from './support/plugin-intake.js'

afterEach(cleanupPluginHttpFixture)

type Fixture = Awaited<ReturnType<typeof pluginHttpFixture>>
const commit = 'dcd348e0bec148af45bc0b1a8f33ef82c44aeeef'
const sentinel = join(tmpdir(), `plugin-github-script-${randomUUID()}`)
/** A built plugin whose package name differs from its repository and whose pack scripts would leave a marker. */
const built = (manifest: Record<string, unknown> = {}, files: Record<string, string> = {}) => ({
  'package.json': JSON.stringify({
    name: '@fixture/github-skin',
    version: '0.1.15-settings.4',
    type: 'module',
    main: './src/index.js',
    exports: { '.': './src/index.js', './client': './lib/client.js', './package.json': './package.json' },
    files: ['src', 'lib', 'cordis.patch.yml'],
    scripts: Object.fromEntries(['prepare', 'prepack', 'postpack'].map(name => [name, `node -e "require('fs').writeFileSync('${sentinel}-${name}','')"`])),
    dsh: { bundle: { patch: './cordis.patch.yml' } },
    devDependencies: { esbuild: '^0.25.0' },
    ...manifest,
  }),
  'src/index.js': 'export const name = "github-skin"',
  'lib/client.js': 'export {}',
  'cordis.patch.yml': '[]',
  'README.md': 'Readme that npm always packs',
  'docs/notes.md': 'Repository file outside the declared files list',
  ...files,
})
const preview = async (fixture: Fixture, input: string, stage: 'ready' | 'failed') => {
  const response = await fixture.request('plugins/previews', { input })
  expect(response.status, await response.clone().text()).toBe(202)
  const { token } = (await response.json()) as { token: string }
  await expect.poll(async () => (await fixture.get('plugins/previews?token=' + token)).stage, { timeout: 20_000 }).toBe(stage)
  return { token, ...(await fixture.get('plugins/previews?token=' + token)) } as Record<string, unknown> & { token: string }
}
const plugins = async (fixture: Fixture) => (await fixture.get('plugins')) as Record<string, unknown>[]

it('pins the default branch, packs the repository without scripts, and adds it as a GitHub source with the packed bytes', async () => {
  const fixture = await pluginHttpFixture()
  fixture.github.setRepository('kingOfSoySauce/dsh-liang-skin', { commit, files: built() })
  for (const input of ['github:kingOfSoySauce/dsh-liang-skin', 'https://github.com/kingOfSoySauce/dsh-liang-skin']) {
    const ready = await preview(fixture, input, 'ready')
    expect(ready).toMatchObject({
      source: 'github',
      repository: 'kingOfSoySauce/dsh-liang-skin',
      sourceCommit: commit,
      packageName: '@fixture/github-skin',
      version: '0.1.15-settings.4',
    })
    expect(ready.integrity).toMatch(/^sha512-/u)
    if (input.startsWith('https:')) {
      const confirmed = await fixture.request('plugins/previews/confirm', { token: ready.token })
      expect(confirmed.status, await confirmed.clone().text()).toBe(200)
      expect(await confirmed.json()).toMatchObject({ source: 'github', repository: 'kingOfSoySauce/dsh-liang-skin', sourceCommit: commit })
    } else expect((await fixture.request('plugins/previews/cancel', { token: ready.token })).status).toBe(200)
  }
  // The preparer receives the packed archive as an upload; the registry is never asked.
  const prepared = fixture.preparations.at(-1)!
  expect(prepared).toMatchObject({
    packageName: '@fixture/github-skin',
    version: '0.1.15-settings.4',
    upload: { integrity: expect.stringMatching(/^sha512-/u) },
  })
  expect(fixture.requests).toEqual([])
  expect(fixture.github.requests.filter(url => url.startsWith('/gh-api/'))).toHaveLength(2)
  expect(fixture.github.requests.filter(url => url.startsWith('/gh-assets/'))).toEqual([
    `/gh-assets/https://github.com/kingOfSoySauce/dsh-liang-skin/archive/${commit}.tar.gz`,
    `/gh-assets/https://github.com/kingOfSoySauce/dsh-liang-skin/archive/${commit}.tar.gz`,
  ])
  for (const name of ['prepare', 'prepack', 'postpack']) await expect(import('node:fs/promises').then(fs => fs.stat(`${sentinel}-${name}`))).rejects.toThrow()
  expect(await plugins(fixture)).toMatchObject([
    {
      packageName: '@fixture/github-skin',
      source: 'github',
      repository: 'kingOfSoySauce/dsh-liang-skin',
      sourceCommit: commit,
      currentVersion: '0.1.15-settings.4',
    },
  ])
  // The cancelled precheck released its archive; only the adopted one is retained.
  expect(await readdir(join(fixture.dataRoot, 'plugins/uploads/archives'))).toHaveLength(1)
})

it('explains a repository that needs a build or declares non-registry dependencies', async () => {
  const fixture = await pluginHttpFixture()
  const files = built()
  fixture.github.setRepository('example/unbuilt', {
    commit,
    files: Object.fromEntries(Object.entries(files).filter(([path]) => path !== 'lib/client.js')),
  })
  expect(await preview(fixture, 'github:example/unbuilt', 'failed')).toMatchObject({ failureCode: 'plugin-build-required', sourceCommit: commit })
  for (const [repository, dependencies] of [
    ['example/git-dependency', { helper: 'github:example/helper' }],
    ['example/url-dependency', { helper: 'https://example.test/helper.tgz' }],
    ['example/path-dependency', { helper: 'file:../helper' }],
  ] as const) {
    fixture.github.setRepository(repository, { commit, files: built({ dependencies }) })
    expect(await preview(fixture, 'github:' + repository, 'failed')).toMatchObject({ failureCode: 'plugin-dependency-invalid' })
  }
  fixture.github.setRepository('example/alias-dependency', { commit, files: built({ dependencies: { helper: 'npm:@scope/helper@1.0.0', plain: '^1.0.0' } }) })
  expect(await preview(fixture, 'github:example/alias-dependency', 'ready')).toMatchObject({ packageName: '@fixture/github-skin' })
  expect(fixture.preparations).toHaveLength(1)
  expect(await plugins(fixture)).toEqual([])
})

it('reports an unreachable or missing GitHub source and keeps the pinned commit for a retry', async () => {
  const fixture = await pluginHttpFixture()
  fixture.github.setApiStatus(503)
  expect(await preview(fixture, 'github:example/offline', 'failed')).toMatchObject({ failureCode: 'plugin-github-unavailable' })
  fixture.github.setApiStatus(undefined)
  expect(await preview(fixture, 'github:example/missing', 'failed')).toMatchObject({ failureCode: 'plugin-github-repository-missing' })
  fixture.github.setRepository('example/flaky', { commit, files: built() })
  // After the commit resolved, a missing archive is a proxy failure, not a missing repository.
  fixture.github.setRepository('example/proxy-gap', { commit, files: built() })
  fixture.github.setArchiveStatus(404)
  expect(await preview(fixture, 'github:example/proxy-gap', 'failed')).toMatchObject({ failureCode: 'plugin-github-unavailable', sourceCommit: commit })
  fixture.github.setArchiveStatus(502)
  const failed = await preview(fixture, 'github:example/flaky', 'failed')
  expect(failed).toMatchObject({ failureCode: 'plugin-github-unavailable', sourceCommit: commit })
  fixture.github.setArchiveStatus(undefined)
  // A new default-branch commit does not move a retried precheck.
  fixture.github.setRepository('example/flaky', { commit, head: 'a'.repeat(40), files: built() })
  const before = fixture.github.requests.filter(url => url.startsWith('/gh-api/')).length
  expect((await fixture.request('plugins/previews/retry', { token: failed.token })).status).toBe(202)
  await expect.poll(async () => (await fixture.get('plugins/previews?token=' + failed.token)).stage, { timeout: 20_000 }).toBe('ready')
  expect(await fixture.get('plugins/previews?token=' + failed.token)).toMatchObject({ sourceCommit: commit, packageName: '@fixture/github-skin' })
  expect(fixture.github.requests.filter(url => url.startsWith('/gh-api/'))).toHaveLength(before)
  expect(fixture.github.requests.at(-1)).toContain(`/archive/${commit}.tar.gz`)
})

it('accepts only repository-level GitHub forms and explains each rejected form', async () => {
  const fixture = await pluginHttpFixture()
  for (const [input, code] of [
    ['github:owner/repo#main', 'plugin-github-ref-unsupported'],
    ['github:owner/repo@v1.0.0', 'plugin-github-ref-unsupported'],
    ['https://github.com/owner/repo/tree/main', 'plugin-github-ref-unsupported'],
    ['https://github.com/owner/repo/commit/' + commit, 'plugin-github-ref-unsupported'],
    ['https://github.com/owner/repo#readme', 'plugin-github-ref-unsupported'],
    ['https://github.com/owner/repo.git', 'plugin-git-url-unsupported'],
    ['git+https://github.com/owner/repo.git', 'plugin-git-url-unsupported'],
    ['git@github.com:owner/repo.git', 'plugin-git-url-unsupported'],
    ['https://gitlab.example.test/owner/repo', 'plugin-source-host-unsupported'],
    ['https://raw.githubusercontent.com/owner/repo/main/package.json', 'plugin-source-host-unsupported'],
    ['github:owner', 'plugin-input-invalid'],
    ['github:-owner/repo', 'plugin-input-invalid'],
    ['https://github.com/owner', 'plugin-input-invalid'],
  ]) {
    const response = await fixture.request('plugins/previews', { input })
    expect(response.status, input).toBe(400)
    expect(await response.json(), input).toMatchObject({ code })
  }
  expect(fixture.github.requests).toEqual([])
})

it('records one source per package name across npm and GitHub', async () => {
  const fixture = await pluginHttpFixture()
  fixture.github.setRepository('example/shared', { commit, files: built({ name: 'shared-name', version: '1.0.0' }) })
  await prepareAndConfirmNpmPlugin(async (path, body) => fixture.request(path, body), 'shared-name')
  expect(await preview(fixture, 'github:example/shared', 'failed')).toMatchObject({ failureCode: 'plugin-source-conflict' })
  expect(fixture.preparations).toHaveLength(1)

  fixture.github.setRepository('example/github-first', { commit, files: built({ name: 'github-first', version: '1.0.0' }) })
  await fixture.request('plugins/previews/confirm', { token: (await preview(fixture, 'github:example/github-first', 'ready')).token })
  expect(await plugins(fixture)).toMatchObject([
    { packageName: 'github-first', source: 'github' },
    { packageName: 'shared-name', source: 'npm' },
  ])
  expect(await (await fixture.request('plugins/previews', { input: 'github-first' })).json()).toMatchObject({ code: 'plugin-source-conflict' })
  fixture.setUploadedPackage('github-first')
  expect(await (await fixture.upload()).json()).toMatchObject({ code: 'plugin-source-conflict' })
  expect(await (await fixture.request('plugins/change', { action: 'prepare', packageName: 'github-first', version: '1.0.0' })).json()).toMatchObject({
    code: 'plugin-source-conflict',
  })
  // The update action keeps the recorded GitHub source; at its current commit it reports up-to-date.
  expect(await (await fixture.request('plugins/change', { action: 'update', packageName: 'github-first' })).json()).toMatchObject({ code: 'plugin-up-to-date' })
  // Another repository spelling of the same name conflicts as well, but the same repository in other case is the same source.
  fixture.github.setRepository('example/github-first-fork', { commit, files: built({ name: 'github-first', version: '1.0.0' }) })
  expect(await preview(fixture, 'github:example/github-first-fork', 'failed')).toMatchObject({ failureCode: 'plugin-source-conflict' })
  expect(await preview(fixture, 'github:Example/GitHub-First', 'failed')).toMatchObject({ failureCode: 'plugin-name-in-use' })
})

it('releases a packed archive when its precheck fails, expires or stops, and keeps it while confirmation adopts it', async () => {
  let now = 1_000_000
  const fixture = await pluginHttpFixture({
    clock: { now: () => now },
    beforePrepare: async input => {
      if (input.packageName === '@fixture/failing') throw new (await import('../src/domain/plugin-library.js')).PluginPreparationError('plugin-precheck-failed')
    },
  })
  const archives = () => readdir(join(fixture.dataRoot, 'plugins/uploads/archives')).catch(() => [])
  fixture.github.setRepository('example/failing', { commit, files: built({ name: '@fixture/failing' }) })
  const failed = await preview(fixture, 'github:example/failing', 'failed')
  expect(await archives()).toHaveLength(1)
  expect((await fixture.request('plugins/previews/cancel', { token: failed.token })).status).toBe(200)
  expect(await archives()).toHaveLength(0)

  fixture.github.setRepository('example/expiring', { commit, files: built({ name: '@fixture/expiring' }) })
  const expiring = await preview(fixture, 'github:example/expiring', 'ready')
  now += 31 * 60 * 1000
  expect((await fixture.request('plugins/previews?token=' + expiring.token)).status).toBe(404)
  await expect.poll(archives).toHaveLength(0)

  fixture.github.setRepository('example/stopping', { commit, files: built({ name: '@fixture/stopping' }) })
  await preview(fixture, 'github:example/stopping', 'ready')
  expect(await archives()).toHaveLength(1)
  await stopPluginHttpApplication()
  expect(await archives()).toHaveLength(0)
})
