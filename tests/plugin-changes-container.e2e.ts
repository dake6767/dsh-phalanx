import { mkdtemp, mkdir, readFile, writeFile, rm, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { candidateApplication as createCommunityApplication } from './support/candidate-application.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import { execFileText } from '../src/adapters/runtime-command.js'
import { runtimeSection, assertPinnedDshRevision } from './support/real-dsh-runtime.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import type { CommunityGroupView, CommunityPluginView, CommunityPluginImpact } from '../src/domain/admin-contract.js'

it.skipIf(!runtimeSettings.containerImage)('selects a checked private version on restart and restores the self-installed copy after library removal', async () => {
  assertPinnedDshRevision(runtimeSettings)
  const root = await mkdtemp(join(tmpdir(), 'plugin-changes-'))
  const runtime = runtimeSection(join(root, 'platform'), 'https://example.test', runtimeSettings)
  const config = { listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'plugin-changes-container-fixture-secret', runtime }
  let app = createCommunityApplication(config, 180_000)
  let origin = ''; let admin = ''; let member = ''
  const cookies = (response: Response) => response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  const adminRequest = async (path: string, body?: object) => await fetch(origin + '/admin/api/' + path, { method: body ? 'POST' : 'GET', headers: { cookie: admin, origin, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
  const list = async () => (await (await adminRequest('plugins')).json()) as CommunityPluginView[]
  const impact = async () => (await (await adminRequest('plugins/impact?packageName=%40example%2Fversioned')).json()) as CommunityPluginImpact
  const login = async () => {
    const response = await fetch(origin + '/login', { method: 'POST', redirect: 'manual', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: 'member', password: 'password' }) })
    expect(response.status).toBe(303); expect(response.headers.get('location')).not.toBe('/recovery'); member = cookies(response)
  }
  const restart = async () => { expect((await fetch(origin + '/recovery/restart', { method: 'POST', headers: { cookie: member, origin, 'content-type': 'application/json' }, body: JSON.stringify({ confirmed: true }) })).status).toBe(200); await login() }
  const upload = async (version: string, replacement = false, fails = false) => {
    const directory = join(root, version); await mkdir(directory)
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name: '@example/versioned', version, type: 'module', main: './index.js', dsh: { bundle: { patch: './patch.yml' } } }))
    await writeFile(join(directory, 'index.js'), `import {writeFileSync} from 'node:fs'; import {join} from 'node:path'; export const name='versioned'; export function apply(){${fails ? "throw Error('fixture incompatible')" : `writeFileSync(join(process.env.HOME,'PLUGIN_VERSION'),${JSON.stringify(version)})`}}`)
    await writeFile(join(directory, 'patch.yml'), JSON.stringify([{ insert: [{ id: 'versioned', name: '@example/versioned' }] }]))
    const packed = JSON.parse(await execFileText('npm', ['pack', directory, '--ignore-scripts', '--json', '--pack-destination', root])) as Array<{ filename: string }>
    const response = await fetch(origin + '/admin/api/plugins/upload', { method: 'POST', headers: { cookie: admin, origin, 'content-type': 'application/gzip', 'x-plugin-filename': 'versioned.tgz', ...(replacement ? { 'x-plugin-replace-package': '@example/versioned' } : {}) }, body: await readFile(join(root, packed[0]!.filename)) })
    expect(response.status, await response.text()).toBe(202)
    await expect.poll(async () => replacement ? (await list())[0]?.replacement?.stage : (await list())[0]?.stage, { timeout: 180000 }).toBe(fails ? 'failed' : 'available')
  }
  try {
    origin = await app.start()
    const response = await fetch(origin + '/bootstrap', { method: 'POST', redirect: 'manual', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ credential: readBootstrapCredential(runtime.dataRoot)!.credential, username: 'admin', password: 'password' }) })
    admin = cookies(response); expect(response.status).toBe(303)
    const group = ((await (await adminRequest('groups')).json()) as CommunityGroupView[]).find(row => row.isDefault)!
    await adminRequest('accounts', { username: 'member', password: 'password', email: '', groupId: group.id })
    await upload('1.0.0')
    await adminRequest('plugins/publication', { action: 'publish', packageName: '@example/versioned', published: true })
    await login()
    expect((await fetch(origin + '/market/api/plugins', { method: 'POST', headers: { cookie: member, origin, 'content-type': 'application/json' }, body: JSON.stringify({ packageName: '@example/versioned' }) })).status).toBe(200)
    const home = join(runtime.dataRoot, 'users/member/home'); const current = async () => readFile(join(home, 'PLUGIN_VERSION'), 'utf8')
    expect(await current()).toBe('1.0.0')
    const endpoint = `groups/${group.id}/plugins`
    await adminRequest(endpoint, { action: 'save', packages: ['@example/versioned'] }); await restart()
    expect(await readFile(join(home, '.dsh/profiles/web/cordis.patch.yml'), 'utf8')).toContain('phalanx-managed-yield')
    await upload('2.0.0', true)
    expect((await list())[0]?.currentVersion).toBe('1.0.0'); expect(await current()).toBe('1.0.0')
    const confirmed = await impact(); expect(confirmed).toMatchObject({ groups: 2, members: 2 })
    expect((await adminRequest('plugins/change', { action: 'select', packageName: '@example/versioned', revision: confirmed.revision, confirmed: true })).status).toBe(200)
    expect((await (await adminRequest(endpoint)).json()).pendingMembers).toEqual(['member'])
    expect(await current()).toBe('1.0.0'); await restart(); expect(await current()).toBe('2.0.0')
    // A previous release's retained artifact must be rechecked without a registry fetch.
    await app.stop()
    const libraryPath = join(runtime.dataRoot, 'plugins/library.json')
    const stored = JSON.parse(await readFile(libraryPath, 'utf8'))
    const saved = stored.plugins[0]
    const oldRuntime = '0'.repeat(40)
    const artifactRoot = join(runtime.dataRoot, 'plugins', saved.current.artifact)
    await rename(join(artifactRoot, 'prepared', saved.current.preparationId ?? saved.current.runtimeRevision), join(artifactRoot, 'prepared', oldRuntime))
    saved.current.runtimeRevision = oldRuntime; delete saved.current.preparationId; saved.checkedFor = 'previous-release'
    await writeFile(libraryPath, JSON.stringify(stored))
    app = createCommunityApplication(config, 180_000); origin = await app.start()
    expect((await list())[0]).toMatchObject({ stage: 'available', published: true, currentVersion: '2.0.0' })
    expect(await readFile(join(artifactRoot, 'prepared', oldRuntime, 'manifest.json'), 'utf8')).toContain('2.0.0')
    await login(); expect(await current()).toBe('2.0.0')
    await upload('3.0.0', true, true)
    expect((await adminRequest('plugins/change', { action: 'select', packageName: '@example/versioned', revision: (await impact()).revision, confirmed: true })).status).toBe(409)
    expect((await list())[0]?.currentVersion).toBe('2.0.0'); expect(await current()).toBe('2.0.0')
    // Seed a historical prepared row for a plugin whose activation fails on this runtime.
    // Its real original archive is checked by the production container preparer on startup.
    await app.stop()
    const beforeFailure = JSON.parse(await readFile(libraryPath, 'utf8'))
    const original = await readFile(join(root, 'example-versioned-3.0.0.tgz'))
    const hash = createHash('sha512').update(original).digest()
    const badArtifact = 'artifacts/' + hash.toString('hex')
    await mkdir(join(runtime.dataRoot, 'plugins', badArtifact), { recursive: true })
    await writeFile(join(runtime.dataRoot, 'plugins', badArtifact, 'original.tgz'), original)
    beforeFailure.plugins[0] = { ...beforeFailure.plugins[0], version: '3.0.0', checkedFor: 'previous-release', replacement: undefined,
      current: { ...beforeFailure.plugins[0].current, version: '3.0.0', integrity: 'sha512-' + hash.toString('base64'), artifact: badArtifact, runtimeRevision: oldRuntime } }
    await writeFile(libraryPath, JSON.stringify(beforeFailure))
    app = createCommunityApplication(config, 180_000); origin = await app.start()
    expect((await list())[0]).toMatchObject({ stage: 'failed', incompatible: true, published: false, publicationPaused: true })
    const incompatible = await (await adminRequest(endpoint)).json()
    expect(incompatible.plugins[0]).toMatchObject({ granted: true, available: false, incompatible: true })
    await login()
    expect(await (await fetch(origin + '/market/api/plugins', { headers: { cookie: member } })).json()).toEqual([])
    expect(await current()).toBe('1.0.0')
    // Restore the already known compatible version using identical retained bytes.
    const replacement = await fetch(origin + '/admin/api/plugins/upload', { method: 'POST', headers: { cookie: admin, origin, 'content-type': 'application/gzip', 'x-plugin-filename': 'versioned.tgz', 'x-plugin-replace-package': '@example/versioned' }, body: await readFile(join(root, 'example-versioned-2.0.0.tgz')) })
    expect(replacement.status).toBe(202)
    await expect.poll(async () => (await list())[0]?.replacement?.stage, { timeout: 180000 }).toBe('available')
    expect((await adminRequest('plugins/change', { action: 'select', packageName: '@example/versioned', revision: (await impact()).revision, confirmed: true })).status).toBe(200)
    expect((await list())[0]).toMatchObject({ published: true, stage: 'available' })
    expect((await list())[0]?.incompatible).toBeUndefined()
    await restart(); expect(await current()).toBe('2.0.0')
    // Reset clears native market copies and owned yield entries, retaining platform artifacts/grants.
    const reset = await adminRequest('accounts/member/reset-environment', { confirmed: true })
    expect(reset.status, await reset.clone().text()).toBe(200)
    const backup = (await reset.json()).backup.location
    expect(await readFile(join(backup, 'files/.dsh/profiles/web/cordis.patch.yml'), 'utf8')).toContain('phalanx-managed-yield')
    await expect(readFile(join(home, '.dsh/profiles/web/node_modules/@example/versioned/package.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(home, '.dsh/profiles/web/cordis.patch.yml'), 'utf8')).not.toContain('phalanx-managed-yield')
    expect(await current()).toBe('2.0.0')
    expect((await (await adminRequest(endpoint)).json()).plugins[0]).toMatchObject({ granted: true, available: true })
    // Restore a self copy through the market before exercising library removal below.
    await adminRequest(endpoint, { action: 'save', packages: [] }); await restart()
    expect((await fetch(origin + '/market/api/plugins', { method: 'POST', headers: { cookie: member, origin, 'content-type': 'application/json' }, body: JSON.stringify({ packageName: '@example/versioned' }) })).status).toBe(200)
    await adminRequest(endpoint, { action: 'save', packages: ['@example/versioned'] }); await restart()

    expect((await adminRequest('plugins/change', { action: 'remove', packageName: '@example/versioned', revision: (await impact()).revision, confirmed: true })).status).toBe(200)
    expect(await list()).toEqual([])
    expect(await (await fetch(origin + '/market/api/plugins', { headers: { cookie: member } })).json()).toEqual([])
    expect(((await (await adminRequest('groups')).json()) as CommunityGroupView[]).find(row => row.id === group.id)?.pluginCount).toBe(0)
    expect(await current()).toBe('2.0.0'); await restart(); expect(await current()).toBe('2.0.0')
    expect(await readFile(join(home, '.dsh/profiles/web/cordis.patch.yml'), 'utf8')).not.toContain('phalanx-managed-yield')
    expect(JSON.parse(await readFile(join(home, '.dsh/profiles/web/node_modules/@example/versioned/package.json'), 'utf8')).version).toBe('2.0.0')
  } finally { await app.stop(); await new CommunityRuntimeDriver(runtime).rebuild(); await rm(root, { recursive: true, force: true }) }
}, 600000)
