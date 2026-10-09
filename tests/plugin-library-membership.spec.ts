import { expect, it } from 'vitest'
import { PluginLibraryMembership } from '../src/use-cases/plugin-library-membership.js'
it('counts implicit administrators and explicitly granted groups and clears only the removed package', () => {
  const values = new Map([['ordinary', ['plugin', 'other']], ['untouched', ['other']]])
  const membership = new PluginLibraryMembership({ listGroups: () => [
    { id: 'admin', kind: 'admin', name: 'Administrators', isDefault: false, memberCount: 1 },
    { id: 'ordinary', kind: 'ordinary', name: 'Ordinary', isDefault: true, memberCount: 1 },
    { id: 'untouched', kind: 'ordinary', name: 'Other', isDefault: false, memberCount: 0 },
  ], list: () => [
    { username: 'admin', spaceId: 'a', groupId: 'admin', admin: true, disabled: false, sessionEpoch: 0, email: '', createdAt: 0, updatedAt: 0 },
    { username: 'member', spaceId: 'b', groupId: 'ordinary', admin: false, disabled: false, sessionEpoch: 0, email: '', createdAt: 0, updatedAt: 0 },
  ] }, { get: id => values.get(id) ?? [], set: (id, names) => { values.set(id, [...names]) }, remove: () => {}, retainGroups: () => {} })
  expect(membership.impact('plugin')).toEqual({ groups: 2, members: 2 })
  membership.revoke('plugin')
  expect(values.get('ordinary')).toEqual(['other']); expect(values.get('untouched')).toEqual(['other'])
  expect(membership.impact('plugin')).toEqual({ groups: 1, members: 1 })
})
