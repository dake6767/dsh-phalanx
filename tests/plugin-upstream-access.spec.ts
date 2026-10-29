import { expect, it } from 'vitest'
import type { LibraryPlugin } from '../src/domain/plugin-library.js'
import { PluginUpstreamAccess } from '../src/use-cases/plugin-upstream-access.js'
import { accountState } from './support/account-state.js'
const account = { username: 'member', spaceId: 's', sessionEpoch: 0, admin: false, disabled: false, groupId: 'g', email: '', createdAt: 0, updatedAt: 0 }
function fixture(
  groupsReady: () => Promise<void> = async () => {},
  accountReady: () => Promise<void> = async () => {},
  finalReady: () => Promise<void> = async () => {},
  observable = true,
  libraryReady: () => Promise<void> = async () => {},
  upstreamReady?: () => Promise<void>,
) {
  const state = {
    template: 'Bearer {credential}',
    account: { ...account },
    granted: true,
    published: false,
    incompatible: false,
    credential: 'platform-fictional',
    baseUrl: 'http://localhost/api',
    runtimeRevision: 'revision',
    expert: false,
  }
  const access = new PluginUpstreamAccess(
    {
      ...accountState(async () => {
        await finalReady()
        return state.account
      }),
      get: async () => {
        await accountReady()
        return state.account
      },
      listGroups: async () => {
        await groupsReady()
        return [{ id: 'g', kind: state.account.admin ? ('admin' as const) : ('ordinary' as const), name: 'g', isDefault: true, memberCount: 1 }]
      },
    },
    { resolve: token => (token === 'member-token' ? { username: 'member', spaceId: 's' } : undefined) },
    {
      authorizationRevision: () => JSON.stringify([state.runtimeRevision, state.published, state.incompatible]),
      list: async () => {
        const rows = [
          {
            packageName: '@sample/plugin',
            stage: 'available',
            current: { runtimeRevision: state.runtimeRevision },
            published: state.published,
            incompatible: state.incompatible,
          } as LibraryPlugin,
        ]
        await libraryReady()
        return rows
      },
    },
    { authorizationRevision: () => JSON.stringify(state.granted), get: async () => (state.granted ? ['@sample/plugin'] : []) },
    {
      ...(upstreamReady ? { authorizationRevision: () => JSON.stringify([state.credential, state.template, state.baseUrl]) } : {}),
      list: () => {
        const rows = [
          {
            name: 'search',
            baseUrl: state.baseUrl,
            credential: state.credential,
            headers: [
              { name: 'Authorization', value: state.template },
              { name: 'X-Goog-Api-Key', value: '{credential}' },
              { name: 'X-Tenant-ID', value: '42' },
            ],
          },
        ]
        return upstreamReady ? upstreamReady().then(() => rows) : rows
      },
    },
    'revision',
    undefined,
    undefined,
    {
      ...(observable ? { authorizationSnapshot: () => ({ granted: state.expert }) } : {}),
      plugins: async () => (state.expert ? [{ packageName: '@sample/plugin' } as import('../src/domain/plugin-library.js').PreparedPlugin] : []),
    },
  )
  return {
    state,
    access,
    call: async (headers = { authorization: 'Bearer member-token' } as Record<string, string>) => await access.authorize('@sample/plugin', 'search', headers),
  }
}
it('recognizes token headers and checks fresh grant, publication, compatibility and credential on every call', async () => {
  const f = fixture()
  expect((await f.call()).username).toBe('member')
  expect((await f.call({ 'x-goog-api-key': 'member-token' })).username).toBe('member')
  f.state.granted = false
  await expect(f.call()).rejects.toThrow(/not authorized/u)
  f.state.account.admin = true
  await expect(f.call()).rejects.toThrow(/not authorized/u)
  f.state.account.admin = false
  f.state.expert = true
  expect((await f.call()).username).toBe('member')
  f.state.granted = true
  f.state.expert = false
  expect((await f.call()).username).toBe('member')
  f.state.granted = false
  await expect(f.call()).rejects.toThrow(/not authorized/u)
  f.state.published = true
  expect((await f.call()).username).toBe('member')
  f.state.incompatible = true
  await expect(f.call()).rejects.toThrow(/unavailable/u)
  f.state.incompatible = false
  f.state.credential = ''
  await expect(f.call()).rejects.toThrow(/not configured/u)
})
it('rejects absent, invalid, ambiguous and retired-space tokens and disabled accounts', async () => {
  const f = fixture()
  for (const headers of [{}, { authorization: 'Bearer invalid' }, { authorization: 'Bearer member-token', 'x-api-key': 'other-token' }])
    await expect(f.call(headers)).rejects.toThrow(/token/u)
  expect((await f.call({ authorization: 'Bearer member-token', 'x-api-key': 'member-token', 'x-tenant-id': 'forged' })).username).toBe('member')
  f.state.account.disabled = true
  await expect(f.call()).rejects.toThrow(/disabled/u)
  f.state.account.disabled = false
  f.state.account.spaceId = 'new'
  await expect(f.call()).rejects.toThrow(/token/u)
})

