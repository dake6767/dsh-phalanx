import type { IncomingMessage } from 'node:http'
import { expect, it } from 'vitest'
import type { CommunityAccountState } from '../src/domain/community-account.js'
import { authenticatedUser, createEntrySessionGate, PlatformSessionCodec } from '../src/inbound/platform-session.js'
import { PostgresCommunityAccountStore } from '../src/adapters/postgres-community-accounts.js'
import { openTestDatabase } from './support/community-application.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

it('waits for durable account lookup before accepting a signed session', async () => {
  const account = { username: 'member', spaceId: 'member-space', disabled: false, sessionEpoch: 3 }
  const sessions = new PlatformSessionCodec('fictional-session-signing-key-with-32-bytes')
  const request = { headers: { cookie: `dsh-phalanx_session=${sessions.issue(account)}` } } as IncomingMessage
  let complete!: (account: CommunityAccountState) => void
  const pending = new Promise<CommunityAccountState>(resolve => {
    complete = resolve
  })
  const authentication = authenticatedUser(request, sessions, () => pending)
  complete(account)
  expect(await authentication).toBe('member')
})

it('does not register an entry disabled while its durable admission is pending', async () => {
  const root = await mkdtemp(join(tmpdir(), 'session-admission-'))
  const database = await openTestDatabase(root),
    store = new PostgresCommunityAccountStore(database)
  let release!: () => void
  try {
    const account = await store.create({ username: 'member', email: '', password: 'password' })
    const sessions = new PlatformSessionCodec('fictional-session-signing-key-with-32-bytes')
    const request = { headers: { cookie: `dsh-phalanx_session=${sessions.issue(account)}` } } as IncomingMessage
    let entered!: () => void
    const began = new Promise<void>(resolve => {
        entered = resolve
      }),
      pending = new Promise<void>(resolve => {
        release = resolve
      })
    const disabling = database.transaction(async sql => {
      await sql.query("UPDATE dsh_phalanx.accounts SET disabled=true,session_epoch=1 WHERE username='member'")
      entered()
      await pending
    })
    await began
    let connected = false
    const gate = createEntrySessionGate(sessions, store)
    const admitting = gate.admit(request, 'member', () => {
      connected = true
      return true
    })
    try {
      await expect
        .poll(async () =>
          Number(
            (
              await database.query<{ waiting: string }>(
                "SELECT count(*) AS waiting FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'",
              )
            )[0]!.waiting,
          ),
        )
        .toBeGreaterThan(0)
      release()
      await disabling
      expect(await admitting).toBe(false)
      expect(connected).toBe(false)
    } finally {
      release()
      await Promise.allSettled([disabling, admitting])
    }
  } finally {
    release?.()
    await database.close()
    await rm(root, { recursive: true, force: true })
  }
})
