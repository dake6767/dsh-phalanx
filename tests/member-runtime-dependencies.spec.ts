import { expect, it } from 'vitest'
import { MemberRuntimeDependencies } from '../src/use-cases/member-runtime-dependencies.js'
import { MemberEffectiveSkills } from '../src/use-cases/member-effective-skills.js'
import type { LibrarySkill } from '../src/domain/skill-library.js'
it('unions owned skill dependencies across direct grants, packs and selections independently of member shadowing', () => {
  let granted = ['team'], selected = ['public'], packGranted = ['bundle'], packSelected: string[] = [], disabled = false
  const rows: LibrarySkill[] = [
    { name: 'team', description: 'Team', hash: 'a', importedAt: 0, published: false, runtimeDependencies: ['shared', 'team-cli'] },
    { name: 'public', description: 'Public', hash: 'b', importedAt: 0, published: true, runtimeDependencies: ['shared', 'public-cli'] },
    { name: 'packed', description: 'Packed', hash: 'c', importedAt: 0, published: false, runtimeDependencies: ['pack-cli'] },
  ]
  const account = () => ({ username: 'member', spaceId: 'space', sessionEpoch: 0, email: '', admin: false, groupId: 'members', disabled, createdAt: 0, updatedAt: 0 })
  const accounts = { get: () => account(), list: () => [account()], listGroups: () => [{ id: 'members', name: 'Members', kind: 'ordinary' as const, memberCount: 1, isDefault: true }] }
  const store = { list: () => rows }
  const effective = new MemberEffectiveSkills(accounts, store, { get: () => granted }, { get: () => selected }, { store: { list: () => [{ name: 'bundle', description: 'Bundle', skills: ['packed'], instructions: '', published: true }] }, grants: { get: () => packGranted }, selections: { get: () => packSelected } })
  const dependencies = new MemberRuntimeDependencies(accounts, store, effective, { ready: names => names.map(name => ({ id: name, identity: name, directory: '/host/' + name, mountedPath: '/fixed/' + name, pathDirectories: ['bin'], commands: [name], commandPaths: { [name]: 'bin/' + name }, bytes: 1, isolated: true, checks: [], log: '' })) })
  const names = () => dependencies.versions('space').map(row => row.id)
  expect(names()).toEqual(['pack-cli', 'public-cli', 'shared', 'team-cli'])
  expect(dependencies.list('shared')).toEqual([{ kind: 'skill', name: 'team' }, { kind: 'skill', name: 'public' }])
  // Personal skill names are intentionally absent from eligibility: an overridden skill is still owned.
  granted = []; packGranted = []; packSelected = ['bundle']; expect(names()).toEqual(['pack-cli', 'public-cli', 'shared'])
  selected = []; expect(names()).toEqual(['pack-cli'])
  rows.splice(2, 1); expect(names()).toEqual([])
  granted = ['team']; disabled = true; expect(names()).toEqual([])
  expect(dependencies.versions('unknown')).toEqual([])
})
