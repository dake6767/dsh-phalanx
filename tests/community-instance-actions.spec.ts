import { expect, it } from 'vitest'
import { CommunityInstanceActions } from '../src/use-cases/community-instance-actions.js'
import { CommunityAuthenticationError, type CommunityAccountState } from '../src/domain/community-account.js'

it('restarts only the fresh authenticated space, shares concurrent requests and permits retry after failure', async () => {
  const account: CommunityAccountState = { username: 'alice', spaceId: 'alice-space', sessionEpoch: 0, disabled: false }
  let current: CommunityAccountState | undefined = account
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve })
  let starts = 0; let fail = false; const stopped: string[] = []
  const actions = new CommunityInstanceActions({ getState: () => current }, {
    restart: async user => { starts++; await gate; if (fail) throw new Error('fixture start failure'); return { userId: user, origin: 'http://127.0.0.1:4101', launchUrl: 'http://127.0.0.1:4101/launch', processId: starts } },
  }, { closeUser: async user => { stopped.push(user) } })
  const actor = { username: 'alice', spaceId: 'alice-space', sessionEpoch: 0 }
  const a = actions.restart(actor, new URL('https://community.example')); const b = actions.restart(actor, new URL('https://community.example'))
  release(); expect(await a).toEqual(await b); expect(starts).toBe(1); expect(stopped).toEqual(['alice'])
  fail = true; await expect(actions.restart(actor, new URL('https://community.example'))).rejects.toThrow(); fail = false
  expect((await actions.restart(actor, new URL('https://community.example'))).userId).toBe('alice')
  for (const revoked of [{ ...account, disabled: true }, { ...account, spaceId: 'new-space' }, { ...account, sessionEpoch: 1 }, undefined]) {
    current = revoked
    await expect(actions.restart(actor, new URL('https://community.example'))).rejects.toBeInstanceOf(CommunityAuthenticationError)
  }
  expect(starts).toBe(3)
})
