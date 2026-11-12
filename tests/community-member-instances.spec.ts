import { expect, it } from 'vitest'
import { CommunityMemberInstances } from '../src/use-cases/community-member-instances.js'
import type { CommunityAccountState } from '../src/domain/community-account.js'
import type { CommunityRuntimeStatus } from '../src/ports/community-runtime.js'

it('starts stopped members, refuses duplicate operations and rechecks authority after stopping', async () => {
  let admin: CommunityAccountState = { username: 'admin', spaceId: 'admin-space', sessionEpoch: 0, admin: true, disabled: false }
  let member: CommunityAccountState = { username: 'member', spaceId: 'member-space', sessionEpoch: 0, admin: false, disabled: false }
  let state: CommunityRuntimeStatus = { state: 'stopped' }
  let release!: () => void
  let stopped!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const entered = new Promise<void>(resolve => {
    stopped = resolve
  })
  const instance = { userId: 'member', origin: 'http://127.0.0.1:4101', launchUrl: 'http://127.0.0.1:4101/launch', processId: 1 }
  const actions = new CommunityMemberInstances(
    { getState: async username => (username === 'admin' ? admin : username === 'member' ? member : undefined) },
    {
      refresh: async () => {},
      operateMember: async (_user, action, _origin, check) => {
        if (action === 'start') {
          if (state.state !== 'stopped') throw Object.assign(Error('State changed'), { kind: 'conflict' })
          state = { state: 'ready', instance }
          return instance
        }
        stopped()
        await gate
        await check()
        return instance
      },
    },
    { closeUser: async () => {} },
  )
  const origin = new URL('https://community.example')
  await actions.execute(admin, member.username, 'start', origin, 'member-space')
  expect(state.state).toBe('ready')
  await expect(actions.execute(admin, member.username, 'start', origin, 'member-space')).rejects.toMatchObject({ kind: 'conflict' })
  const restarting = actions.execute(admin, member.username, 'restart', origin, 'member-space')
  await entered
  await expect(actions.execute(admin, member.username, 'restart', origin, 'member-space')).rejects.toMatchObject({ kind: 'conflict' })
  member = { ...member, spaceId: 'replacement-space' }
  const refused = expect(restarting).rejects.toMatchObject({ code: 'account-inactive' })
  release()
  await refused
  admin = { ...admin, admin: false }
  await expect(actions.execute(admin, member.username, 'restart', origin, 'member-space')).rejects.toMatchObject({ code: 'admin-required' })
})

it('refuses to launch after administrator authority is revoked during the stop', async () => {
  let admin = true,
    launched = false
  const actor = { username: 'admin', spaceId: 'admin-space', sessionEpoch: 0 }
  const actions = new CommunityMemberInstances(
    { getState: async username => ({ username, spaceId: username + '-space', sessionEpoch: 0, disabled: false, admin: username === 'admin' && admin }) },
    {
      operateMember: async (_username, _action, _origin, assertCurrent, beforeStop) => {
        await beforeStop?.()
        await assertCurrent()
        launched = true
        throw Error('Revoked operation reached launch')
      },
    },
    {
      closeUser: async () => {
        admin = false
      },
    },
  )
  await expect(actions.execute(actor, 'member', 'restart', new URL('https://community.example'), 'member-space')).rejects.toMatchObject({
    code: 'admin-required',
  })
  expect(launched).toBe(false)
})
