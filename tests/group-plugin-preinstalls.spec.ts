import { expect, it } from 'vitest'
import { GroupPluginPreinstalls } from '../src/use-cases/group-plugin-preinstalls.js'
import type { PluginInstallation } from '../src/ports/plugin-installations.js'

function setup() {
  const alice = { username: 'alice', spaceId: 'a', sessionEpoch: 0, groupId: 'members', disabled: false, email: '', admin: false, createdAt: 0, updatedAt: 0 }
  const bob = { ...alice, username: 'bob', spaceId: 'b' },
    accounts = [alice, bob]
  const plugin = {
    packageName: 'one',
    version: '1.0.0',
    integrity: 'sha512-fixture',
    artifact: 'artifacts/fixture',
    runtimeRevision: 'revision',
    title: '',
    description: '',
    bundlePatch: '[]',
    dependencies: {},
  }
  let configured = ['one', 'two']
  const records = new Map<string, PluginInstallation[]>()
  const policy = new GroupPluginPreinstalls(
    {
      get: async name => accounts.find(row => row.username === name),
      list: async () => accounts,
      listGroups: async () => [{ id: 'members', name: 'Members', kind: 'ordinary', isDefault: true, memberCount: 2 }],
    },
    { list: async () => [{ ...plugin, current: plugin, stage: 'available', published: false }] },
    { preinstalls: async () => configured },
    { get: async space => records.get(space) ?? [] },
    'revision',
  )
  return {
    policy,
    plugin,
    alice,
    bob,
    records,
    configure: (value: string[]) => {
      configured = value
    },
  }
}

it('captures checked bytes and rejects a changed artifact, group or account identity before background delivery', async () => {
  const f = setup(),
    plan = (await f.policy.plan('alice', []))!
  expect(await f.policy.current(plan, plan.plugins[0]!)).toBe(true)
  f.plugin.integrity = 'sha512-new'
  expect(plan.plugins[0]?.integrity).toBe('sha512-fixture')
  expect(await f.policy.current(plan, plan.plugins[0]!)).toBe(false)
  f.plugin.integrity = 'sha512-fixture'
  f.alice.groupId = 'other'
  expect(await f.policy.current(plan, plan.plugins[0]!)).toBe(false)
  f.alice.groupId = 'members'
  f.alice.sessionEpoch++
  expect(await f.policy.current(plan, plan.plugins[0]!)).toBe(false)
  f.alice.sessionEpoch = 0
  f.alice.spaceId = 'replacement'
  expect(await f.policy.current(plan, plan.plugins[0]!)).toBe(false)
})

it('counts eligible members once across failed packages, excludes retired spaces, and preserves selected delivery protection', async () => {
  const f = setup(),
    failures = new Map([
      ['a', new Set(['one', 'two'])],
      ['b', new Set(['one'])],
      ['retired', new Set(['one'])],
    ])
  expect(await f.policy.incompleteMembers('members', failures)).toBe(2)
  f.records.set('a', [{ packageName: 'one', source: 'selected', version: '1.0.0' }])
  expect(await f.policy.incompleteMembers('members', failures)).toBe(2)
  f.configure(['one'])
  expect(await f.policy.incompleteMembers('members', failures)).toBe(1)
  f.bob.disabled = true
  expect(await f.policy.incompleteMembers('members', failures)).toBe(0)
})
