import { FileSkillAssignments } from '../src/adapters/skill-assignments.js'
import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileExecutionConfigurations } from '../src/adapters/execution-configuration-store.js'
import { ExecutionAdministration } from '../src/use-cases/execution-administration.js'
import { MemberContributions } from '../src/use-cases/member-contributions.js'
import { SkillLibrary } from '../src/use-cases/skill-library.js'
import { SkillMembership } from '../src/use-cases/skill-membership.js'
import { MemberEffectiveSkills } from '../src/use-cases/member-effective-skills.js'
import { memoryContributions } from './fixtures/contributions.js'
import type { LibrarySkill } from '../src/domain/skill-library.js'

it('finishes adoption when a selected empty group disappears while the library confirmation is in flight', async () => {
  const actor = { username: 'admin', spaceId: 'space', sessionEpoch: 0 }, account = { ...actor, admin: true, disabled: false, groupId: 'admins', email: '', createdAt: 0, updatedAt: 0 }
  let groups = [{ id: 'admins', name: 'Admins', kind: 'admin' as 'admin' | 'ordinary', isDefault: false, memberCount: 1 }, { id: 'target', name: 'Target', kind: 'ordinary' as 'admin' | 'ordinary', isDefault: false, memberCount: 0 }]
  const accounts = { get: () => account, list: () => [account], listGroups: () => groups }
  let rows: LibrarySkill[] = [], entered!: () => void, resume!: () => void, paused = true, id = 0
  const started = new Promise<void>(resolve => { entered = resolve }), released = new Promise<void>(resolve => { resume = resolve })
  const store = { list: () => rows, save: (row: LibrarySkill) => { rows = [...rows.filter(old => old.name !== row.name), row] }, remove: (name: string) => { rows = rows.filter(row => row.name !== name) } }
  const assignments = () => { const rows = new Map<string, readonly string[]>(); return { get: (id: string) => rows.get(id) ?? [], set: (id: string, names: readonly string[]) => { rows.set(id, names) }, retain: () => {} } }
  const grants = assignments(), selections = assignments(), upload = { name: 'guide', description: 'Guide', hash: 'artifact', markdown: '# Guide\nconst apiKey = "personal-key";', files: ['SKILL.md'] }
  const membership = new SkillMembership(accounts, store, grants, selections, new MemberEffectiveSkills(accounts, store, grants, selections), { synchronize: async () => { if (paused) { entered(); await released; paused = false } } })
  const library = new SkillLibrary(accounts, store, { accept: async () => upload, read: async () => upload, collect: async () => {}, newToken: () => 'preview' }, { now: () => 0 }, membership)
  const contributions = new MemberContributions(accounts, memoryContributions(), { accept: async () => upload, read: async () => new Uint8Array(), collect: async () => {}, newId: () => String(++id) }, library, { now: () => 0 })
  async function* bytes() { yield new Uint8Array([1]) }
  const row = await contributions.submit(actor, { purpose: 'Share guide' }, bytes(), new AbortController().signal)
  const review = await contributions.review(actor, row.id, row.revision)
  const target = review.groups!.find(group => group.group.id === 'target')!
  const adopting = contributions.decide(actor, row.id, { action: 'adopt', token: review.token, revision: row.revision, setup: { groups: [{ id: 'target', revision: target.revision }] } })
  await started; groups = groups.filter(group => group.id !== 'target'); resume(); await adopting
  expect(contributions.list(actor)[0]).toMatchObject({ status: 'adopted', reason: expect.stringContaining('group was removed') })
  await contributions.recover(); expect(library.list(actor).map(row => row.name)).toEqual(['guide'])
  await expect(library.marketDetail(actor, 'guide')).rejects.toMatchObject({ code: 'skill-unavailable' })
  await membership.save('admins', ['guide'], membership.group('admins').revision)
  expect(JSON.stringify(await library.marketDetail(actor, 'guide'))).not.toContain('personal-key')
  expect(JSON.stringify(await library.detail(actor, 'guide'))).not.toContain('personal-key')
})

