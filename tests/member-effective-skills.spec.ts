import { expect, it } from 'vitest'
import { MemberEffectiveSkills } from '../src/use-cases/member-effective-skills.js'
import type { LibrarySkill } from '../src/domain/skill-library.js'

it('selects current skills by group and publication, with managed precedence and no conflicts', async () => {
  let groupId = 'members',
    disabled = false,
    selected = ['public-skill', 'private-skill'],
    granted = ['team-skill', 'public-skill', 'conflict']
  let rows: LibrarySkill[] = ['team-skill', 'public-skill', 'private-skill', 'conflict'].map(name => ({
    name,
    description: name,
    hash: 'v1',
    importedAt: 0,
    published: name === 'public-skill',
    conflict: name === 'conflict',
  }))
  const service = new MemberEffectiveSkills(
    {
      get: async username =>
        username === 'member'
          ? { username, spaceId: 'space', sessionEpoch: 0, email: '', admin: false, groupId, disabled, createdAt: 0, updatedAt: 0 }
          : undefined,
      listGroups: async () => [
        { id: 'members', name: 'Members', kind: 'ordinary', memberCount: 1, isDefault: true },
        { id: 'admins', name: 'Admins', kind: 'admin', memberCount: 1, isDefault: false },
      ],
    },
    { list: () => rows },
    { get: () => granted },
    { get: id => (id === 'space' ? selected : []) },
  )
  const effective = async () => (await service.effective('member')).map(({ skill, source }) => [skill.name, skill.hash, source])
  expect(await effective()).toEqual([
    ['public-skill', 'v1', 'managed'],
    ['team-skill', 'v1', 'managed'],
  ])
  granted = ['team-skill']
  expect(await effective()).toEqual([
    ['public-skill', 'v1', 'selected'],
    ['team-skill', 'v1', 'managed'],
  ])
  rows = rows.map(row => ({ ...row, hash: 'v2', published: false }))
  expect(await effective()).toEqual([['team-skill', 'v2', 'managed']])
  rows = rows.filter(row => row.name !== 'team-skill')
  expect(await effective()).toEqual([])
  selected = []
  granted = []
  groupId = 'admins'
  expect(await effective()).toEqual([])
  granted = ['private-skill']
  expect(await effective()).toEqual([['private-skill', 'v2', 'managed']])
  disabled = true
  expect(await effective()).toEqual([])
  disabled = false
  groupId = 'deleted'
  expect(await effective()).toEqual([])
  expect(await service.effective('missing')).toEqual([])
})

it('expands granted and selected packs, deduplicates with managed precedence and hides empty pack notes', async () => {
  let admin = false
  const skill = (name: string) => ({ name, description: name, hash: name, importedAt: 0, published: false })
  const rows = ['direct', 'shared', 'extra'].map(skill)
  const packs = {
    store: {
      list: () => [
        { name: 'team', description: 'Team', skills: ['shared'], instructions: 'Use shared', published: false, note: skill('team') },
        { name: 'choice', description: 'Choice', skills: ['shared', 'extra'], instructions: 'Use both', published: true, note: skill('choice') },
        { name: 'empty', description: 'Empty', skills: [], instructions: 'No children', published: true, note: skill('empty') },
      ],
    },
    grants: { get: () => ['team'] },
    selections: { get: () => ['choice', 'empty'] },
  }
  const service = new MemberEffectiveSkills(
    {
      get: async () => ({
        username: 'member',
        spaceId: 'space',
        sessionEpoch: 0,
        email: '',
        admin,
        groupId: 'group',
        disabled: false,
        createdAt: 0,
        updatedAt: 0,
      }),
      listGroups: async () => [{ id: 'group', name: 'Group', kind: admin ? 'admin' : 'ordinary', memberCount: 1, isDefault: true }],
    },
    { list: () => rows },
    { get: () => ['direct'] },
    { get: () => [] },
    packs,
  )
  const effective = async () => (await service.effective('member')).map(row => [row.skill.name, row.source])
  expect(await effective()).toEqual([
    ['choice', 'selected'],
    ['direct', 'managed'],
    ['extra', 'selected'],
    ['shared', 'managed'],
    ['team', 'managed'],
  ])
  rows.splice(1, 1)
  expect(await effective()).toEqual([
    ['choice', 'selected'],
    ['direct', 'managed'],
    ['extra', 'selected'],
  ])
  admin = true
  expect(await effective()).toEqual([
    ['choice', 'selected'],
    ['direct', 'managed'],
    ['extra', 'selected'],
  ])
})
