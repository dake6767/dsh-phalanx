import { expect, it } from 'vitest'
import { SkillExecutionOwners } from '../src/use-cases/skill-execution-owners.js'
import { MemberEffectiveSkills } from '../src/use-cases/member-effective-skills.js'

it('derives invocation eligibility and only non-secret forwarders from current direct grants, market selections and administrator membership', () => {
  let account = { username: 'member', spaceId: 'space', sessionEpoch: 0, admin: false, disabled: false, groupId: 'ordinary', email: '', createdAt: 0, updatedAt: 0 }
  let skill = { name: 'news', description: 'News', hash: 'v1', importedAt: 0, published: false, conflict: false }
  let grants: string[] = [], selections: string[] = [], enabled = true
  const accounts = { get: () => account, list: () => [account], listGroups: () => [{ id: 'ordinary', name: 'Members', memberCount: 1, kind: 'ordinary' as const, isDefault: true }, { id: 'admin', name: 'Admins', memberCount: 0, kind: 'admin' as const, isDefault: false }] }
  const library = { list: () => [skill] }
  const effective = new MemberEffectiveSkills(accounts, library, { get: () => grants }, { get: () => selections })
  const owners = new SkillExecutionOwners(library, effective, accounts, { get: () => ({ enabled, commands: [{ command: 'news-cli', blocked: [] }], variables: [{ name: 'KEY', value: 'never-in-projection', secret: true }] }) })
  expect(owners.owns('member', 'skill:news')).toBe(false)
  grants = ['news']; expect(owners.owns('member', 'skill:news')).toBe(true)
  expect(owners.commands('space')).toEqual([{ owner: 'skill:news', skill: 'news', command: 'news-cli' }])
  grants = []; selections = ['news']; expect(owners.owns('member', 'skill:news')).toBe(false)
  skill = { ...skill, published: true }; expect(owners.owns('member', 'skill:news')).toBe(true)
  enabled = false; expect(owners.commands('space')).toEqual([])
  account = { ...account, groupId: 'admin', admin: true }; selections = []; expect(owners.owns('member', 'skill:news')).toBe(true)
  account = { ...account, disabled: true }; expect(owners.owns('member', 'skill:news')).toBe(false); expect(owners.commands('space')).toEqual([])
  skill = { ...skill, conflict: true }; expect(owners.get('skill:news')).toBeUndefined()
})

it('projects the selected contribution receipt as the execution preparation approval requirement', () => {
  const skill = { name: 'news', description: '', hash: 'same-bytes', importedAt: 0, published: false, contributionReceipt: { id: 'new', revision: 'declaration-update' } }
  const owners = new SkillExecutionOwners({ list: () => [skill] }, {} as MemberEffectiveSkills, { list: () => [] }, { get: () => undefined })
  expect(owners.get('skill:news')).toEqual({ id: 'skill:news', version: 'same-bytes', preparationApproval: '["new","declaration-update"]' })
})
