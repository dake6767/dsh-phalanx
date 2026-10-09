import { expect, it } from 'vitest'
import { CommunityEnvironmentRecovery } from '../src/use-cases/community-environment-recovery.js'
import type { CommunityAccountRecord } from '../src/domain/community-account.js'

const actor = { username: 'admin', spaceId: 'admin-space', sessionEpoch: 0 }
const admin: CommunityAccountRecord = { ...actor, admin: true, groupId: 'admin', disabled: false, email: '', createdAt: 0, updatedAt: 0 }
const target: CommunityAccountRecord = { username: 'alice', spaceId: 'alice-space', sessionEpoch: 0, disabled: false, admin: false, groupId: 'default', email: '', createdAt: 0, updatedAt: 0 }
it('stops only the target, completes a private backup before resetting, starts one replacement and coalesces duplicate admin resets', async () => {
  const events: string[] = []; let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const backup = { id: 'backup-1', location: '/private/environment-backups/alice-space/backup-1', restoreInstructions: 'Stop the service and target carrier; follow README.txt.' }
  const recovery = new CommunityEnvironmentRecovery({ get: user => user === 'admin' ? admin : user === 'alice' ? target : undefined }, {
    recover: async (user, _origin, prepare) => { events.push(`stop:${user}`); await prepare(); events.push(`start:${user}`); return { userId: user, processId: 1, origin: 'http://127.0.0.1:4101', launchUrl: 'http://127.0.0.1:4101/launch' } },
  }, { backup: async (user, space) => { events.push(`backup:${user}:${space}`); await gate; return backup },
    reset: async (_user, _space, saved) => { expect(saved).toEqual(backup); events.push('reset:alice') } },
  { closeUser: async user => { events.push(`close:${user}`) } })
  const a = recovery.reset(actor, 'alice', new URL('https://community.example'))
  const b = recovery.reset(actor, 'alice', new URL('https://community.example'))
  release(); expect(await a).toEqual(await b)
  expect(await a).toEqual({ username: 'alice', spaceId: 'alice-space', entry: '/app/alice-space/', backup })
  expect(events).toEqual(['close:alice', 'stop:alice', 'backup:alice:alice-space', 'reset:alice', 'start:alice'])
})

it('never resets after backup failure and preserves completed backup information on reset or startup failure', async () => {
  const backup = { id: 'backup-1', location: '/private/backup-1', restoreInstructions: 'Follow README.txt after stopping the service and carrier.' }
  let failure: 'backup' | 'reset' | 'start' = 'backup'; let resets = 0
  const recovery = new CommunityEnvironmentRecovery({ get: user => user === 'admin' ? admin : target }, {
    recover: async (_user, _origin, prepare) => { await prepare(); throw new Error('fixture startup failed') },
  }, { backup: async () => { if (failure === 'backup') throw new Error('fixture backup failed'); return backup },
    reset: async () => { resets++; if (failure === 'reset') throw new Error('fixture reset failed') } }, { closeUser: async () => {} })
  await expect(recovery.reset(actor, 'alice', new URL('https://community.example'))).rejects.toMatchObject({ phase: 'backup', backup: undefined, code: 'environment-recovery-failed', params: { phase: 'backup' } })
  expect(resets).toBe(0)
  failure = 'reset'; await expect(recovery.reset(actor, 'alice', new URL('https://community.example'))).rejects.toMatchObject({ phase: 'reset', backup, code: 'environment-recovery-failed', params: { phase: 'reset' } })
  failure = 'start'; await expect(recovery.reset(actor, 'alice', new URL('https://community.example'))).rejects.toMatchObject({ phase: 'start', backup, code: 'environment-recovery-failed', params: { phase: 'start' } })
  expect(resets).toBe(2)
})

it('requires a fresh administrator and enabled target, rechecking authority and target identity before destructive reset', async () => {
  let viewer: CommunityAccountRecord | undefined = admin; let member: CommunityAccountRecord | undefined = target
  let reset = false; let change: (() => void) | undefined
  const recovery = new CommunityEnvironmentRecovery({ get: user => user === 'admin' ? viewer : member }, {
    recover: async (_user, _origin, prepare) => { await prepare(); return { userId: 'alice', processId: 1, origin: 'http://127.0.0.1:4101', launchUrl: 'http://127.0.0.1:4101/launch' } },
  }, { backup: async () => { change?.(); return { id: 'backup', location: '/private/backup', restoreInstructions: 'Follow README.txt' } },
    reset: async () => { reset = true } }, { closeUser: async () => {} })
  for (const revoked of [undefined, { ...admin, disabled: true }, { ...admin, spaceId: 'replacement' }, { ...admin, sessionEpoch: 1 }, { ...admin, admin: false }]) {
    viewer = revoked; await expect(recovery.reset(actor, 'alice', new URL('https://community.example'))).rejects.toThrow()
  }
  viewer = admin; member = { ...target, disabled: true }
  await expect(recovery.reset(actor, 'alice', new URL('https://community.example'))).rejects.toMatchObject({ kind: 'conflict' })
  member = target; change = () => { viewer = { ...admin, admin: false } }
  await expect(recovery.reset(actor, 'alice', new URL('https://community.example'))).rejects.toMatchObject({ kind: 'forbidden' })
  expect(reset).toBe(false)
  viewer = admin; change = () => { member = { ...target, spaceId: 'replacement' } }
  await expect(recovery.reset(actor, 'alice', new URL('https://community.example'))).rejects.toMatchObject({ kind: 'conflict' })
  expect(reset).toBe(false)
})
