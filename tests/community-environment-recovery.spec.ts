import type { EnvironmentResetHistory } from '../src/domain/environment-reset-history.js'
import { expect, it } from 'vitest'
import { CommunityEnvironmentRecovery } from '../src/use-cases/community-environment-recovery.js'
import type { CommunityAccountRecord } from '../src/domain/community-account.js'

function memoryHistory() {
  const records = new Map<string, EnvironmentResetHistory>()
  return { get: (space: string) => records.get(space), save: (space: string, value: EnvironmentResetHistory) => { records.set(space, value) } }
}

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
  { closeUser: async user => { events.push(`close:${user}`) } }, memoryHistory(), { now: () => 0 })
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
    reset: async () => { resets++; if (failure === 'reset') throw new Error('fixture reset failed') } }, { closeUser: async () => {} }, memoryHistory(), { now: () => 0 })
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
    reset: async () => { reset = true } }, { closeUser: async () => {} }, memoryHistory(), { now: () => 0 })
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

it('allows a current member to reset only their own stable space and rechecks revocation before resetting', async () => {
  let alice = target, resets = 0, revoke = false, now = 0
  const recovery = new CommunityEnvironmentRecovery({ get: user => user === 'admin' ? admin : user === 'alice' ? alice : undefined }, {
    recover: async (user, _origin, prepare) => { await prepare(); return { userId: user, processId: 1, origin: 'http://localhost', launchUrl: 'http://localhost' } },
  }, { backup: async () => { if (revoke) alice = { ...alice, sessionEpoch: 1 }; return { id: 'backup', location: '/private/backup', restoreInstructions: 'Follow README' } }, reset: async () => { resets++ } }, { closeUser: async () => {} }, memoryHistory(), { now: () => now })
  await expect(recovery.reset(target, 'admin', new URL('https://community.example/'))).rejects.toMatchObject({ kind: 'forbidden' })
  expect((await recovery.reset(target, 'alice', new URL('https://community.example/'))).spaceId).toBe(target.spaceId)
  expect(resets).toBe(1)
  now = 600000; revoke = true
  await expect(recovery.reset(target, 'alice', new URL('https://community.example/'))).rejects.toMatchObject({ code: 'sign-in-required' })
  expect(resets).toBe(1)
})

it('records acceptance before effects, persists the member window and exempts administrators without erasing that window', async () => {
  let now = 0
  const events: string[] = [], records = new Map<string, { lastMemberAcceptedAt?: number, recent: { at: number, username: string, role: 'admin' | 'member' } }>()
  const recovery = new CommunityEnvironmentRecovery({ get: user => user === 'admin' ? admin : target }, {
    recover: async (user, _origin, prepare) => { await prepare(); return { userId: user, processId: 1, origin: 'http://localhost', launchUrl: 'http://localhost' } },
  }, { backup: async () => ({ id: 'backup', location: '/private/backup', restoreInstructions: 'Follow README' }), reset: async () => {} },
  { closeUser: async () => { events.push('close') } }, { get: space => records.get(space), save: (space, value) => { events.push('accepted'); records.set(space, value) } }, { now: () => now })
  const origin = new URL('https://community.example/')
  await recovery.reset(target, 'alice', origin)
  expect(events).toEqual(['accepted', 'close'])
  expect(records.get(target.spaceId)).toEqual({ lastMemberAcceptedAt: 0, recent: { at: 0, username: 'alice', role: 'member' } })
  now = 599999
  await expect(recovery.reset(target, 'alice', origin)).rejects.toMatchObject({ code: 'environment-reset-rate-limited', params: { seconds: 1 } })
  await recovery.reset(actor, 'alice', origin)
  expect(records.get(target.spaceId)).toEqual({ lastMemberAcceptedAt: 0, recent: { at: 599999, username: 'admin', role: 'admin' } })
  now = 600000; await recovery.reset(target, 'alice', origin)
  expect(records.get(target.spaceId)?.lastMemberAcceptedAt).toBe(600000)
})

it.each(['admin', 'member'] as const)('joins one reset without replacing its first %s initiator or consuming a second cooldown', async firstRole => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }), history = memoryHistory()
  let saves = 0, closes = 0
  const recovery = new CommunityEnvironmentRecovery({ get: user => user === 'admin' ? admin : target }, {
    recover: async (user, _origin, prepare) => { await prepare(); return { userId: user, processId: 1, origin: 'http://localhost', launchUrl: 'http://localhost' } },
  }, { backup: async () => { await gate; return { id: 'backup', location: '/private/backup', restoreInstructions: 'Follow README' } }, reset: async () => {} },
  { closeUser: async () => { closes++ } }, { ...history, save: (space, value) => { saves++; history.save(space, value) } }, { now: () => 123 })
  const origin = new URL('https://community.example/'), first = firstRole === 'admin' ? actor : target, second = firstRole === 'admin' ? target : actor
  const a = recovery.reset(first, 'alice', origin), b = recovery.reset(second, 'alice', origin)
  expect(history.get(target.spaceId)?.recent.role).toBe(firstRole); release(); expect(await a).toEqual(await b)
  expect(saves).toBe(1); expect(closes).toBe(1)
  expect(history.get(target.spaceId)?.lastMemberAcceptedAt).toBe(firstRole === 'member' ? 123 : undefined)
})

it('keeps an accepted failed member attempt in the cooldown and performs no effects when acceptance cannot be saved', async () => {
  const history = memoryHistory(), origin = new URL('https://community.example/'), effects: string[] = []
  let now = 0, writable = true
  const recovery = new CommunityEnvironmentRecovery({ get: user => user === 'admin' ? admin : target }, {
    recover: async (_user, _origin, prepare) => { effects.push('stop'); await prepare(); throw Error('unreachable') },
  }, { backup: async () => { throw Error('fixture backup unavailable') }, reset: async () => { effects.push('reset') } },
  { closeUser: async () => { effects.push('close') } }, { ...history, save: (space, value) => { if (!writable) throw Error('fixture history unavailable'); history.save(space, value) } }, { now: () => now })
  await expect(recovery.reset(target, 'alice', origin)).rejects.toMatchObject({ phase: 'backup' })
  expect(history.get(target.spaceId)?.lastMemberAcceptedAt).toBe(0); expect(effects).toEqual(['close', 'stop'])
  now = 100; await expect(recovery.reset(target, 'alice', origin)).rejects.toMatchObject({ code: 'environment-reset-rate-limited' })
  now = 600000; writable = false; effects.length = 0
  await expect(recovery.reset(target, 'alice', origin)).rejects.toThrow('fixture history unavailable')
  expect(effects).toEqual([]); expect(history.get(target.spaceId)?.lastMemberAcceptedAt).toBe(0)
})