it('retains preparation approval and idempotent configuration ownership across a platform restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contribution-config-recovery-'))
  const actor = { username: 'admin', spaceId: 'space', sessionEpoch: 0 }
  const accounts = { get: () => ({ ...actor, admin: true, disabled: false, groupId: 'admins', email: '', createdAt: 0, updatedAt: 0 }) }
  const path = join(root, 'configuration.json'), make = () => new ExecutionAdministration(accounts, { get: id => ({ id, version: 'v1' }), owns: () => true }, new FileExecutionConfigurations(path), async () => {})
  const row = { name: 'guide', description: 'Guide', hash: 'artifact', markdown: '# Guide', files: ['SKILL.md'], id: 'contribution', revision: 'content-revision', contributor: actor, declaration: { purpose: 'Share guide' }, submittedAt: 0, updatedAt: 0, status: 'pending' as const }
  const setup = { enabled: true, commands: [{ command: 'guide', blocked: [] }], variables: [{ name: 'KEY', secret: true, value: 'old-secret' }] }
  try {
    await make().adoptContribution(row, setup)
    const restarted = make()
    expect((await restarted.view(actor, 'skill:guide')).awaitingPreparation).toBe(true)
    await restarted.save(actor, 'skill:guide', { ...setup, variables: [{ name: 'KEY', secret: true, value: 'new-secret' }] })
    await make().adoptContribution(row, setup)
    expect(new FileExecutionConfigurations(path).get('skill:guide')!.variables[0]!.value).toBe('new-secret')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('does not mistake unchanged skill bytes for a committed adoption and preserves later distribution changes after receipt interruption', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contribution-skill-receipts-'))
  try {
    const actor = { username: 'admin', spaceId: 'space', sessionEpoch: 0 }, account = { ...actor, admin: true, disabled: false, groupId: 'admins', email: '', createdAt: 0, updatedAt: 0 }
    const groups = [{ id: 'admins', name: 'Admins', kind: 'admin' as const, isDefault: false, memberCount: 1 }, { id: 'team', name: 'Team', kind: 'ordinary' as const, isDefault: true, memberCount: 0 }]
    const accounts = { get: () => account, list: () => [account], listGroups: () => groups }
    let row: LibrarySkill = { name: 'guide', description: 'Guide', hash: 'same-content', importedAt: 0, published: false, contributionReceipt: { id: 'earlier', revision: 'earlier-revision' } }, fail = false
    const store = { list: () => [row], save: (next: LibrarySkill) => { if (fail && next.contributionDistributionReceipt) { fail = false; throw Error('final receipt interrupted') }; row = structuredClone(next) }, remove: () => {} }
    let grants = new FileSkillAssignments(join(root, 'grants.json'))
    const selections = new FileSkillAssignments(join(root, 'selections.json'))
    const make = () => {
      const membership = new SkillMembership(accounts, store, grants, selections, new MemberEffectiveSkills(accounts, store, grants, selections), { synchronize: async () => {} })
      return new SkillLibrary(accounts, store, { accept: async () => ({ ...row, markdown: '', files: [] }), read: async () => ({ markdown: '', files: [] }), collect: async () => {}, newToken: () => 'preview' }, { now: () => 0 }, membership)
    }
    const contribution = { name: row.name, description: row.description, hash: row.hash, id: 'current', revision: 'revision', contributor: actor, declaration: { purpose: 'Update declaration' }, markdown: '', files: [], submittedAt: 1, updatedAt: 1, status: 'pending' as const }
    const pending = memoryContributions(); pending.save(contribution); pending.begin({ id: contribution.id, revision: contribution.revision, actor, hash: row.hash })
    const service = new MemberContributions(accounts, pending, { accept: async () => contribution, read: async () => new Uint8Array(), collect: async () => {}, newId: () => 'new' }, make(), { now: () => 1 })
    await service.recover(); expect(service.list(actor)[0]?.status).toBe('pending'); expect(pending.intent()).toBeUndefined()
    row = { ...row, contributionReceipt: { id: contribution.id, revision: contribution.revision } }
    fail = true
    const setup = { published: true, groups: [{ id: 'team', revision: 'review' }] }
    await expect(make().distributeContribution(contribution, setup)).rejects.toThrow('final receipt interrupted')
    expect(row.published).toBe(true); expect(grants.get('team')).toEqual(['guide'])
    grants.set('team', []); row = { ...row, published: false }
    grants = new FileSkillAssignments(join(root, 'grants.json'))
    expect(await make().distributeContribution(contribution, setup)).toEqual([])
    expect(row.published).toBe(false); expect(grants.get('team')).toEqual([])
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('retains newer execution settings when they change before confirmation or while the library is being adopted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'execution-contribution-review-race-'))
  try {
    const actor = { username: 'admin', spaceId: 'space', sessionEpoch: 0 }, accounts = { get: () => ({ ...actor, admin: true, disabled: false, groupId: 'admins', email: '', createdAt: 0, updatedAt: 0 }) }
    const path = join(root, 'execution.json'), store = new FileExecutionConfigurations(path)
    const make = (store: FileExecutionConfigurations) => new ExecutionAdministration(accounts, { get: id => ({ id, version: 'skill-version' }), owns: () => true }, store, async () => {})
    let service = make(store)
    const row = { name: 'guide', description: 'Guide', hash: 'artifact', id: 'id', revision: 'revision', contributor: actor, declaration: { purpose: 'Update guide' }, markdown: '', files: [], submittedAt: 1, updatedAt: 1, status: 'pending' as const }
    const first = { enabled: true, commands: [{ command: 'first', blocked: [] }], variables: [{ name: 'VALUE', secret: false, value: 'first' }, { name: 'KEY', secret: true, value: 'first-platform-fixture-secret' }] }
    await service.save(actor, 'skill:guide', first)
    let revision = service.contributionRevision(row.name)
    const draft = service.contributionPreview(row.name, row.declaration)
    const newer = { ...first, commands: [{ command: 'newer', blocked: [] }], variables: [{ name: 'VALUE', secret: false, value: 'newer' }, { name: 'KEY', secret: true, value: 'newer-platform-fixture-secret' }] }
    await service.save(actor, 'skill:guide', newer)
    expect(() => service.checkAdoption(row, draft, revision)).toThrow(expect.objectContaining({ code: 'skill-preview-changed' }))
    revision = service.contributionRevision(row.name); service.checkAdoption(row, service.contributionPreview(row.name, row.declaration), revision)
    await service.save(actor, 'skill:guide', { ...newer, commands: [{ command: 'latest', blocked: [] }] })
    const warnings = await service.adoptContribution(row, draft, revision)
    expect(warnings).toHaveLength(1); expect(store.get('skill:guide')?.commands[0]?.command).toBe('latest')
    expect(store.get('skill:guide')?.variables.find(row => row.name === 'KEY')?.value).toBe('newer-platform-fixture-secret')
    const reloaded = new FileExecutionConfigurations(path); service = make(reloaded)
    expect(await service.adoptContribution(row, draft, revision)).toEqual(warnings)
    expect(reloaded.get('skill:guide')?.commands[0]?.command).toBe('latest')
  } finally { await rm(root, { recursive: true, force: true }) }
})
