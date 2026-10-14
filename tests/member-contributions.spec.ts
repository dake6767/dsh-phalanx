import { memoryContributions, fakeContributionLibrary } from './fixtures/contributions.js'
import { expect, it } from 'vitest'
import { MemberContributions } from '../src/use-cases/member-contributions.js'
import type { MemberContribution } from '../src/domain/member-contribution.js'

it('keeps a submitted skill private until an administrator adopts an independent copy', async () => {
  const member = { username: 'alice', spaceId: 'alice-space', sessionEpoch: 0 }
  const admin = { username: 'admin', spaceId: 'admin-space', sessionEpoch: 0 }
  const rows = new Map<string, MemberContribution>()
  const adopted: string[] = []
  const service = new MemberContributions({ get: name => ({ ...(name === 'admin' ? admin : member), admin: name === 'admin', disabled: false, email: '', groupId: 'group', createdAt: 0, updatedAt: 0 }) }, memoryContributions(rows), {
    accept: async () => ({ name: 'team-guide', hash: 'artifact', description: 'Team guide', markdown: '# Guide', files: ['SKILL.md'] }),
    read: async () => new Uint8Array([1]), collect: async () => {}, newId: () => 'contribution-1',
  }, fakeContributionLibrary(() => adopted.push('team-guide')), { now: () => 1000 })
  async function* bytes() { yield new Uint8Array([1]) }
  const submitted = await service.submit(member, { purpose: 'Share our team guide' }, bytes(), new AbortController().signal)
  expect(submitted).toMatchObject({ name: 'team-guide', status: 'pending', submittedAt: 1000 })
  expect(adopted).toEqual([])
  expect(service.list(member)).toHaveLength(1)
  await expect(service.decide(member, submitted.id, { action: 'adopt', revision: submitted.revision, token: 'preview' })).rejects.toMatchObject({ code: 'admin-required' })
  await service.review(admin, submitted.id, submitted.revision)
  await service.decide(admin, submitted.id, { action: 'adopt', revision: submitted.revision, token: 'preview' })
  expect(adopted).toEqual(['team-guide'])
  expect(service.list(member)[0]).toMatchObject({ status: 'adopted' })
})

it('rejects spoofed identity and invalid intake, replaces pending submissions and expires withdrawn records', async () => {
  const alice = { username: 'alice', spaceId: 'a', sessionEpoch: 0 }, bob = { username: 'bob', spaceId: 'b', sessionEpoch: 0 }
  const accounts = new Map([alice, bob].map(actor => [actor.username, { ...actor, admin: false, disabled: false, email: '', groupId: 'group', createdAt: 0, updatedAt: 0 }]))
  const rows = new Map<string, MemberContribution>(); let now = 0, id = 0
  const service = new MemberContributions({ get: name => accounts.get(name) }, memoryContributions(rows), {
    accept: async () => ({ name: 'team-guide', hash: 'artifact', description: 'Team guide', markdown: '# Guide', files: ['SKILL.md'] }),
    read: async () => new Uint8Array([1]), collect: async () => {}, newId: () => `contribution-${++id}`,
  }, fakeContributionLibrary(), { now: () => now })
  async function* bytes() { yield new Uint8Array([1]) }
  const submit = (actor = alice, purpose = 'Share guide') => service.submit(actor, { purpose }, bytes(), new AbortController().signal)
  await expect(submit({ ...alice, spaceId: 'b' })).rejects.toMatchObject({ code: 'sign-in-required' })
  await expect(submit(alice, '')).rejects.toMatchObject({ code: 'contribution-invalid' })
  const first = await submit(); now++
  expect((await submit()).id).toBe(first.id)
  expect(service.list(alice)).toHaveLength(1)
  expect(service.list(bob)).toEqual([])
  await expect(service.withdraw(bob, first.id)).rejects.toMatchObject({ code: 'contribution-unavailable' })
  await service.withdraw(alice, first.id)
  expect(service.list(alice)[0]?.status).toBe('withdrawn')
  now += 30 * 24 * 60 * 60 * 1000; await service.recover()
  expect(service.list(alice)).toEqual([])
  await submit(); accounts.delete('alice'); await service.recover()
  expect(rows.size).toBe(0)
})