it('recognizes a custom Authorization template as well as conventional Bearer', async () => {
  const f = fixture()
  f.state.template = 'ApiKey {credential}'
  expect((await f.call({ authorization: 'ApiKey member-token' })).username).toBe('member')
  expect((await f.call({ authorization: 'Bearer member-token' })).username).toBe('member')
})

it('identifies the current member and group before attributable refusals but never guesses invalid or retired tokens', async () => {
  const f = fixture(),
    identities: { username: string; groupId: string | null }[] = []
  const identify = async (headers: Record<string, string>) =>
    await f.access.authorize('@sample/plugin', 'search', headers, member => {
      identities.push(member)
    })
  f.state.granted = false
  await expect(identify({ authorization: 'Bearer member-token' })).rejects.toThrow(/not authorized/u)
  expect(identities).toEqual([{ username: 'member', groupId: 'g' }])
  for (const headers of [{ authorization: 'Bearer invalid' }, { authorization: 'Bearer member-token', 'x-api-key': 'conflicting' }])
    await expect(identify(headers)).rejects.toThrow(/token/u)
  f.state.account.spaceId = 'retired'
  await expect(identify({ authorization: 'Bearer member-token' })).rejects.toThrow(/token/u)
  expect(identities).toHaveLength(1)
})

it('rechecks durable account state before returning credentials after a pending group lookup', async () => {
  let entered!: () => void, release!: () => void
  const began = new Promise<void>(resolve => {
      entered = resolve
    }),
    gate = new Promise<void>(resolve => {
      release = resolve
    })
  const f = fixture(async () => {
    entered()
    await gate
  })
  const admission = f.call()
  const refused = expect(admission).rejects.toMatchObject({ status: 403 })
  await began
  f.state.account = { ...f.state.account, disabled: true }
  release()
  await refused
})

it.each(['credential', 'base-url', 'template'])('refuses an upstream %s changed while the account read is pending', async change => {
  let entered!: () => void, release!: () => void
  const began = new Promise<void>(resolve => {
      entered = resolve
    }),
    gate = new Promise<void>(resolve => {
      release = resolve
    })
  const f = fixture(
    async () => {},
    async () => {
      entered()
      await gate
    },
  )
  const admission = f.call(),
    refused = expect(admission).rejects.toMatchObject({ status: 403 })
  await began
  if (change === 'credential') f.state.credential = 'rotated-fixture'
  if (change === 'base-url') f.state.baseUrl = 'http://localhost/new'
  if (change === 'template') f.state.template = 'ApiKey {credential}'
  release()
  await refused
})

it('refuses unversioned expert revocation while final registration waits for the account', async () => {
  let entered!: () => void, release!: () => void
  const began = new Promise<void>(resolve => {
      entered = resolve
    }),
    gate = new Promise<void>(resolve => {
      release = resolve
    })
  const f = fixture(
    async () => {},
    async () => {},
    async () => {
      entered()
      await gate
    },
  )
  f.state.granted = false
  f.state.expert = true
  let registered = false
  const admission = f.access.register('@sample/plugin', 'search', { authorization: 'Bearer member-token' }, () => {
    registered = true
  })
  const refused = expect(admission).rejects.toMatchObject({ status: 403 })
  await began
  f.state.expert = false
  release()
  await refused
  expect(registered).toBe(false)
})

it('refuses expert credential admission when neither local snapshot nor version is observable', async () => {
  const f = fixture(
    async () => {},
    async () => {},
    async () => {},
    false,
  )
  f.state.granted = false
  f.state.expert = true
  await expect(f.call()).rejects.toMatchObject({ status: 403 })
})

it('rolls back reversible registration when grants change while the account transaction commits', async () => {
  const f = fixture()
  let registered = false
  await expect(
    f.access.register('@sample/plugin', 'search', { authorization: 'Bearer member-token' }, (_grant, onAbort) => {
      registered = true
      onAbort(() => {
        registered = false
      })
      queueMicrotask(() => {
        f.state.granted = false
      })
      return 'registered'
    }),
  ).rejects.toMatchObject({ status: 403 })
  expect(registered).toBe(false)
})

it('refuses a library result whose publication was revoked during its asynchronous read', async () => {
  let entered!: () => void, release!: () => void
  const began = new Promise<void>(resolve => {
      entered = resolve
    }),
    gate = new Promise<void>(resolve => {
      release = resolve
    })
  const f = fixture(
    async () => {},
    async () => {},
    async () => {},
    true,
    async () => {
      entered()
      await gate
    },
  )
  f.state.granted = false
  f.state.published = true
  const pending = f.call(),
    refused = expect(pending).rejects.toMatchObject({ status: 403 })
  await began
  f.state.published = false
  release()
  await refused
})

it('refuses an old credential returned after an asynchronous upstream read was invalidated', async () => {
  let release!: () => void, began!: () => void
  const ready = new Promise<void>(resolve => {
      began = resolve
    }),
    hold = new Promise<void>(resolve => {
      release = resolve
    })
  const f = fixture(undefined, undefined, undefined, true, undefined, async () => {
    began()
    await hold
  })
  const request = f.call()
  await ready
  f.state.credential = 'rotated-fictional'
  release()
  await expect(request).rejects.toThrow(/changed during admission/u)
})
