import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'
import { communityLoginPage } from '../src/inbound/community-account-pages.js'
import type { SignedInAccountView } from '../src/domain/admin-contract.js'
import { createCommunityApplication, openTestAccounts } from './support/community-application.js'

it('renders the remembered-account list bilingually with user text escaped', () => {
  const accounts: SignedInAccountView[] = [
    { username: 'root', admin: true, status: 'current', marker: 'marker-root' },
    { username: 'a<b>"quoted"', admin: false, status: 'unavailable', marker: 'marker-quote' },
  ]
  const english = communityLoginPage(undefined, 'en', 'system', accounts)
  expect(english).toContain('Choose an account')
  expect(rowOf(english, 'root')).toContain('href="/admin"')
  expect(english).toContain('Use another account')
  expect(english).toContain('Sign out of all accounts')
  expect(english).toContain('Remove from this browser')
  expect(english).toContain('Unavailable')
  const memberPage = communityLoginPage(undefined, 'en', 'system', [{ username: 'member', admin: false, status: 'current', marker: 'member-marker' }])
  expect(rowOf(memberPage, 'member')).toContain('href="/"')
  expect(english).not.toContain('a<b>"quoted"')
  const chinese = communityLoginPage(undefined, 'zh-CN', 'system', accounts)
  expect(chinese).toContain('选择账户')
  expect(chinese).toContain('使用其他账户')
  expect(chinese).toContain('退出所有账户')
  expect(chinese).toContain('不可用')
  expect(chinese).toContain('移除')
})

