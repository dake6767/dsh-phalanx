import { expect, it } from 'vitest'
import { CommunitySystemUpdate } from '../src/use-cases/community-system-update.js'

it('requires fresh administrator identity before reading system update status or logs', async () => {
  const actor = { username: 'admin', spaceId: 'admin-space', sessionEpoch: 0 }
  let account = { ...actor, email: '', admin: true, disabled: false, createdAt: 0, updatedAt: 0 }
  const calls: string[] = []
  const status = { currentVersion: 'v0.1.2', runningVersion: 'v0.1.2', operation: null, events: [] }
  const service = new CommunitySystemUpdate({ get: () => account }, {
    status: async () => { calls.push('status'); return status },
    check: async () => { throw new Error('not requested') },
    prepare: async () => { throw new Error('not requested') },
    apply: async () => { throw new Error('not requested') },
  })
  expect(await service.status(actor)).toEqual(status)
  account = { ...account, admin: false }
  await expect(service.status(actor)).rejects.toThrow('Administrator')
  account = { ...account, admin: true, sessionEpoch: 1 }
  await expect(service.status(actor)).rejects.toThrow('Sign in')
  account = { ...account, sessionEpoch: 0, disabled: true }
  await expect(service.status(actor)).rejects.toThrow('Sign in')
  expect(calls).toEqual(['status'])
})

it('selects formal targets and requires explicit interruption consent without waiting for activity', async () => {
  const actor = { username: 'admin', spaceId: 'admin-space', sessionEpoch: 0 }
  const account = { ...actor, email: '', admin: true, disabled: false, createdAt: 0, updatedAt: 0 }
  const operation = { id: '11111111-1111-4111-8111-111111111111', phase: 'prepared' as const,
    targetVersion: '0.1.4', sourceVersion: '0.1.2', targetCommit: 'a'.repeat(40), platformSha256: 'b'.repeat(64), imageDigest: `sha256:${'c'.repeat(64)}` }
  const calls: unknown[] = []
  const service = new CommunitySystemUpdate({ get: () => account }, {
    status: async () => ({ currentVersion: 'v0.1.2', runningVersion: 'v0.1.2', operation, events: [] }),
    check: async () => ({ currentVersion: 'v0.1.2', runningVersion: 'v0.1.2', operation, events: [],
      check: { status: 'available', checkedAt: '2026-10-05T12:00:00Z', version: 'v0.1.4', manifestSha256: 'd'.repeat(64), releaseNotes: 'Compatible update' } }),
    prepare: async (...input) => { calls.push(input); return { operation } },
    apply: async identity => { calls.push(identity); return { operation: { ...operation, phase: 'stopping' } } },
  })
  expect((await service.execute(actor, { action: 'check' })).check.status).toBe('available')
  await expect(service.execute(actor, { action: 'prepare', version: 'v0.1.4-rc.1', manifestSha256: 'd'.repeat(64) })).rejects.toThrow('formal')
  await expect(service.execute(actor, { action: 'prepare', version: 'https://untrusted.example.test', manifestSha256: 'd'.repeat(64) })).rejects.toThrow('formal')
  await expect(service.execute(actor, { action: 'apply', operation: operation.id, confirmed: false } as never)).rejects.toThrow('Confirm')
  await expect(service.execute(actor, { action: 'apply', operation: 'arbitrary command', confirmed: true })).rejects.toThrow('operation')
  expect(calls).toEqual([])
  expect((await service.execute(actor, { action: 'prepare', version: 'v0.1.4', manifestSha256: 'd'.repeat(64) })).operation.phase).toBe('prepared')
  expect((await service.execute(actor, { action: 'apply', operation: operation.id, confirmed: true })).operation.phase).toBe('stopping')
  expect(calls).toEqual([['v0.1.4', 'd'.repeat(64)], operation.id])
})
