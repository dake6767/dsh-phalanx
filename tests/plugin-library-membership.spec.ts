import { expect, it } from 'vitest'
import { PluginLibraryMembership } from '../src/use-cases/plugin-library-membership.js'
it('counts explicit grants and member selections for both group roles and clears only the removed package', async () => {
  const values = new Map([
    ['ordinary', ['plugin', 'other']],
    ['untouched', ['other']],
  ])
  const preinstalls = new Map([['untouched', ['plugin', 'native-other']]])
  const selected = new Map([
    ['b', ['plugin']],
    ['c', ['plugin']],
  ])
  const membership = new PluginLibraryMembership(
    {
      listGroups: async () => [
        { id: 'admin', kind: 'admin', name: 'Administrators', isDefault: false, memberCount: 1 },
        { id: 'ordinary', kind: 'ordinary', name: 'Ordinary', isDefault: true, memberCount: 1 },
        { id: 'untouched', kind: 'ordinary', name: 'Other', isDefault: false, memberCount: 0 },
      ],
      list: async () => [
        { username: 'admin', spaceId: 'a', groupId: 'admin', admin: true, disabled: false, sessionEpoch: 0, email: '', createdAt: 0, updatedAt: 0 },
        { username: 'member', spaceId: 'b', groupId: 'ordinary', admin: false, disabled: false, sessionEpoch: 0, email: '', createdAt: 0, updatedAt: 0 },
        { username: 'chooser', spaceId: 'c', groupId: 'untouched', admin: false, disabled: false, sessionEpoch: 0, email: '', createdAt: 0, updatedAt: 0 },
      ],
    },
    {
      get: async id => values.get(id) ?? [],
      preinstalls: async id => preinstalls.get(id) ?? [],
      configure: async (id, controlled, native) => {
        values.set(id, [...controlled])
        preinstalls.set(id, [...native])
      },
      set: async (id, names) => {
        values.set(id, [...names])
      },
      remove: async () => {},
      retainGroups: async () => {},
    },
    {
      get: async id => selected.get(id) ?? [],
      set: async () => {},
      members: async name => [...selected].filter(([, names]) => names.includes(name)).map(([id]) => id),
      removePackage: async name => {
        for (const [id, names] of selected)
          selected.set(
            id,
            names.filter(value => value !== name),
          )
      },
      retainPackages: async () => {},
    },
  )
  expect(await membership.impact('plugin')).toEqual({ groups: 2, members: 2, selectedMembers: 2 })
  values.set('admin', ['plugin'])
  expect(await membership.impact('plugin')).toEqual({ groups: 3, members: 3, selectedMembers: 2 })
  await membership.revoke('plugin')
  expect(preinstalls.get('untouched')).toEqual(['native-other'])
  expect(values.get('ordinary')).toEqual(['other'])
  expect(values.get('untouched')).toEqual(['other'])
  expect(await membership.impact('plugin')).toEqual({ groups: 0, members: 0, selectedMembers: 0 })
})