/** Cookie jar that follows the browser's manual-redirect semantics for one fictional user. */
const jar = () => {
  const cookies = new Map<string, string>()
  return {
    header: () => [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; '),
    absorb: (response: Response) => {
      for (const cookie of response.headers.getSetCookie()) {
        const pair = cookie.split(';', 1)[0]!
        const at = pair.indexOf('=')
        if (pair.slice(at + 1) === '') cookies.delete(pair.slice(0, at))
        else cookies.set(pair.slice(0, at), pair.slice(at + 1))
      }
    },
    value: (name: string) => cookies.get(name),
    set: (name: string, value: string) => cookies.set(name, value),
  }
}

const rowOf = (html: string, username: string): string => {
  return (html.match(/<li class="account-item[^"]*">[\s\S]*?<\/li>/gu) ?? []).find(row => row.includes(`<span class="account-name">${username}`)) ?? ''
}

const markerOf = (html: string, username: string): string => {
  const row = rowOf(html, username)
  expect(row, `account row for ${username}`).not.toBe('')
  return row.match(/name="marker" value="([^"]+)"/u)![1]!
}

async function prepare(dataRoot: string, usernames: readonly string[], administrator: { username: string; password: string }): Promise<void> {
  const accounts = await openTestAccounts(dataRoot)
  try {
    await accounts.createFirstAdmin({ username: administrator.username, email: '', password: administrator.password })
    for (const username of usernames) await accounts.create({ username, email: '', password: 'password' })
  } finally {
    await accounts.close()
  }
}

it('remembers signed-in accounts, switches without a password and keeps the previous space fenced', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'dsh-phalanx-signed-in-'))
  const app = createCommunityApplication({
    listen: { host: '127.0.0.1', port: 0 },
    sessionSecret: 'signed-in-accounts-fixture-secret-32-bytes',
    runtime: {
      command: process.execPath,
      args: [fileURLToPath(new URL('./fixtures/runtime.mjs', import.meta.url))],
      dataRoot,
      defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'http://127.0.0.1:1' } },
    },
  })
  try {
    await prepare(dataRoot, ['alice', 'bob'], { username: 'root', password: 'password' })
    const origin = await app.start()
    const browser = jar()
    const request = async (path: string, init: { method?: string; body?: URLSearchParams; cookie?: boolean } = {}) => {
      const response = await fetch(`${origin}${path}`, {
        method: init.method ?? 'GET',
        redirect: 'manual',
        headers: {
          ...(init.body === undefined ? {} : { 'content-type': 'application/x-www-form-urlencoded' }),
          origin,
          ...(init.cookie === false ? {} : { cookie: browser.header() }),
        },
        ...(init.body === undefined ? {} : { body: init.body }),
      })
      browser.absorb(response)
      return response
    }
    const login = async (username: string, password = 'password') =>
      await request('/login', { method: 'POST', body: new URLSearchParams({ username, password }) })

    // Two logins remember both accounts; the remembered token is the login's own session token.
    const aliceLogin = await login('alice')
    expect(aliceLogin.status).toBe(303)
    const aliceToken = browser.value('dsh-phalanx_session')!
    expect(aliceToken.length).toBeGreaterThan(0)
    const bobLogin = await login('bob')
    expect(bobLogin.status).toBe(303)
    const bobToken = browser.value('dsh-phalanx_session')!
    const bobSpace = bobLogin.headers.get('location')!
    expect(bobSpace).toMatch(/^\/app\/[a-f0-9]{32}\/$/u)
    expect(bobToken).not.toBe(aliceToken)

    // The login page lists remembered accounts instead of the plain form.
    const list = await request('/login')
    const listHtml = await list.text()
    expect(listHtml).toContain('Choose an account')
    expect(rowOf(listHtml, 'alice')).toContain('account-select')
    expect(rowOf(listHtml, 'bob')).toContain('account-select')
    expect(listHtml).toContain('Use another account')

    // JSON list shows the current account and never returns tokens.
    const identity = await request('/account/signed-in')
    expect(identity.status).toBe(200)
    expect(await identity.json()).toEqual({
      accounts: [
        { username: 'bob', admin: false, status: 'current', marker: markerOf(listHtml, 'bob') },
        { username: 'alice', admin: false, status: 'available', marker: markerOf(listHtml, 'alice') },
      ],
    })

    // Mutations reject GET even when a valid remembered login is present.
    for (const path of ['/account/switch', '/account/signed-in/remove', '/account/signed-in/remove-all']) {
      const unchanged = browser.header()
      expect((await request(path)).status).toBe(404)
      expect(browser.header()).toBe(unchanged)
    }

    // Switching reuses the remembered token verbatim and clears browser storage on the account change.
    const switched = await request('/account/switch', { method: 'POST', body: new URLSearchParams({ marker: markerOf(listHtml, 'alice') }) })
    expect(switched.status).toBe(303)
    expect(switched.headers.get('location')).toMatch(/^\/app\/[a-f0-9]{32}\/$/u)
    expect(switched.headers.get('clear-site-data')).toBe('"storage"')
    expect(browser.value('dsh-phalanx_session')).toBe(aliceToken)
    const reissued = await request('/account/switch', { method: 'POST', body: new URLSearchParams({ marker: markerOf(listHtml, 'alice') }) })
    expect(reissued.status).toBe(303)
    expect(reissued.headers.get('clear-site-data')).toBeNull()
    expect(browser.value('dsh-phalanx_session')).toBe(aliceToken)

    // The previous account's space stays fenced after the switch.
    const fenced = await fetch(`${origin}${bobSpace}`, { redirect: 'manual', headers: { cookie: browser.header() } })
    expect(fenced.status).toBe(403)
  } finally {
    await app.stop()
    await rm(dataRoot, { recursive: true, force: true })
  }
})

