import { afterEach, expect, it } from 'vitest'
import { PluginPreparationError } from '../src/domain/plugin-library.js'
import { cleanupPluginHttpFixture, pluginHttpFixture } from './support/plugin-http.js'
import { prepareAndConfirmNpmPlugin } from './support/plugin-intake.js'

afterEach(cleanupPluginHttpFixture)

type Fixture = Awaited<ReturnType<typeof pluginHttpFixture>>
const json = async (response: Response, status: number) => {
  expect(response.status, await response.clone().text()).toBe(status)
  return response.json()
}
async function addNpm(fixture: Fixture, input: string) {
  return prepareAndConfirmNpmPlugin(async (path, body) => fixture.request(path, body), input)
}
const plugin = async (fixture: Fixture, packageName: string) =>
  ((await fixture.get('plugins')) as { packageName: string }[]).find(row => row.packageName === packageName) as Record<string, unknown> | undefined

const commit = 'dcd348e0bec148af45bc0b1a8f33ef82c44aeeef'
const next = 'b4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3'
/** A packed GitHub plugin whose package name and version come from its own manifest. */
const githubFiles = (manifest: Record<string, unknown> = {}, files: Record<string, string> = {}) => ({
  'package.json': JSON.stringify({
    name: '@fixture/github-skin',
    version: '0.1.15-settings.4',
    main: './src/index.js',
    exports: { '.': './src/index.js', './lib/client.js': './lib/client.js' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
    ...manifest,
  }),
  'src/index.js': 'export {}',
  'lib/client.js': 'export {}',
  'cordis.patch.yml': '[]',
  ...files,
})
async function addGithub(fixture: Fixture, repository: string) {
  const created = await fixture.request('plugins/previews', { input: 'github:' + repository })
  expect(created.status, await created.clone().text()).toBe(202)
  const { token } = (await created.json()) as { token: string }
  await expect.poll(async () => (await fixture.get('plugins/previews?token=' + token)).stage, { timeout: 20_000 }).toBe('ready')
  expect((await fixture.request('plugins/previews/confirm', { token })).status).toBe(200)
}

it('checks npm latest only on request and prepares the update from the recorded source before an explicit switch', async () => {
  const fixture = await pluginHttpFixture()
  await addNpm(fixture, '@fixture/reports')
  expect(await plugin(fixture, '@fixture/reports')).toMatchObject({ source: 'npm', currentVersion: '1.0.0' })
  const listed = fixture.requests.length
  await fixture.get('plugins')
  expect(fixture.requests).toHaveLength(listed)

  const check = (packageName: string) => fixture.request('plugins/updates?packageName=' + encodeURIComponent(packageName))
  expect(await json(await check('@fixture/reports'), 200)).toEqual({
    packageName: '@fixture/reports',
    currentVersion: '1.0.0',
    latestVersion: '1.0.0',
    hasUpdate: false,
  })
  fixture.setLatest('2.0.0')
  expect(await json(await check('@fixture/reports'), 200)).toEqual({
    packageName: '@fixture/reports',
    currentVersion: '1.0.0',
    latestVersion: '2.0.0',
    hasUpdate: true,
  })
  expect(fixture.preparations).toHaveLength(1)
  expect(await plugin(fixture, '@fixture/reports')).not.toHaveProperty('replacement')

  const prepared = await json(await fixture.request('plugins/change', { action: 'update', packageName: '@fixture/reports' }), 202)
  expect(prepared).toMatchObject({ currentVersion: '1.0.0', replacement: { version: '2.0.0' } })
  await expect.poll(async () => ((await plugin(fixture, '@fixture/reports'))?.replacement as { stage?: string })?.stage).toBe('available')
  expect(fixture.preparations.at(-1)).toMatchObject({ packageName: '@fixture/reports', version: '2.0.0' })
  fixture.setLatest('3.0.0')
  expect(await plugin(fixture, '@fixture/reports')).toMatchObject({ currentVersion: '1.0.0', replacement: { version: '2.0.0', stage: 'available' } })
  const impact = await fixture.get('plugins/impact?packageName=%40fixture%2Freports')
  const selected = await json(
    await fixture.request('plugins/change', { action: 'select', packageName: '@fixture/reports', revision: impact.revision, confirmed: true }),
    200,
  )
  expect(selected).toMatchObject({ source: 'npm', currentVersion: '2.0.0', version: '2.0.0' })
  expect(fixture.preparations).toHaveLength(2)

  const unchanged = fixture.requests.length
  fixture.setMetadataUnavailable(true)
  expect(await json(await check('@fixture/reports'), 503)).toMatchObject({ code: 'plugin-registry-unavailable' })
  expect(await json(await fixture.request('plugins/change', { action: 'update', packageName: '@fixture/reports' }), 503)).toMatchObject({
    code: 'plugin-registry-unavailable',
  })
  expect(fixture.requests.length).toBeGreaterThan(unchanged)
  expect(await plugin(fixture, '@fixture/reports')).toMatchObject({ currentVersion: '2.0.0', stage: 'available' })
  expect(await plugin(fixture, '@fixture/reports')).not.toHaveProperty('replacement')
  expect(fixture.preparations).toHaveLength(2)
})

it('reports an up-to-date npm update request without preparing and keeps a failed update retryable at its exact version', async () => {
  let fail = false
  const fixture = await pluginHttpFixture({
    beforePrepare: async input => {
      if (fail && input.version === '2.0.0') {
        fail = false
        throw new PluginPreparationError('plugin-precheck-failed')
      }
    },
  })
  await addNpm(fixture, 'retry-plugin')
  expect(await json(await fixture.request('plugins/change', { action: 'update', packageName: 'retry-plugin' }), 409)).toMatchObject({
    code: 'plugin-up-to-date',
  })
  expect(fixture.preparations).toHaveLength(1)
  fail = true
  fixture.setLatest('2.0.0')
  await json(await fixture.request('plugins/change', { action: 'update', packageName: 'retry-plugin' }), 202)
  await expect.poll(async () => ((await plugin(fixture, 'retry-plugin'))?.replacement as { stage?: string })?.stage).toBe('failed')
  expect(await plugin(fixture, 'retry-plugin')).toMatchObject({ currentVersion: '1.0.0', stage: 'available' })
  // The failed candidate keeps its exact version; the explicit prepare action retries it without resolving latest again.
  fixture.setLatest('3.0.0')
  const before = fixture.requests.length
  await json(await fixture.request('plugins/change', { action: 'prepare', packageName: 'retry-plugin', version: '2.0.0' }), 202)
  await expect.poll(async () => ((await plugin(fixture, 'retry-plugin'))?.replacement as { stage?: string })?.stage).toBe('available')
  expect(fixture.requests).toHaveLength(before)
  expect(fixture.preparations.at(-1)).toMatchObject({ packageName: 'retry-plugin', version: '2.0.0' })
})

it('records one immutable source per package name and rejects adding or replacing it from another source', async () => {
  const fixture = await pluginHttpFixture()
  await addNpm(fixture, 'shared-name')
  fixture.setUploadedPackage('shared-name')
  expect(await json(await fixture.upload(), 409)).toMatchObject({ code: 'plugin-source-conflict' })
  expect(await json(await fixture.upload('shared-name'), 409)).toMatchObject({ code: 'plugin-source-conflict' })
  expect(await plugin(fixture, 'shared-name')).toMatchObject({ source: 'npm', currentVersion: '1.0.0' })
  expect(await plugin(fixture, 'shared-name')).not.toHaveProperty('replacement')

  fixture.setUploadedPackage('uploaded-name')
  await json(await fixture.upload(), 202)
  await expect.poll(async () => (await plugin(fixture, 'uploaded-name'))?.stage).toBe('available')
  expect(await plugin(fixture, 'uploaded-name')).toMatchObject({ source: 'upload' })
  const npmAdd = await fixture.request('plugins/previews', { input: 'uploaded-name' })
  expect(await json(npmAdd, 409)).toMatchObject({ code: 'plugin-source-conflict' })
  for (const action of [
    { action: 'prepare', packageName: 'uploaded-name', version: '2.0.0' },
    { action: 'update', packageName: 'uploaded-name' },
  ])
    expect(await json(await fixture.request('plugins/change', action), 409)).toMatchObject({ code: 'plugin-source-conflict' })
  const updates = await fixture.request('plugins/updates?packageName=uploaded-name')
  expect(await json(updates, 409)).toMatchObject({ code: 'plugin-source-conflict' })
  expect(await plugin(fixture, 'uploaded-name')).not.toHaveProperty('replacement')

  // Removing the plugin releases its name for a deliberate addition from the other source.
  const impact = await fixture.get('plugins/impact?packageName=uploaded-name')
  await json(await fixture.request('plugins/change', { action: 'remove', packageName: 'uploaded-name', revision: impact.revision, confirmed: true }), 200)
  await addNpm(fixture, 'uploaded-name')
  expect(await plugin(fixture, 'uploaded-name')).toMatchObject({ source: 'npm' })
})

it('rejects an update whose latest version was known before with different content', async () => {
  const fixture = await pluginHttpFixture()
  const original = fixture.integrity
  await addNpm(fixture, 'history-update@1.0.0')
  fixture.setLatest('2.0.0')
  await json(await fixture.request('plugins/change', { action: 'update', packageName: 'history-update' }), 202)
  await expect.poll(async () => ((await plugin(fixture, 'history-update'))?.replacement as { stage?: string })?.stage).toBe('available')
  const impact = await fixture.get('plugins/impact?packageName=history-update')
  await json(await fixture.request('plugins/change', { action: 'select', packageName: 'history-update', revision: impact.revision, confirmed: true }), 200)
  // The registry moves latest back to 1.0.0 but now serves different bytes for it.
  fixture.setLatest('1.0.0')
  fixture.setIntegrity('sha512-' + Buffer.alloc(64, 9).toString('base64'))
  expect(await json(await fixture.request('plugins/updates?packageName=history-update'), 200)).toMatchObject({ latestVersion: '1.0.0', hasUpdate: true })
  await json(await fixture.request('plugins/change', { action: 'update', packageName: 'history-update' }), 202)
  await expect.poll(async () => ((await plugin(fixture, 'history-update'))?.replacement as { stage?: string })?.stage).toBe('failed')
  expect(await plugin(fixture, 'history-update')).toMatchObject({
    currentVersion: '2.0.0',
    integrity: original,
    replacement: { version: '1.0.0', stage: 'failed', failureCode: 'plugin-version-conflict' },
  })
})

it('rejects a replacement whose exact version already has different content', async () => {
  const fixture = await pluginHttpFixture()
  const original = fixture.integrity
  await addNpm(fixture, 'conflict-update@1.0.0')
  fixture.setIntegrity('sha512-' + Buffer.alloc(64, 9).toString('base64'))
  await json(await fixture.request('plugins/change', { action: 'prepare', packageName: 'conflict-update', version: '1.0.0' }), 202)
  await expect.poll(async () => ((await plugin(fixture, 'conflict-update'))?.replacement as { stage?: string })?.stage).toBe('failed')
  expect(await plugin(fixture, 'conflict-update')).toMatchObject({
    currentVersion: '1.0.0',
    integrity: original,
    replacement: { version: '1.0.0', stage: 'failed', failureCode: 'plugin-version-conflict' },
  })
})

it('checks GitHub commits on request, prompts even when the version number did not change, and updates through the recorded repository', async () => {
  const fixture = await pluginHttpFixture()
  fixture.github.setRepository('example/skin', { commit, files: githubFiles() })
  await addGithub(fixture, 'example/skin')
  expect(await plugin(fixture, '@fixture/github-skin')).toMatchObject({
    source: 'github',
    repository: 'example/skin',
    sourceCommit: commit,
    currentVersion: '0.1.15-settings.4',
  })
  const check = () => fixture.request('plugins/updates?packageName=' + encodeURIComponent('@fixture/github-skin'))
  expect(await json(await check(), 200)).toEqual({
    packageName: '@fixture/github-skin',
    currentVersion: '0.1.15-settings.4',
    latestVersion: null,
    hasUpdate: false,
    currentCommit: commit,
    latestCommit: commit,
  })
  // A new commit prompts even though the checked-out version number is only known after packing.
  fixture.github.setRepository('example/skin', { commit: next, files: githubFiles() })
  expect(await json(await check(), 200)).toEqual({
    packageName: '@fixture/github-skin',
    currentVersion: '0.1.15-settings.4',
    latestVersion: null,
    hasUpdate: true,
    currentCommit: commit,
    latestCommit: next,
  })
  expect(await plugin(fixture, '@fixture/github-skin')).not.toHaveProperty('replacement')

  // The upstream release bumps its version; the update keeps the recorded GitHub source and commit identity.
  fixture.github.setRepository('example/skin', { commit: next, files: githubFiles({ version: '0.1.16-settings.1' }) })
  const prepared = await json(await fixture.request('plugins/change', { action: 'update', packageName: '@fixture/github-skin' }), 202)
  expect(prepared).toMatchObject({ source: 'github', repository: 'example/skin', replacement: { version: '0.1.16-settings.1' } })
  await expect.poll(async () => ((await plugin(fixture, '@fixture/github-skin'))?.replacement as { stage?: string })?.stage).toBe('available')
  const impact = await fixture.get('plugins/impact?packageName=' + encodeURIComponent('@fixture/github-skin'))
  const selected = await json(
    await fixture.request('plugins/change', { action: 'select', packageName: '@fixture/github-skin', revision: impact.revision, confirmed: true }),
    200,
  )
  expect(selected).toMatchObject({
    source: 'github',
    repository: 'example/skin',
    sourceCommit: next,
    version: '0.1.16-settings.1',
    currentVersion: '0.1.16-settings.1',
  })
  expect(await json(await fixture.request('plugins/change', { action: 'update', packageName: '@fixture/github-skin' }), 409)).toMatchObject({
    code: 'plugin-up-to-date',
  })
  // npm registry is never asked for a GitHub source.
  expect(fixture.requests).toEqual([])
})

it('keeps a GitHub plugin unchanged on source errors and stages new checked content at the same version', async () => {
  const fixture = await pluginHttpFixture()
  fixture.github.setRepository('example/stable', { commit, files: githubFiles() })
  await addGithub(fixture, 'example/stable')
  const check = () => fixture.request('plugins/updates?packageName=' + encodeURIComponent('@fixture/github-skin'))
  fixture.github.setApiStatus(503)
  expect(await json(await check(), 503)).toMatchObject({ code: 'plugin-github-unavailable' })
  expect(await json(await fixture.request('plugins/change', { action: 'update', packageName: '@fixture/github-skin' }), 503)).toMatchObject({
    code: 'plugin-github-unavailable',
  })
  expect(await plugin(fixture, '@fixture/github-skin')).toMatchObject({ currentVersion: '0.1.15-settings.4', stage: 'available' })
  expect(await plugin(fixture, '@fixture/github-skin')).not.toHaveProperty('replacement')
  fixture.github.setApiStatus(undefined)

  // The upstream repository now packs under a different package name; the library entry keeps its identity.
  fixture.github.setRepository('example/stable', { commit: next, files: githubFiles({ name: '@fixture/moved-away' }) })
  expect(await json(await fixture.request('plugins/change', { action: 'update', packageName: '@fixture/github-skin' }), 400)).toMatchObject({
    code: 'plugin-package-invalid',
  })
  // Different checked content at the same version stays staged until explicitly selected.
  const previous = await plugin(fixture, '@fixture/github-skin')
  fixture.github.setRepository('example/stable', { commit: next, files: githubFiles({}, { 'src/index.js': 'export const changed = true' }) })
  await json(await fixture.request('plugins/change', { action: 'update', packageName: '@fixture/github-skin' }), 202)
  await expect.poll(async () => ((await plugin(fixture, '@fixture/github-skin'))?.replacement as { stage?: string })?.stage).toBe('available')
  expect(await plugin(fixture, '@fixture/github-skin')).toMatchObject({ integrity: previous?.integrity, sourceCommit: commit })
  const impact = await fixture.get('plugins/impact?packageName=' + encodeURIComponent('@fixture/github-skin'))
  const selected = await json(
    await fixture.request('plugins/change', { action: 'select', packageName: '@fixture/github-skin', revision: impact.revision, confirmed: true }),
    200,
  )
  expect(selected).toMatchObject({ currentVersion: '0.1.15-settings.4', sourceCommit: next })
  expect(selected.integrity).not.toBe(previous?.integrity)
})