it('rejects adoption after the member replaces the reviewed contribution and enforces the pending limit', async () => {
  const member = { username: 'alice', spaceId: 'a', sessionEpoch: 0 }, admin = { username: 'admin', spaceId: 'z', sessionEpoch: 0 }
  const rows = new Map<string, MemberContribution>(); let id = 0, name = 'one'
  const service = new MemberContributions({ get: username => ({ ...(username === 'admin' ? admin : member), admin: username === 'admin', disabled: false, email: '', groupId: 'group', createdAt: 0, updatedAt: 0 }) }, memoryContributions(rows), { accept: async () => ({ name, hash: 'artifact', description: 'Useful skill', markdown: '# Useful', files: ['SKILL.md'] }), read: async () => new Uint8Array(), collect: async () => {}, newId: () => String(++id) }, fakeContributionLibrary(), { now: () => 0 })
  async function* bytes() { yield new Uint8Array([1]) }
  const submit = () => service.submit(member, { purpose: 'Useful skill' }, bytes(), new AbortController().signal)
  const first = await submit(); await submit()
  await expect(service.decide(admin, first.id, { action: 'adopt', revision: first.revision, token: 'preview' })).rejects.toMatchObject({ code: 'contribution-unavailable' })
  for (let i = 1; i < 20; i++) { name = `skill-${i}`; await submit() }
  name = 'overflow'; await expect(submit()).rejects.toMatchObject({ code: 'contribution-limit' })
  name = 'one'; await submit(); expect(service.list(member)).toHaveLength(20)
})

it('recovers an adopted library copy after the status write fails and collects expired artifacts on scheduled maintenance', async () => {
  const admin = { username: 'admin', spaceId: 'z', sessionEpoch: 0 }
  const accounts = { get: () => ({ ...admin, admin: true, disabled: false, email: '', groupId: 'group', createdAt: 0, updatedAt: 0 }) }
  const store = memoryContributions(), library = fakeContributionLibrary()
  let id = 0, now = 0, cleanup!: () => Promise<void>, retained: readonly string[] = []
  const artifacts = { accept: async () => ({ name: 'team-guide', hash: 'artifact', description: 'Guide', markdown: '# Guide', files: ['SKILL.md'] }), read: async () => new Uint8Array(), collect: async (hashes: readonly string[]) => { retained = hashes }, newId: () => String(++id) }
  const service = new MemberContributions(accounts, store, artifacts, library, { now: () => now })
  async function* bytes() { yield new Uint8Array([1]) }
  const row = await service.submit(admin, { purpose: 'Share guide' }, bytes(), new AbortController().signal)
  await service.review(admin, row.id, row.revision)
  const finish = store.finish; store.finish = () => { throw new Error('disk unavailable') }
  await expect(service.decide(admin, row.id, { action: 'adopt', revision: row.revision, token: 'preview' })).rejects.toThrow('disk unavailable')
  store.finish = finish
  const restart = new MemberContributions(accounts, store, artifacts, library, { now: () => now }, { start: run => { cleanup = run; return () => {} } })
  await restart.recover()
  expect(restart.list(admin)[0]?.status).toBe('adopted')
  const withdrawn = await restart.submit(admin, { purpose: 'Share guide again' }, bytes(), new AbortController().signal)
  await restart.withdraw(admin, withdrawn.id)
  restart.start(); now = 30 * 24 * 60 * 60 * 1000; await cleanup()
  expect(restart.list(admin)).toHaveLength(1)
  expect(retained).toEqual(['artifact'])
  await restart.stop()
})

it('preserves an in-flight adoption when its contributor is deleted and another administrator reads the list', async () => {
  const member = { username: 'alice', spaceId: 'a', sessionEpoch: 0 }, admin = { username: 'admin', spaceId: 'z', sessionEpoch: 0 }
  const accounts = new Map([member, admin].map(actor => [actor.username, { ...actor, admin: actor === admin, disabled: false, email: '', groupId: 'group', createdAt: 0, updatedAt: 0 }]))
  let entered!: () => void, resume!: () => void, id = 0
  const started = new Promise<void>(resolve => { entered = resolve }), waiting = new Promise<void>(resolve => { resume = resolve })
  const library = fakeContributionLibrary(), confirm = library.confirm
  library.confirm = async (...args) => { entered(); await waiting; return confirm(...args) }
  const service = new MemberContributions({ get: name => accounts.get(name) }, memoryContributions(), { accept: async () => ({ name: 'team-guide', hash: 'artifact', description: 'Guide', markdown: '# Guide', files: ['SKILL.md'] }), read: async () => new Uint8Array(), collect: async () => {}, newId: () => String(++id) }, library, { now: () => 0 })
  async function* bytes() { yield new Uint8Array([1]) }
  const row = await service.submit(member, { purpose: 'Share guide' }, bytes(), new AbortController().signal)
  await service.review(admin, row.id, row.revision)
  const adopting = service.decide(admin, row.id, { action: 'adopt', revision: row.revision, token: 'preview' })
  await started; accounts.delete(member.username)
  expect(service.list(admin, true)).toEqual([])
  resume(); await adopting; await service.recover()
  expect(service.list(admin, true)[0]).toMatchObject({ status: 'adopted', contributor: member })
})