it('caps the remembered list at ten accounts and keeps the cookie within the browser limit', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'dsh-phalanx-signed-in-cap-'))
  const app = createCommunityApplication({
    listen: { host: '127.0.0.1', port: 0 },
    sessionSecret: 'signed-in-accounts-cap-fixture-secret-32b',
    runtime: {
      command: process.execPath,
      args: [fileURLToPath(new URL('./fixtures/runtime.mjs', import.meta.url))],
      dataRoot,
      defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'http://127.0.0.1:1' } },
    },
  })
  try {
    const members = Array.from({ length: 11 }, (_, index) => createHash('sha256').update(`member-${index}`).digest('hex'))
    await prepare(dataRoot, members, { username: 'root', password: 'password' })
    const origin = await app.start()
    const browser = jar()
    const request = async (path: string, init: { method?: string; body?: URLSearchParams } = {}) => {
      const response = await fetch(`${origin}${path}`, {
        method: init.method ?? 'GET',
        redirect: 'manual',
        headers: {
          ...(init.body === undefined ? {} : { 'content-type': 'application/x-www-form-urlencoded' }),
          origin,
          cookie: browser.header(),
        },
        ...(init.body === undefined ? {} : { body: init.body }),
      })
      browser.absorb(response)
      return response
    }
    for (const username of members.slice(0, 10))
      expect((await request('/login', { method: 'POST', body: new URLSearchParams({ username, password: 'password' }) })).status).toBe(303)
    const remembered = browser.value('dsh-phalanx_signed_in_accounts')!
    expect(Buffer.byteLength(remembered) + 'dsh-phalanx_signed_in_accounts=; Max-Age=31536000; Path=/; HttpOnly; Secure; SameSite=Strict'.length).toBeLessThan(
      4096,
    )

    // An eleventh account is refused with the removal prompt; no remembered entry is displaced.
    const refused = await request('/login', { method: 'POST', body: new URLSearchParams({ username: members[10]!, password: 'password' }) })
    expect(refused.status).toBe(403)
    const refusedHtml = await refused.text()
    expect(refusedHtml).toContain('This browser already remembers 10 accounts')
    expect(rowOf(refusedHtml, members[10]!)).toBe('')
    for (const username of members.slice(0, 10)) expect(rowOf(refusedHtml, username)).not.toBe('')

    // Removing one entry frees the slot; the removed account is no longer listed.
    const removed = await request('/account/signed-in/remove', { method: 'POST', body: new URLSearchParams({ marker: markerOf(refusedHtml, members[2]!) }) })
    expect(removed.status).toBe(303)
    const afterRemoval = await request('/login')
    const afterHtml = await afterRemoval.text()
    expect(rowOf(afterHtml, members[2]!)).toBe('')
    expect((await request('/login', { method: 'POST', body: new URLSearchParams({ username: members[10]!, password: 'password' }) })).status).toBe(303)
    const admitted = await request('/login')
    expect(rowOf(await admitted.text(), members[10]!)).not.toBe('')
  } finally {
    await app.stop()
    await rm(dataRoot, { recursive: true, force: true })
  }
})

