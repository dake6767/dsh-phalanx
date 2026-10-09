import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { candidateApplication as createCommunityApplication } from './support/candidate-application.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import { execFileText } from '../src/adapters/runtime-command.js'
import { runtimeSection, assertPinnedDshRevision } from './support/real-dsh-runtime.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { createRealDshRpc } from './support/real-dsh-rpc.js'
import type { CommunityGroupView, CommunityManagedGroupView, CommunityPluginView } from '../src/domain/admin-contract.js'

it.skipIf(!runtimeSettings.containerImage)('loads npm and uploaded grants read-only, applies revocation on restart, and isolates failed plugins', async () => {
  assertPinnedDshRevision(runtimeSettings)
  const root = await mkdtemp(join(tmpdir(), 'managed-plugins-'))
  const runtime = runtimeSection(join(root, 'platform'), 'https://example.test', runtimeSettings)
  const app = createCommunityApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'managed-plugin-container-fixture-secret', runtime })
  const rpc = createRealDshRpc()
  let origin = ''; let admin = ''; let member = ''
  const cookies = (response: Response) => response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  const adminRequest = async (path: string, body?: object) => await fetch(origin + '/admin/api/' + path, {
    method: body ? 'POST' : 'GET', headers: { cookie: admin, origin, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
  const inventory = async () => await rpc.remoteRpc<Array<{ entryId: string, moduleName: string, fiberPhase: string, readOnlyReason?: string }>>(origin, member, 'pluginManager/listPlugins', {})
  const login = async () => {
    const response = await fetch(origin + '/login', { method: 'POST', redirect: 'manual', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: 'member', password: 'password' }) })
    expect(response.status).toBe(303); expect(response.headers.get('location')).not.toBe('/recovery'); member = cookies(response)
  }
  const pack = async (name: string, id: string, code: string) => {
    const directory = join(root, id); await mkdir(directory)
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name, version: '1.0.0', type: 'module', main: './index.js', dsh: { bundle: { patch: './patch.yml' } } }))
    await writeFile(join(directory, 'index.js'), code)
    await writeFile(join(directory, 'patch.yml'), JSON.stringify([{ insert: [{ id, name }] }]))
    const packed = JSON.parse(await execFileText('npm', ['pack', directory, '--ignore-scripts', '--json', '--pack-destination', root])) as Array<{ filename: string }>
    return join(root, packed[0]!.filename)
  }
  try {
    origin = await app.start()
    const bootstrap = await fetch(origin + '/bootstrap', { method: 'POST', redirect: 'manual', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ credential: readBootstrapCredential(runtime.dataRoot)!.credential, username: 'admin', password: 'password' }) })
    admin = cookies(bootstrap); expect(bootstrap.status).toBe(303)
    const groups = await (await adminRequest('groups')).json() as CommunityGroupView[]
    const group = groups.find(row => row.isDefault)!
    expect((await adminRequest('accounts', { username: 'member', password: 'password', email: '', groupId: group.id })).status).toBe(201)
    await login()
    expect((await adminRequest('plugins', { action: 'add', packageName: 'dsh-better-sidebar', version: '0.24.1' })).status).toBe(202)
    const archive = await pack('@example/private-managed', 'private-managed', "import {existsSync} from 'node:fs'; export const name='private-managed'; export function apply(){ if(existsSync('/dsh-phalanx/home/FAIL_MANAGED')) throw Error('fixture activation failure'); }")
    const uploaded = await fetch(origin + '/admin/api/plugins/upload', { method: 'POST', headers: { cookie: admin, origin, 'content-type': 'application/gzip', 'x-plugin-filename': 'private.tgz' }, body: await readFile(archive) })
    expect(uploaded.status).toBe(202)
    await expect.poll(async () => (await (await adminRequest('plugins')).json() as CommunityPluginView[]).map(row => row.stage), { timeout: 240000, interval: 500 }).toEqual(['available', 'available'])
    expect((await inventory()).some(row => row.moduleName.includes('dsh-better-sidebar'))).toBe(false)
    const endpoint = `groups/${group.id}/plugins`
    let details = await (await adminRequest(endpoint, { action: 'save', packages: ['dsh-better-sidebar', '@example/private-managed'] })).json() as CommunityManagedGroupView
    expect(details.pendingMembers).toEqual(['member'])
    expect((await inventory()).some(row => row.moduleName.includes('dsh-better-sidebar'))).toBe(false)
    details = await (await adminRequest(endpoint, { action: 'restart', confirmed: true })).json() as CommunityManagedGroupView
    expect(details.pendingMembers).toEqual([]); await login()
    const rows = await inventory()
    for (const name of ['dsh-better-sidebar', '@example/private-managed']) {
      const row = rows.find(row => row.moduleName.includes(`/node_modules/${name}/`))!
      expect(row?.fiberPhase).toBe('active'); expect(row.readOnlyReason).toBe('unaddressable')
      expect(await rpc.remoteRpc(origin, member, 'pluginManager/setPluginEnabled', { id: row.entryId, enabled: false })).toMatchObject({ application: 'failed', changed: false })
      expect(await rpc.remoteRpc(origin, member, 'pluginManager/removeBundle', { name: row.moduleName })).toMatchObject({ application: 'failed' })
    }
    const layer = rows.find(row => row.entryId.startsWith('include:phalanx-managed-') && row.moduleName === '@deepseek-ai/cordis-plugin-include')!
    expect(layer).toBeDefined()
    expect(await rpc.remoteRpc(origin, member, 'pluginManager/setPluginEnabled', { id: layer.entryId, enabled: false })).toMatchObject({ application: 'failed', changed: false })
    const owner = createHash('sha256').update(runtime.dataRoot).digest('hex')
    const carrier = (await execFileText('podman', ['ps', '--filter', `label=dsh-phalanx.community-root=${owner}`, '--format', '{{.Names}}'])).trim()
    const target = rows.find(row => row.moduleName.includes('/node_modules/dsh-better-sidebar/'))!.moduleName
    const readonly = await execFileText('podman', ['exec', carrier, 'node', '-e', `try { require('node:fs').appendFileSync(${JSON.stringify(target)}, ''); process.stdout.write('writable') } catch(error) { process.stdout.write(error.code) }`])
    expect(readonly).toBe('EROFS')
    expect(details.plugins.flatMap(plugin => plugin.failures)).toEqual([])
    const memberHome = join(runtime.dataRoot, 'users/member/home')
    await writeFile(join(memberHome, 'KEEP_ME'), 'member content')
    await writeFile(join(memberHome, 'FAIL_MANAGED'), 'fail only in this member')
    const restart = await fetch(origin + '/recovery/restart', { method: 'POST', headers: { cookie: member, origin, 'content-type': 'application/json' }, body: JSON.stringify({ confirmed: true }) })
    expect(restart.status).toBe(200); await login()
    details = await (await adminRequest(endpoint)).json() as CommunityManagedGroupView
    expect(details.plugins.find(row => row.packageName === '@example/private-managed')?.failures).toEqual([{ username: 'member', code: 'plugin-managed-load-failed' }])
    expect((await inventory()).find(row => row.moduleName.includes('/node_modules/dsh-better-sidebar/'))?.fiberPhase).toBe('active')
    expect((await inventory()).find(row => row.moduleName.endsWith('/platform-plugin/plugin.mjs'))?.fiberPhase).toBe('active')
    expect((await fetch(origin + '/recovery', { headers: { cookie: member } })).status).toBe(200)
    const self = await pack('@example/self-owned', 'self-owned', "export const name='self-owned'; export function apply() {}")
    await copyFile(self, join(memberHome, 'self.tgz'))
    const installation = await rpc.remoteRpc(origin, member, 'pluginManager/installBundle', { spec: '/dsh-phalanx/home/self.tgz' })
    expect(installation).toMatchObject({ changed: true })
    await adminRequest(endpoint, { action: 'save', packages: [] })
    await adminRequest(endpoint, { action: 'restart', confirmed: true }); await login()
    const revoked = await inventory()
    expect(revoked.some(row => row.moduleName.includes('/dsh-phalanx/artifacts/'))).toBe(false)
    expect(revoked.some(row => row.moduleName === '@example/self-owned')).toBe(true)
    expect(await readFile(join(memberHome, 'KEEP_ME'), 'utf8')).toBe('member content')
  } finally { await app.stop(); await new CommunityRuntimeDriver(runtime).rebuild(); await rm(root, { recursive: true, force: true }) }
}, 420000)
