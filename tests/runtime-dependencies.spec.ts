import { expect, it } from 'vitest'
import { RuntimeDependencies } from '../src/use-cases/runtime-dependencies.js'
import type { RuntimeDependency, RuntimeDependencyVersion, RuntimeDependencyReference } from '../src/domain/runtime-dependency.js'
import { RuntimeDependencyPreparationFailure } from '../src/domain/runtime-dependency.js'

const actor = { username: 'admin', spaceId: 'a', sessionEpoch: 0 }
const input = { name: 'office', prepareCommand: 'install-pinned', pathDirectories: ['bin'], checkCommand: 'office --version' }
function fixture() {
  const rows = new Map<string, RuntimeDependency>()
  let administrator = true, calls = 0, failure = false
  const references: RuntimeDependencyReference[] = []
  const service = new RuntimeDependencies({ get: () => ({ ...actor, admin: administrator, disabled: false, groupId: 'admin', email: '', createdAt: 0, updatedAt: 0 }) },
    { list: () => structuredClone([...rows.values()]), save: row => { rows.set(row.name, structuredClone(row)) }, remove: name => { rows.delete(name) } },
    { isolated: true, recover: async () => {}, identity: definition => definition.prepareCommand, collect: async () => {},
      prepare: async (definition, log) => {
        calls++; await log('complete preparation output\n')
        if (failure) throw new RuntimeDependencyPreparationFailure('check-failed', 'check exited 1')
        return { id: `version-${calls}`, identity: definition.prepareCommand, directory: '/private/artifact', mountedPath: '/fixed/artifact', commands: ['office'], pathDirectories: definition.pathDirectories, bytes: 42, isolated: true, checks: [{ kind: 'check-command', passed: true }], log: 'complete preparation output\n' } satisfies RuntimeDependencyVersion
      } }, { now: () => 100 }, { list: () => references })
  return { service, rows, references, get calls() { return calls }, fail() { failure = true }, demote() { administrator = false } }
}

it('creates a credential-free dependency, preserves complete logs, and rejects non-admin access and secret inputs', async () => {
  const f = fixture(); f.service.create(actor, input)
  await f.service.prepare(actor, 'office')
  expect(f.calls).toBe(1)
  expect(f.service.view(actor, 'office')).toMatchObject({ stage: 'ready', current: { bytes: 42 }, log: 'complete preparation output\n' })
  expect(() => f.service.create(actor, input)).toThrow(expect.objectContaining({ code: 'runtime-dependency-name-conflict' }))
  expect(() => f.service.create(actor, { ...input, name: 'bad', variables: [{ name: 'KEY', secret: true, value: 'private' }] } as never)).toThrow(expect.objectContaining({ code: 'runtime-dependency-invalid' }))
  expect([...f.rows.keys()]).toEqual(['office'])
  f.demote(); expect(() => f.service.list(actor)).toThrow(expect.objectContaining({ code: 'admin-required' }))
})

it('rejects a second dependency exposing the same command and retains failed entries for retry', async () => {
  const f = fixture(); f.service.create(actor, input); await f.service.prepare(actor, 'office')
  f.service.create(actor, { ...input, name: 'other' }); await f.service.prepare(actor, 'other')
  expect(f.service.view(actor, 'other')).toMatchObject({ stage: 'failed', failureCode: 'command-conflict' })
  expect(f.service.view(actor, 'other').log).toContain('office')
  expect(f.service.view(actor, 'office').stage).toBe('ready')
})

it('blocks referenced deletion with reference details and keeps the usable version when a manual preparation fails', async () => {
  const f = fixture(); f.service.create(actor, input); await f.service.prepare(actor, 'office')
  f.references.push({ kind: 'skill', name: 'reports' })
  await expect(f.service.remove(actor, 'office')).rejects.toMatchObject({ code: 'runtime-dependency-referenced' })
  expect(f.service.view(actor, 'office').references).toEqual(f.references)
  f.fail(); await f.service.prepare(actor, 'office')
  expect(f.service.view(actor, 'office')).toMatchObject({ stage: 'failed', failureCode: 'check-failed', current: { id: 'version-1' } })
  f.references.length = 0; await f.service.remove(actor, 'office'); expect(f.service.list(actor)).toEqual([])
})
