import { expect, it } from 'vitest'
import { ResidentInstances } from '../src/use-cases/resident-instances.js'
import { CommunityInstanceLifecycle } from '../src/use-cases/community-instance-lifecycle.js'
import type { CommunityAccountRecord } from '../src/domain/community-account.js'
import { UNLIMITED_INSTANCE_RESOURCES } from '../src/domain/instance-resources.js'

it('boots only enabled resident spaces, locks automatic failures, clears them on foreground success and restarts confirmed crashes', async () => {
  const member: CommunityAccountRecord = { username: 'member', spaceId: 'a'.repeat(32), admin: false, disabled: false, sessionEpoch: 0, email: '', groupId: 'ordinary', createdAt: 0, updatedAt: 0 }
  let accounts = [member], residents = { [member.spaceId]: true as const }, fail = true, alive = true, launches = 0, now = 123
  const runtime = new CommunityInstanceLifecycle({ rebuild: async () => [], alive: async () => alive, stop: async () => {}, detach: async () => {},
    start: async userId => { launches++; if (fail) throw Error('private fixture'); return { userId, processId: launches, origin: 'http://localhost', launchUrl: 'http://localhost' } } },
    () => ({ url: 'http://localhost/model', token: 'fixture' }), user => monitor.ready(user))
  const monitor = new ResidentInstances({ get: username => accounts.find(row => row.username === username), list: () => accounts },
    { read: () => ({ revision: 0, defaults: UNLIMITED_INSTANCE_RESOURCES, overrides: {}, idleSeconds: 1800, residents }) }, runtime, { now: () => now }, () => new URL('https://community.example/'))
  monitor.scan(); await monitor.drain()
  expect(monitor.failure(member.spaceId)).toEqual({ at: 123 })
  monitor.scan(); await monitor.drain(); expect(launches).toBe(1)
  fail = false; await runtime.ensure('member', 'https://community.example/')
  expect(monitor.failure(member.spaceId)).toBeUndefined()
  alive = false; await runtime.refresh(); now = 456; monitor.scan(); await monitor.drain(); expect(launches).toBe(3)
  accounts = [{ ...member, disabled: true }]; await runtime.terminate('member'); monitor.settingsChanged(); await monitor.drain(); expect(launches).toBe(3)
  accounts = [member]; monitor.settingsChanged(); await monitor.drain(); expect(launches).toBe(4)
  accounts = [{ ...member, spaceId: 'b'.repeat(32) }]; await runtime.terminate('member'); monitor.settingsChanged(); await monitor.drain(); expect(launches).toBe(4)
  residents = {}; monitor.settingsChanged(); expect(monitor.failure(member.spaceId)).toBeUndefined()
  await runtime.stopAll()
})
