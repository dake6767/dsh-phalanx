import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'
import { candidateApplication as createCommunityApplication } from './support/candidate-application.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import { FileSkillArtifacts } from '../src/adapters/skill-artifacts.js'
import { FileSkillDistribution } from '../src/adapters/skill-distribution.js'
import { assertPinnedDshRevision, runtimeSection, CONTAINER_HOME } from './support/real-dsh-runtime.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { communityEntryUrl } from './support/community-space.js'
import { skillZip } from './fixtures/skills/archive.js'
import type { CommunityGroupView, CommunitySkillPreview, CommunitySkillDetail } from '../src/domain/admin-contract.js'
import type { CommunitySkillGroupView } from '../src/domain/admin-contract.js'

it.skipIf(!runtimeSettings.containerImage && !runtimeSettings.dshRoot)('discovers, replaces and revokes platform skills in new DSH sessions without restart, preserving member overrides', async () => {
  assertPinnedDshRevision(runtimeSettings)
  const root = await mkdtemp(join(tmpdir(), 'skills-runtime-')), dataRoot = join(root, 'platform')
  const home = join(dataRoot, 'users/member/home'), mountedHome = runtimeSettings.containerImage ? CONTAINER_HOME : home
  const overlay = join(root, 'skills-fixture.json')
  await writeFile(overlay, JSON.stringify([{ id: 'tools', config: { mode: 'native' } }, { id: 'session-log-deepseek', disabled: true }, { insert: [{ id: 'skills-observer', name: join(mountedHome, 'skills-observer.mjs') }] }]))
  const runtime = { ...runtimeSection(dataRoot, 'https://example.test', runtimeSettings), patches: [overlay] }
  let startupFailure: unknown
  const realStart = CommunityRuntimeDriver.prototype.start
  const startDiagnostic = vi.spyOn(CommunityRuntimeDriver.prototype, 'start').mockImplementation(async function (this: CommunityRuntimeDriver, ...args) {
    try { return await realStart.apply(this, args) } catch (error) { startupFailure = error; throw error }
  })
  const app = createCommunityApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'skills-runtime-fixture-session-secret', runtime })
  let origin = '', admin = '', member = ''
  const cookies = (response: Response) => response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  const request = async (path: string, body?: object) => {
    const response = await fetch(origin + '/admin/api/' + path, { method: body ? 'POST' : 'GET', headers: { origin, cookie: admin, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    expect(response.status, await response.clone().text()).toBe(200); return response
  }
  const observe = async <T>(body: object): Promise<T> => {
    const response = await fetch(communityEntryUrl(origin, member) + 'skills-fixture', { method: 'POST', headers: { cookie: member, origin, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    expect(response.status, await response.clone().text()).toBe(200); return await response.json() as T
  }
  const fresh = async () => (await observe<{ sessionId: string }>({ operation: 'create' })).sessionId
  const definition = async (sessionId: string) => await observe<{ description: string, resourceBase: { path: string } } | null>({ operation: 'get', sessionId, name: 'runtime-skill' })
  const bash = async (sessionId: string, command: string, workdir?: string) => await observe<{ value: { exitCode: number, stdout: { text: string }, stderr: { text: string } } }>({ operation: 'tool', sessionId, name: 'bash', args: { description: 'Verify distributed skill behavior', command, timeoutMs: 10000, ...(workdir ? { workdir } : {}) } })
  const upload = async (marker: string) => {
    const response = await fetch(origin + '/admin/api/skills/upload', { method: 'POST', headers: { origin, cookie: admin, 'content-type': 'application/zip' }, body: new Uint8Array(skillZip([{ path: 'SKILL.md', content: `---\nname: runtime-skill\ndescription: ${marker}\n---\nRun scripts/marker.py relative to this skill.` }, { path: 'scripts/marker.py', content: `print('${marker}')` }])) })
    expect(response.status).toBe(200); const preview = await response.json() as CommunitySkillPreview
    await request('skills/change', { action: 'confirm', token: preview.token, revision: preview.revision })
  }
  try {
    origin = await app.start()
    const bootstrap = await fetch(origin + '/bootstrap', { method: 'POST', redirect: 'manual', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ credential: readBootstrapCredential(dataRoot)!.credential, username: 'admin', password: 'password' }) })
    expect(bootstrap.status).toBe(303); admin = cookies(bootstrap)
    const groups = await (await request('groups')).json() as CommunityGroupView[], group = groups.find(group => group.isDefault)!
    const account = await fetch(origin + '/admin/api/accounts', { method: 'POST', headers: { origin, cookie: admin, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'member', email: '', password: 'password', groupId: group.id }) })
    expect(account.status).toBe(201)
    await mkdir(home, { recursive: true, mode: 0o700 }); await copyFile(fileURLToPath(new URL('./fixtures/skill-observer.mjs', import.meta.url)), join(home, 'skills-observer.mjs'))
    await upload('VERSION_ONE')
    const endpoint = `groups/${group.id}/skills`
    const grant = async (names: string[]) => { const view = await (await request(endpoint)).json() as CommunitySkillGroupView; await request(endpoint, { action: 'save', names, revision: view.revision, confirmed: true }) }
    await grant(['runtime-skill'])
    const login = await fetch(origin + '/login', { method: 'POST', redirect: 'manual', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: 'member', password: 'password' }) })
    expect(login.status).toBe(303); expect(login.headers.get('location'), String(startupFailure)).not.toBe('/recovery'); member = cookies(login)
    const initial = await observe<{ instance: string }>({ operation: 'inventory' })
    const first = await fresh(), skill = await definition(first)
    expect(skill?.description).toBe('VERSION_ONE')
    expect((await bash(first, 'python3 scripts/marker.py', skill!.resourceBase.path)).value).toMatchObject({ exitCode: 0, stdout: { text: 'VERSION_ONE\n' } })
    if (runtimeSettings.containerImage) expect((await bash(first, 'rm SKILL.md', skill!.resourceBase.path)).value.exitCode).not.toBe(0)
    await upload('VERSION_TWO')
    expect((await definition(await fresh()))?.description).toBe('VERSION_TWO')
    for (const directory of ['.dsh', '.agents']) {
      const owned = join(home, directory, 'skills/runtime-skill'); await mkdir(owned, { recursive: true })
      await writeFile(join(owned, 'SKILL.md'), '---\nname: runtime-skill\ndescription: MEMBER_OWNED\n---\nMember content')
      expect((await definition(await fresh()))?.description).toBe('MEMBER_OWNED')
      await grant([])
      expect((await definition(await fresh()))?.description).toBe('MEMBER_OWNED')
      expect(await readFile(join(owned, 'SKILL.md'), 'utf8')).toContain('Member content')
      await rm(owned, { recursive: true }); expect(await definition(await fresh())).toBeNull()
      await grant(['runtime-skill'])
    }
    const detail = await (await request('skills/detail?name=runtime-skill')).json() as CommunitySkillDetail
    expect(detail.managedMembers).toBe(2)
    await request('skills/change', { action: 'remove', name: detail.name, revision: detail.revision })
    expect(await definition(await fresh())).toBeNull()
    expect((await (await request(endpoint)).json() as CommunitySkillGroupView).skills).toEqual([])
    expect((await observe<{ instance: string }>({ operation: 'inventory' })).instance).toBe(initial.instance)
  } finally {
    startDiagnostic.mockRestore()
    await app.stop(); await new CommunityRuntimeDriver(runtime).rebuild()
    const artifacts = new FileSkillArtifacts(join(dataRoot, 'skills/artifacts'), [])
    await new FileSkillDistribution(join(dataRoot, 'skills/members'), artifacts).synchronize([]); await artifacts.collect([])
    await rm(root, { recursive: true, force: true })
  }
}, 240000)
