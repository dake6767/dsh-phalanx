import { expect, it } from 'vitest'
import { RuntimeDependencyConsumers } from '../src/use-cases/runtime-dependency-consumers.js'
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
  const dependencies = new MemberRuntimeDependencies(accounts, effective, { ready: names => names.map(name => ({ id: name, identity: name, directory: '/host/' + name, mountedPath: '/fixed/' + name, pathDirectories: ['bin'], commands: [name], commandPaths: { [name]: 'bin/' + name }, bytes: 1, isolated: true, checks: [], log: '' })) })
  const names = () => dependencies.versions('space').map(row => row.id)
  expect(names()).toEqual(['pack-cli', 'public-cli', 'shared', 'team-cli'])
  expect(new RuntimeDependencyConsumers(store, { list: () => [] }).list('shared')).toEqual([{ kind: 'skill', name: 'team' }, { kind: 'skill', name: 'public' }])
  // Personal skill names are intentionally absent from eligibility: an overridden skill is still owned.
  granted = []; packGranted = []; packSelected = ['bundle']; expect(names()).toEqual(['pack-cli', 'public-cli', 'shared'])
  selected = []; expect(names()).toEqual(['pack-cli'])
  rows.splice(2, 1); expect(names()).toEqual([])
  granted = ['team']; disabled = true; expect(names()).toEqual([])
  expect(dependencies.versions('unknown')).toEqual([])
})

it('freezes one skill-plugin-MCP union from the observed inventory and deduplicates shared versions', () => {
  const account = { username: 'member', spaceId: 'space', sessionEpoch: 0, email: '', admin: false, groupId: 'members', disabled: false, createdAt: 0, updatedAt: 0 }
  const effective = new MemberEffectiveSkills({ get: () => account, listGroups: () => [] }, { list: () => [] }, { get: () => [] }, { get: () => [] })
  const version = (name: string) => ({ id: name, identity: name, directory: '/host/' + name, mountedPath: '/fixed/' + name, pathDirectories: [], commands: [], commandPaths: {}, bytes: 1, isolated: true, checks: [], log: '' })
  const dependencies = new MemberRuntimeDependencies({ list: () => [account] }, effective, { ready: names => names.map(version) }, undefined, undefined, () => [version('sdk')], (_username, installed) => installed.includes('office') ? ['sdk', 'other'] : [])
  const plan = dependencies.plan('space', ['office'])
  expect(plan.versions.map(row => row.id)).toEqual(['other', 'sdk'])
  expect(plan.bindings.sdk?.mountedPath).toBe('/fixed/sdk')
  expect(dependencies.plan('space', []).bindings).toEqual({})
  expect(dependencies.versions('space').map(row => row.id)).toEqual(['sdk'])
  account.disabled = true; expect(dependencies.plan('space', ['office'])).toEqual({ versions: [], bindings: {} })
})
