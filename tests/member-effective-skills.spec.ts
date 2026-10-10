import { expect, it } from 'vitest'
import { MemberEffectiveSkills } from '../src/use-cases/member-effective-skills.js'
import type { LibrarySkill } from '../src/domain/skill-library.js'

it('selects current skills by group and publication, with managed precedence and no conflicts', () => {
  let groupId = 'members', disabled = false, selected = ['public-skill', 'private-skill'], granted = ['team-skill', 'public-skill', 'conflict']
  let rows: LibrarySkill[] = ['team-skill', 'public-skill', 'private-skill', 'conflict'].map(name => ({ name, description: name, hash: 'v1', importedAt: 0, published: name === 'public-skill', conflict: name === 'conflict' }))
  const service = new MemberEffectiveSkills({ get: username => username === 'member' ? { username, spaceId: 'space', sessionEpoch: 0, email: '', admin: false, groupId, disabled, createdAt: 0, updatedAt: 0 } : undefined,
    listGroups: () => [{ id: 'members', name: 'Members', kind: 'ordinary', memberCount: 1, isDefault: true }, { id: 'admins', name: 'Admins', kind: 'admin', memberCount: 1, isDefault: false }] },
  { list: () => rows }, { get: () => granted }, { get: id => id === 'space' ? selected : [] })
  const effective = () => service.effective('member').map(({ skill, source }) => [skill.name, skill.hash, source])
  expect(effective()).toEqual([['public-skill', 'v1', 'managed'], ['team-skill', 'v1', 'managed']])
  granted = ['team-skill']; expect(effective()).toEqual([['public-skill', 'v1', 'selected'], ['team-skill', 'v1', 'managed']])
  rows = rows.map(row => ({ ...row, hash: 'v2', published: false })); expect(effective()).toEqual([['team-skill', 'v2', 'managed']])
  rows = rows.filter(row => row.name !== 'team-skill'); expect(effective()).toEqual([])
  selected = []; granted = []; groupId = 'admins'
  expect(effective()).toEqual([['private-skill', 'v2', 'managed'], ['public-skill', 'v2', 'managed']])
  disabled = true; expect(effective()).toEqual([])
  disabled = false; groupId = 'deleted'; expect(effective()).toEqual([])
  expect(service.effective('missing')).toEqual([])
})
