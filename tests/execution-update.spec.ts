import { expect, it } from 'vitest'
import { ExecutionAdministration } from '../src/use-cases/execution-administration.js'
import { PlatformExecution } from '../src/use-cases/platform-execution.js'
import type { ExecutionConfiguration } from '../src/domain/platform-execution.js'

it.each(['scripts/query.py', './query.sh'])('prefills unsaved settings only, preserves configured credentials on update and rejects a removed script before execution (%s)', async command => {
  const actor = { username: 'admin', spaceId: 'admin-space', sessionEpoch: 0 }
  const account = { ...actor, admin: true, disabled: false, groupId: 'admin', email: '', createdAt: 0, updatedAt: 0 }
  let version = 'v1', configuration: ExecutionConfiguration | undefined, runs = 0
  const owners = { get: (id: string) => ({ id, version }), owns: () => true }
  const store = { get: () => configuration, list: () => configuration ? [{ owner: 'skill:example', configuration }] : [], save: (_owner: string, value: ExecutionConfiguration) => { configuration = value } }
  const inspection = { inspect: async () => ({ commands: [command], variables: ['API_KEY'], prepare: 'sh setup.sh' }), available: async () => version === 'v1' }
  const administration = new ExecutionAdministration({ get: () => account }, owners, store, async () => {}, undefined, inspection)
  expect(await administration.view(actor, 'skill:example')).toMatchObject({ enabled: false, commands: [{ command: command, blocked: [] }], variables: [{ name: 'API_KEY', secret: true, configured: false }] })
  expect(configuration).toBeUndefined()
  await administration.save(actor, 'skill:example', { enabled: true, commands: [{ command: command, blocked: [] }], variables: [{ name: 'API_KEY', secret: true, value: 'saved-secret' }] })
  version = 'v2'
  expect(await administration.view(actor, 'skill:example')).toMatchObject({ enabled: true, unavailableCommands: [command], variables: [{ name: 'API_KEY', secret: true, configured: true }] })
  expect(configuration!.variables[0]!.value).toBe('saved-secret')
  const execution = new PlatformExecution(owners, store, { run: async () => { runs++; return 0 } }, undefined, inspection)
  await expect(execution.execute({ username: 'admin', owner: 'skill:example', command: command, argv: [], cwd: '/workspace', stdin: new Uint8Array() }, async () => {}, new AbortController().signal)).rejects.toMatchObject({ code: 'command-missing' })
  expect(runs).toBe(0)
})
