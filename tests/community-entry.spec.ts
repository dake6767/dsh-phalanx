import { describe, expect, it } from 'vitest'
import { CommunityEntry } from '../src/use-cases/community-entry.js'
import type { CommunityAccountRecord } from '../src/domain/community-account.js'
import type { CommunityRuntimePort } from '../src/ports/community-runtime.js'

const account: CommunityAccountRecord = { username: 'member', email: 'member@example.test', admin: false,
  disabled: false, sessionEpoch: 0, createdAt: 0, updatedAt: 0 }
const instance = { userId: 'member', origin: 'http://127.0.0.1:4000', launchUrl: 'http://127.0.0.1:4000/?token=fixture', processId: 4000 }
const runtime: CommunityRuntimePort = { ensure: async () => instance, status: () => ({ state: 'ready', instance }),
  reclaim: async () => 'not-running', terminate: async () => {}, stopAll: async () => {},
  reconcileStartupContainers: async () => ({ adopted: [], swept: [] }) }

describe('community entry identity', () => {
  it('refuses to issue a login after the account epoch changes during DSH startup', async () => {
    let current = account
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const entry = new CommunityEntry({ getState: () => current, authenticate: async () => current }, runtime,
      { exchangeLaunchToken: async () => { entered(); await gate; return ['fixture_cookie=accepted'] } })
    const signIn = entry.signIn('member', 'password', new URL('http://127.0.0.1:3080'))
    const refused = expect(signIn).rejects.toMatchObject({ reason: 'authorization-unavailable' })
    await started
    current = { ...current, sessionEpoch: 1 }
    release()
    await refused
  })
})
