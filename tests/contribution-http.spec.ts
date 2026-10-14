import { contributionDeclaration } from '../src/domain/contribution-checks.js'
import { fakeContributionLibrary } from './fixtures/contributions.js'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createContributionGateway } from '../src/inbound/contribution-route.js'
import { MemberContributions } from '../src/use-cases/member-contributions.js'
import { CommunityModelAuthorization } from '../src/use-cases/community-model-authorization.js'
import { FileContributionStore, FileContributionArtifacts } from '../src/adapters/contribution-storage.js'
import { skillZip, validSkill } from './fixtures/skills/archive.js'
it('accepts only gateway tokens, isolates members and retains pending content across restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contribution-http-'))
  const accounts = new Map(['alice', 'bob'].map(username => [username, { username, spaceId: username + '-space', sessionEpoch: 0, admin: false, disabled: false, email: '', groupId: 'group', createdAt: 0, updatedAt: 0 }]))
  const artifacts = new FileContributionArtifacts(join(root, 'artifacts'), ['builtin-skill'])
  const makeService = () => new MemberContributions({ get: name => accounts.get(name) }, new FileContributionStore(join(root, 'records.json')), artifacts, fakeContributionLibrary(), { now: () => 100 })
  let service = makeService()
  const auth = new CommunityModelAuthorization({ getState: name => accounts.get(name) }, { resolve: token => token === 'alice-token' ? { username: 'alice', spaceId: 'alice-space' } : token === 'bob-token' ? { username: 'bob', spaceId: 'bob-space' } : undefined })
  const server = createServer((request, response) => { void createContributionGateway(service, auth, name => accounts.get(name)!)(request, response) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const submit = (token: string, body: Buffer, purpose = 'Share guide') => fetch(origin + '/contributions?action=submit', { method: 'POST', headers: { 'x-api-key': token, 'x-contribution-declaration': Buffer.from(JSON.stringify({ purpose })).toString('base64url') }, body: new Uint8Array(body) })
  try {
    expect((await fetch(origin + '/contributions', { headers: { cookie: 'dsh-phalanx_session=browser-cookie' } })).status).toBe(401)
    expect((await submit('alice-token', skillZip([{ path: 'SKILL.md', content: validSkill.replace('example-skill', 'builtin-skill') }]))).status).toBe(400)
    const submitted = await submit('alice-token', skillZip([{ path: 'SKILL.md', content: validSkill }]))
    expect(submitted.status).toBe(200); const row = await submitted.json() as { id: string }
    expect(await (await fetch(origin + '/contributions', { headers: { 'x-api-key': 'bob-token' } })).json()).toEqual({ contributions: [] })
    expect((await fetch(origin + '/contributions?action=withdraw', { method: 'POST', headers: { 'x-api-key': 'bob-token', 'content-type': 'application/json' }, body: JSON.stringify({ id: row.id }) })).status).toBe(404)
    service = makeService(); await service.recover()
    expect(service.list(accounts.get('alice')!)).toHaveLength(1)
    accounts.set('alice', { ...accounts.get('alice')!, disabled: true })
    expect((await fetch(origin + '/contributions', { headers: { 'x-api-key': 'alice-token' } })).status).toBe(401)
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }) }
})

