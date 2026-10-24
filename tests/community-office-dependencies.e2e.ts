// Validation: T2; real credentials: none; actual Linux rootless DSH and exact PyPI wheels.
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { candidateApplication } from './support/candidate-application.js'
import { openCommunityHttpEntry } from './support/community-http-entry.js'
import { communityEntryUrl } from './support/community-space.js'
import { runtimeSection, assertPinnedDshRevision } from './support/real-dsh-runtime.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { CommunityAccountStore } from '../src/adapters/community-account-store.js'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import { FileExecutionArtifacts } from '../src/adapters/execution-artifacts.js'
import { FileSkillArtifacts } from '../src/adapters/skill-artifacts.js'
import { FileSkillDistribution } from '../src/adapters/skill-distribution.js'
import { skillZip } from './fixtures/skills/archive.js'

it.skipIf(!runtimeSettings.containerImage)('imports multiple Python libraries in member bash, isolates an activated member venv and delegates only declared libraries', async () => {
  assertPinnedDshRevision(runtimeSettings)
  const root = await mkdtemp(join(tmpdir(), 'office-python-')), overlay = join(root, 'observer.json')
  await writeFile(overlay, JSON.stringify([{ id: 'tools', config: { mode: 'native' } }, { insert: [{ id: 'skills-observer', name: '/dsh-phalanx/home/skills-observer.mjs' }] }]))
  const runtime = { ...runtimeSection(root, 'https://example.test', runtimeSettings), patches: [overlay] }
  const app = candidateApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'office-python-library-fixture-session-secret', runtime })
  const accounts = new CommunityAccountStore(join(root, 'community-accounts.db'))
  let failure: unknown
  const cleanup = async () => {
    const skills = new FileSkillArtifacts(join(root, 'skills/artifacts'), []), errors: unknown[] = []
    for (const clean of [() => app.stop(), () => new CommunityRuntimeDriver(runtime).rebuild(), () => new FileSkillDistribution(join(root, 'skills/members'), skills).synchronize([]), () => skills.collect([]), () => new FileExecutionArtifacts(join(root, 'runtime-dependencies/.trees')).collect([]), () => new FileExecutionArtifacts(join(root, 'execution/artifacts')).collect([]), () => accounts.close(), () => rm(root, { recursive: true, force: true })]) {
      try { await clean() } catch (error) { errors.push(error) }
    }
    if (errors.length) throw new AggregateError(failure ? [failure, ...errors] : errors, 'Python library fixture cleanup failed')
  }
  try {
    await accounts.createFirstAdmin({ username: 'admin', password: 'password', email: '' }); await accounts.create({ username: 'member', password: 'password', email: '' })
    const home = join(root, 'users/member/home'); await mkdir(home, { recursive: true, mode: 0o700 })
    await copyFile('tests/fixtures/skill-observer.mjs', join(home, 'skills-observer.mjs'))
    const origin = await app.start()
    const login = async (username: string) => {
      const response = await fetch(origin + '/login', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username, password: 'password' }) })
      expect(response.status, await response.clone().text()).toBe(303)
      return response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    }
    const admin = await login('admin')
    const api = async (path: string, body?: object) => {
      const response = await fetch(origin + '/admin/api/' + path, { method: body ? 'POST' : 'GET', headers: { cookie: admin, origin, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
      expect(response.ok, await response.clone().text()).toBe(true); return response.json()
    }
    for (const [name, pin] of [['python-a', 'six==1.17.0'], ['python-b', 'humanfriendly==10.0']]) {
      await api('runtime-dependencies', { action: 'create', input: { name, type: 'python-library', packages: [pin] } })
      await expect.poll(async () => { const row = await api('runtime-dependencies?name=' + name); if (row.stage === 'failed') throw new Error(row.log); return row.stage }, { timeout: 120000 }).toBe('ready')
    }
    const script = 'import importlib.util,six,sys\nif len(sys.argv)>1:\n import humanfriendly\n print("BROKER_BOTH")\nelse:\n assert importlib.util.find_spec("humanfriendly") is None\n print("BROKER_A_ONLY")\n'
    const upload = await fetch(origin + '/admin/api/skills/upload', { method: 'POST', headers: { cookie: admin, origin, 'content-type': 'application/zip' }, body: new Uint8Array(skillZip([{ path: 'SKILL.md', content: '---\nname: python-documents\ndescription: Python library fixture\n---\nUse Python libraries.' }, { path: 'scripts/probe.py', content: script }])) })
    expect(upload.status).toBe(200); const preview = await upload.json()
    await api('skills/change', { action: 'confirm', token: preview.token, revision: preview.revision })
    const detail = await api('skills/detail?name=python-documents')
    await api('skills/change', { action: 'runtime-dependencies', name: detail.name, names: ['python-b', 'python-a'], revision: detail.revision })
    const grantPath = `groups/${accounts.get('member')!.groupId}/skills`, group = await api(grantPath)
    await api(grantPath, { action: 'save', names: ['python-documents'], revision: group.revision, confirmed: true })
    const configuration = { enabled: true, commands: [{ command: 'scripts/probe.py', blocked: [] }], runtimeDependencies: ['python-a'], variables: [] }
    await api('skills/execution?name=python-documents', configuration)
    const cookie = (await openCommunityHttpEntry(origin, await login('member'), 300000)).cookie
    const observe = async (body: object) => { const response = await fetch(communityEntryUrl(origin, cookie) + 'skills-fixture', { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify(body) }); expect(response.status, await response.clone().text()).toBe(200); return response.json() }
    const bash = async (command: string) => { const { sessionId } = await observe({ operation: 'create' }); return (await observe({ operation: 'tool', sessionId, name: 'bash', args: { description: 'Verify Python libraries', command, timeoutMs: 30000 } })).value }
    const imported = await bash('python3 -c \'import six,humanfriendly,sys; assert sys.prefix != sys.base_prefix; print("MEMBER_BOTH")\'')
    expect(imported, imported.stderr?.text).toMatchObject({ exitCode: 0, stdout: { text: 'MEMBER_BOTH\n' } })
    const own = await bash('python3 -m venv --copies --without-pip /dsh-phalanx/workspace/own; . /dsh-phalanx/workspace/own/bin/activate; python3 -c \'import importlib.util; assert importlib.util.find_spec("six") is None; assert importlib.util.find_spec("humanfriendly") is None; print("OWN_CLEAN")\'')
    expect(own, own.stderr?.text).toMatchObject({ exitCode: 0, stdout: { text: 'OWN_CLEAN\n' } })
    const delegated = 'python3 /dsh-phalanx/member-skills/live/python-documents/scripts/probe.py'
    expect(await bash(delegated)).toMatchObject({ exitCode: 0, stdout: { text: 'BROKER_A_ONLY\n' } })
    await api('skills/execution?name=python-documents', { ...configuration, runtimeDependencies: ['python-b', 'python-a'] })
    expect(await bash(delegated + ' both')).toMatchObject({ exitCode: 0, stdout: { text: 'BROKER_BOTH\n' } })
  } catch (error) { failure = error; throw error }
  finally { await cleanup() }
}, 600000)