it('drops expired, invalidated, recreated and tampered entries instead of switching', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'dsh-phalanx-signed-in-state-'))
  const app = createCommunityApplication({
    listen: { host: '127.0.0.1', port: 0 },
    sessionSecret: 'signed-in-accounts-state-fixture-secret-32',
    runtime: {
      command: process.execPath,
      args: [fileURLToPath(new URL('./fixtures/runtime.mjs', import.meta.url))],
      dataRoot,
      defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'http://127.0.0.1:1' } },
    },
  })
  try {
    await prepare(dataRoot, ['alice', 'bob', 'carol'], { username: 'root', password: 'password' })
    const origin = await app.start()
    const browser = jar()
    const request = async (path: string, init: { method?: string; body?: URLSearchParams } = {}) => {
      const response = await fetch(`${origin}${path}`, {
        method: init.method ?? 'GET',
        redirect: 'manual',
        headers: {
          ...(init.body === undefined ? {} : { 'content-type': 'application/x-www-form-urlencoded' }),
          origin,
          cookie: browser.header(),
        },
        ...(init.body === undefined ? {} : { body: init.body }),
      })
      browser.absorb(response)
      return response
    }
    const login = async (username: string, password = 'password') =>
      await request('/login', { method: 'POST', body: new URLSearchParams({ username, password }) })
    for (const username of ['alice', 'bob', 'carol']) expect((await login(username)).status).toBe(303)

    // A password change invalidates the remembered token; switching is refused and the entry degrades.
    const accounts = await openTestAccounts(dataRoot)
    try {
      await accounts.resetPassword('carol', 'changed-password')
    } finally {
      await accounts.close()
    }
    const beforeExpiry = await request('/login')
    const beforeHtml = await beforeExpiry.text()
    const refused = await request('/account/switch', { method: 'POST', body: new URLSearchParams({ marker: markerOf(beforeHtml, 'carol') }) })
    expect(refused.status).toBe(303)
    expect(refused.headers.get('location')).toBe('/login?username=carol')
    expect(rowOf(beforeHtml, 'carol')).toContain('Sign in again')
    expect((await (await request('/account/signed-in')).json()).accounts.find((account: { username: string }) => account.username === 'carol').status).toBe(
      'reauthentication-required',
    )

    // An expired session token keeps the entry listed for a fresh sign in with the username prefilled.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 13 * 60 * 60 * 1000 })
    try {
      const expired = await request('/login?accounts=1')
      const expiredHtml = await expired.text()
      expect(rowOf(expiredHtml, 'alice')).toContain('Sign in again')
      const prefill = await request('/login?username=alice')
      const prefillHtml = await prefill.text()
      expect(prefillHtml).toContain('value="alice"')
    } finally {
      vi.useRealTimers()
    }

    // A disabled account, and a deleted account recreated under the same name, show as unavailable.
    expect((await login('bob')).status).toBe(303)
    const currentToken = browser.value('dsh-phalanx_session')
    const disabledMarker = markerOf(beforeHtml, 'alice')
    const mutations = await openTestAccounts(dataRoot)
    try {
      await mutations.setDisabled('alice', true)
      await mutations.delete('carol')
      await mutations.create({ username: 'carol', email: '', password: 'password' })
    } finally {
      await mutations.close()
    }
    const unavailable = await request('/login?accounts=1')
    const unavailableHtml = await unavailable.text()
    expect(rowOf(unavailableHtml, 'alice')).toContain('Unavailable')
    expect(rowOf(unavailableHtml, 'alice')).not.toContain('/account/switch')
    expect(rowOf(unavailableHtml, 'carol')).toContain('Unavailable')
    expect(unavailableHtml.match(/account-name">carol/gu)?.length).toBe(1)

    // Directly posting the old entry also refuses a disabled account and leaves Bob signed in.
    const disabledSwitch = await request('/account/switch', { method: 'POST', body: new URLSearchParams({ marker: disabledMarker }) })
    expect(disabledSwitch.status).toBe(303)
    expect(disabledSwitch.headers.get('location')).toBe('/login')
    expect(disabledSwitch.headers.get('clear-site-data')).toBeNull()
    expect(browser.value('dsh-phalanx_session')).toBe(currentToken)
    const retainedIdentity = await request('/account/identity')
    expect(retainedIdentity.status).toBe(200)
    expect(await retainedIdentity.json()).toEqual({ username: 'bob', admin: false })

    // Logging in to a recreated same-name account does not replace the old space identity.
    expect((await login('carol')).status).toBe(303)
    const recreated = await (await request('/account/signed-in')).json()
    expect(
      recreated.accounts.filter((account: { username: string }) => account.username === 'carol').map((account: { status: string }) => account.status),
    ).toEqual(['current', 'unavailable'])

    // A tampered cookie is discarded whole: the login page falls back to the plain form.
    const remembered = browser.value('dsh-phalanx_signed_in_accounts')!
    browser.set('dsh-phalanx_signed_in_accounts', `x${remembered.slice(1)}`)
    const tampered = await request('/login')
    const tamperedHtml = await tampered.text()
    expect(tamperedHtml).toContain('Sign in to dsh-phalanx')
    expect(tamperedHtml).not.toContain('Choose an account')

    // Cross-origin switch, remove and sign-out-all requests are rejected.
    browser.set('dsh-phalanx_signed_in_accounts', remembered)
    for (const path of ['/account/switch', '/account/signed-in/remove', '/account/signed-in/remove-all']) {
      const response = await fetch(`${origin}${path}`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://elsewhere.example', cookie: browser.header() },
        body: new URLSearchParams({ marker: 'absent' }),
      })
      expect(response.status).toBe(403)
    }
  } finally {
    vi.useRealTimers()
    await app.stop()
    await rm(dataRoot, { recursive: true, force: true })
  }
})