it('aborts an intake whose sender never sends another chunk', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contribution-abort-'))
  const controller = new AbortController(); let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const content: AsyncIterable<Uint8Array> = { [Symbol.asyncIterator]: () => ({ next: () => { entered(); return new Promise(() => {}) } }) }
  try {
    const receiving = new FileContributionArtifacts(root, []).accept(content, controller.signal)
    const rejected = expect(receiving).rejects.toMatchObject({ name: 'AbortError' })
    await started; controller.abort(); await rejected
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('rejects credential archives without storage, requires explicit warning retention and persists safe findings across restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contribution-checks-'))
  const artifacts = new FileContributionArtifacts(join(root, 'artifacts'), [])
  async function* bytes(value: Uint8Array) { yield value }
  const high = 'R7mX2bK9nD4pQ6sT1vZ8aF3cH5jL0wE', low = 'personal-key'
  try {
    const withCredential = (value: string) => skillZip([{ path: 'SKILL.md', content: validSkill }, { path: 'search.js', content: `const apiKey = "${value}"` }])
    await expect(artifacts.accept(bytes(withCredential(high)), new AbortController().signal, { purpose: 'Search' }, true)).rejects.toMatchObject({ findings: [{ code: 'contribution-credential-high', severity: 'reject', path: 'search.js' }] })
    await expect(readdir(join(root, 'artifacts'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(artifacts.accept(bytes(withCredential(low)), new AbortController().signal)).rejects.toMatchObject({ findings: [{ code: 'contribution-credential-low', severity: 'warning' }] })
    const retained = await artifacts.accept(bytes(withCredential(low)), new AbortController().signal, { purpose: 'Search' }, true)
    expect(retained.findings?.[0]?.code).toBe('contribution-credential-low')
    expect(JSON.stringify(retained.findings)).not.toContain(low)
    await expect(artifacts.accept(bytes(skillZip([{ path: 'SKILL.md', content: validSkill }, { path: '.env.local', content: 'excluded' }])), new AbortController().signal, { purpose: 'Search' }, true)).rejects.toMatchObject({ findings: [{ code: 'contribution-excluded-file' }] })
    expect((await artifacts.accept(bytes(skillZip([{ path: 'SKILL.md', content: validSkill }, { path: 'requirements.txt', content: 'example-package' }])), new AbortController().signal, contributionDeclaration({ purpose: 'Search', execution: { commands: [], variables: [], prepare: 'pip install different' } }))).findings).toEqual([])
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('rejects credentials in declarations and redacts retained matches while preserving the immutable original archive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contribution-declaration-checks-'))
  const artifacts = new FileContributionArtifacts(root, [])
  async function* bytes(value: Uint8Array) { yield value }
  const original = skillZip([{ path: 'SKILL.md', content: validSkill + '\nconst apiKey = "personal-key";' }])
  try {
    await expect(artifacts.accept(bytes(skillZip([{ path: 'SKILL.md', content: validSkill }])), new AbortController().signal, { purpose: 'API_KEY = "Q8rB3mZ7xK2nV9sP4cD6hF1tL5aE0wY"' }, true)).rejects.toMatchObject({ findings: [{ severity: 'reject', code: 'contribution-credential-high' }] })
    const retained = await artifacts.accept(bytes(original), new AbortController().signal, { purpose: 'Share' }, true)
    expect(retained.markdown).not.toContain('personal-key'); expect(retained.markdown).toContain('[redacted]')
    expect(await artifacts.read(retained.hash)).toEqual(original)
    expect((await artifacts.accept(bytes(skillZip([{ path: 'SKILL.md', content: validSkill }, { path: 'requirements.txt', content: 'package' }])), new AbortController().signal, { purpose: 'Share' })).findings).toEqual([])
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('requires warning retention for undeclared commands in scripts and SKILL.md, excluding image commands', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contribution-commands-'))
  const artifacts = new FileContributionArtifacts(root, [], { commands: async () => ['python3', 'node', 'echo'] })
  const archive = skillZip([{ path: 'SKILL.md', content: validSkill + '\n```sh\nlark-cli docs list\npython3 helper.py\n```\n' }, { path: 'helper.py', content: 'import subprocess\nsubprocess.run(["officecli", "read", "report.docx"])' }])
  async function* bytes() { yield archive }
  try {
    await expect(artifacts.accept(bytes(), new AbortController().signal, { purpose: 'Documents' })).rejects.toMatchObject({ findings: expect.arrayContaining([{ code: 'contribution-command-undeclared', severity: 'warning', path: 'SKILL.md', advice: expect.stringContaining('lark-cli') }, { code: 'contribution-command-undeclared', severity: 'warning', path: 'helper.py', advice: expect.stringContaining('officecli') }]) })
    const retained = await artifacts.accept(bytes(), new AbortController().signal, { purpose: 'Documents' }, true)
    expect(retained.findings).toHaveLength(2)
    const declared = await artifacts.accept(bytes(), new AbortController().signal, { purpose: 'Documents', requiredCommands: ['lark-cli', 'officecli'].map(name => ({ name, purpose: 'Read documents', installation: 'Install a pinned binary into bin' })) })
    expect(declared.findings).toEqual([])
  } finally { await rm(root, { recursive: true, force: true }) }
})
