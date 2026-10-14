import { fakeContributionLibrary } from './fixtures/contributions.js'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
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