it('keeps logged-out entries for a fresh sign in and forgets everything on sign out of all accounts', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'dsh-phalanx-signed-in-out-'))
  const app = createCommunityApplication({
    listen: { host: '127.0.0.1', port: 0 },
    sessionSecret: 'signed-in-accounts-out-fixture-secret-32b',
    runtime: {
      command: process.execPath,
      args: [fileURLToPath(new URL('./fixtures/runtime.mjs', import.meta.url))],
      dataRoot,
      defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'http://127.0.0.1:1' } },
    },
  })
  try {
    await prepare(dataRoot, ['alice', 'bob'], { username: 'root', password: 'password' })
    const origin = await app.start()
    const browser = jar()
    const request = async (path: string, init: { method?: string; body?: URLSearchParams } = {}) => {
      const response = await fetch(`${origin}${path}`, {
        method: init.method ?? 'GET',
        redirect: 'manual',
        headers: {
          ...(init.body === undefined ? {} : { 'content-type': 'application/x-www-form-urlencoded' }),
          origin,
          cookie: browser.header(),
        },
        ...(init.body === undefined ? {} : { body: init.body }),
      })
      browser.absorb(response)
      return response
    }
    for (const username of ['alice', 'bob'])
      expect((await request('/login', { method: 'POST', body: new URLSearchParams({ username, password: 'password' }) })).status).toBe(303)

    // Logging out keeps the entry listed as needing a fresh sign in; the form stays one link away.
    const logout = await request('/logout', { method: 'POST' })
    expect(logout.status).toBe(303)
    expect(browser.value('dsh-phalanx_session')).toBeUndefined()
    const listed = await request('/login')
    const listedHtml = await listed.text()
    expect(rowOf(listedHtml, 'bob')).toContain('Sign in again')
    expect(rowOf(listedHtml, 'alice')).toContain('account-select')
    const other = await request('/login?other=1')
    const otherHtml = await other.text()
    expect(otherHtml).toContain('Sign in to dsh-phalanx')
    expect(otherHtml).not.toContain('Choose an account')

    // Signing out of all accounts also clears the platform session and the whole list.
    expect((await request('/login', { method: 'POST', body: new URLSearchParams({ username: 'bob', password: 'password' }) })).status).toBe(303)
    // With only the current account retained, logout shows the original form and retains its marker.
    const choices = await (await request('/account/signed-in')).json()
    const alice = choices.accounts.find((account: { username: string }) => account.username === 'alice')
    await request('/account/signed-in/remove', { method: 'POST', body: new URLSearchParams({ marker: alice.marker }) })
    await request('/logout', { method: 'POST' })
    expect(await (await request('/login')).text()).toContain('Sign in to dsh-phalanx')
    expect((await (await request('/account/signed-in')).json()).accounts).toEqual([
      { username: 'bob', admin: false, status: 'reauthentication-required', marker: choices.accounts[0].marker },
    ])
    expect((await request('/login', { method: 'POST', body: new URLSearchParams({ username: 'bob', password: 'password' }) })).status).toBe(303)
    const allOut = await request('/account/signed-in/remove-all', { method: 'POST' })
    expect(allOut.status).toBe(303)
    expect(browser.value('dsh-phalanx_session')).toBeUndefined()
    expect(browser.value('dsh-phalanx_signed_in_accounts')).toBeUndefined()
    const plain = await request('/login')
    const plainHtml = await plain.text()
    expect(plainHtml).toContain('Sign in to dsh-phalanx')
    expect(plainHtml).not.toContain('Choose an account')
  } finally {
    await app.stop()
    await rm(dataRoot, { recursive: true, force: true })
  }
})
