// Validation: T2; real credentials: none; controlled browser/process fixtures.
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser } from 'playwright'
import { afterEach, expect, it } from 'vitest'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import type { CommunityApplication } from '../src/ports/community-application.js'
import { removeCommunityFixture } from './fixtures/owned-cleanup.js'
import { createCommunityApplication } from './support/community-application.js'

let app: CommunityApplication | undefined, browser: Browser | undefined, root: string | undefined

afterEach(async () => {
  await browser?.close()
  await app?.stop()
  if (root) await removeCommunityFixture(root)
})

/** Switching accounts from the login page covers every remembered-account seam end to end. */
it('lists remembered accounts, switches without passwords and keeps instances and spaces separate', async () => {
  root = await mkdtemp(join(tmpdir(), 'account-switching-'))
  app = createCommunityApplication({
    listen: { host: '127.0.0.1', port: 0 },
    sessionSecret: 'account-switching-fixture-secret-32-bytes',
    runtime: {
      command: process.execPath,
      args: [fileURLToPath(new URL('./fixtures/runtime.mjs', import.meta.url))],
      dataRoot: root,
      defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'http://127.0.0.1:1' } },
    },
  })
  const origin = await app.start()
  const credential = readBootstrapCredential(root)!.credential
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ locale: 'en' })
  const messages: unknown[] = []
  await context.exposeBinding('captureAccountEvent', (_source, value: unknown) => {
    messages.push(value)
  })
  await context.addInitScript(() => {
    const observer = new BroadcastChannel('dsh-phalanx.account-change')
    observer.onmessage = event => {
      void (window as unknown as { captureAccountEvent: (value: unknown) => Promise<void> }).captureAccountEvent(event.data)
    }
  })
  const page = await context.newPage()
  page.setDefaultTimeout(30_000)
  expect(
    (
      await context.request.post(`${origin}/bootstrap`, { headers: { origin }, form: { credential, username: 'root', password: 'password' }, maxRedirects: 0 })
    ).status(),
  ).toBe(303)
  for (const username of ['alice', 'bob'])
    expect(
      (await context.request.post(`${origin}/admin/api/accounts`, { headers: { origin }, data: { username, email: '', password: 'password' } })).status(),
    ).toBe(201)

  await page.goto(`${origin}/login?other=1`)
  await page.evaluate(() => localStorage.setItem('dsh-phalanx.appearance.v1', 'dark'))
  await page.reload()
  const appearanceCookie = (await context.cookies(origin)).find(cookie => cookie.name === 'dsh-phalanx.appearance.v1')
  expect(appearanceCookie?.value).toBe('dark')
  expect(appearanceCookie?.path).toBe('/')
  expect(appearanceCookie!.expires - Date.now() / 1000).toBeGreaterThan(364 * 24 * 60 * 60)
  expect(await page.evaluate(() => localStorage.getItem('dsh-phalanx.appearance.v1'))).toBeNull()
  await page.evaluate(() => localStorage.setItem('dsh-phalanx.appearance.v1', 'light'))
  await page.reload()
  expect(await page.locator('html').getAttribute('data-theme')).toBe('dark')
  await page.evaluate(() => localStorage.setItem('fixture-account-draft', 'UNSENT'))

  const openAccountList = async () => {
    await page.goto(`${origin}/login`)
    await page.getByRole('heading', { name: 'Choose an account', exact: true }).waitFor()
  }
  const useAnotherAccount = async (username: string, password = 'password') => {
    await openAccountList()
    await page.getByRole('link', { name: 'Use another account', exact: true }).click()
    await page.getByLabel('Username', { exact: true }).fill(username)
    await page.getByLabel('Password', { exact: true }).fill(password)
    await page.getByRole('button', { name: 'Sign in', exact: true }).click({ noWaitAfter: true })
  }
  const memberEntry = async (username: string) => {
    await useAnotherAccount(username)
    await page.waitForURL(url => url.origin === origin && /^\/app\/[a-f0-9]{32}\/$/u.test(url.pathname))
    await page.locator('#root').waitFor({ state: 'attached' })
    return page.url()
  }

  // Signing in as a second member remembers both; each enters their own instance.
  const aliceEntry = await memberEntry('alice')
  const aliceInstance = await page.locator('#root').textContent()
  expect(await page.evaluate(() => localStorage.getItem('fixture-account-draft'))).toBeNull()
  expect((await context.cookies(origin)).find(cookie => cookie.name === 'dsh-phalanx.appearance.v1')?.value).toBe('dark')
  const bobEntry = await memberEntry('bob')
  expect(bobEntry).not.toBe(aliceEntry)
  expect(await page.locator('#root').textContent()).not.toBe(aliceInstance)

  // Switching back from the list needs no password and returns to the same instance.
  await openAccountList()
  await page.getByRole('button', { name: 'alice', exact: true }).click({ noWaitAfter: true })
  await page.waitForURL(aliceEntry)
  await page.locator('#root').waitFor({ state: 'attached' })
  expect(await page.locator('#root').textContent()).toBe(aliceInstance)
  await page.screenshot({ path: join(process.env.DSH_PHALANX_E2E_EVIDENCE_DIR ?? root!, 'account-switch-member.png'), fullPage: true })

  // The switched-away member's space stays fenced for this browser.
  expect((await context.request.get(bobEntry)).status()).toBe(403)

  // Members and the administrator switch through the same list.
  await useAnotherAccount('root')
  await page.waitForURL(`${origin}/admin`)
  expect(await page.locator('html').getAttribute('data-theme')).toBe('dark')
  const managementTab = await context.newPage()
  await managementTab.goto(`${origin}/admin`)
  await managementTab.getByRole('heading', { name: 'Account management', exact: true }).waitFor()
  const recoveryTab = await context.newPage()
  await recoveryTab.goto(`${origin}/recovery`)
  await recoveryTab.getByRole('heading', { name: 'Instance recovery', exact: true }).waitFor()
  await page.getByRole('radio', { name: 'Light', exact: true }).click()
  await expect.poll(() => managementTab.locator('html').getAttribute('data-theme')).toBe('light')
  await expect.poll(() => recoveryTab.locator('html').getAttribute('data-theme')).toBe('light')
  await page.getByRole('radio', { name: 'Dark', exact: true }).click()
  await expect.poll(() => recoveryTab.locator('html').getAttribute('data-theme')).toBe('dark')
  // Exercise the BFCache lifecycle condition explicitly; this does not claim a real cache hit.
  await managementTab.evaluate(() => dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })))
  expect(
    (await context.request.post(`${origin}/admin/api/accounts/bob/actions`, { headers: { origin }, data: { action: 'set-admin', admin: true } })).status(),
  ).toBe(200)
  await page.locator('#admin-sidebar').getByRole('button', { name: 'Switch accounts', exact: true }).click()
  let adminDialog = page.getByRole('dialog', { name: 'Switch accounts', exact: true })
  await adminDialog.getByText('Current account', { exact: true }).waitFor()
  // Switching between administrators also refreshes management when its URL stays the same.
  for (const username of ['bob', 'root']) {
    const switched = page.waitForResponse(response => new URL(response.url()).pathname === '/account/switch' && response.request().method() === 'POST')
    await adminDialog.getByRole('button', { name: username, exact: true }).click({ noWaitAfter: true })
    expect((await switched).status()).toBe(303)
    await page.locator('#admin-sidebar').getByText(username, { exact: true }).waitFor()
    if (username === 'bob') {
      await Promise.all([
        managementTab.waitForEvent('load'),
        managementTab.evaluate(() => dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))),
      ])
      await managementTab.locator('#admin-sidebar').getByText('bob', { exact: true }).waitFor()
    } else await managementTab.getByText(`This browser switched to account ${username}.`, { exact: true }).waitFor()
    await recoveryTab.getByText(`This browser switched to account ${username}.`, { exact: true }).waitFor()
    await page.locator('#admin-sidebar').getByRole('button', { name: 'Switch accounts', exact: true }).click()
    adminDialog = page.getByRole('dialog', { name: 'Switch accounts', exact: true })
    await adminDialog.getByRole('listitem').filter({ hasText: username }).getByText('Current account', { exact: true }).waitFor()
  }
  await page.screenshot({ path: join(process.env.DSH_PHALANX_E2E_EVIDENCE_DIR ?? root!, 'account-switch-management.png'), animations: 'disabled' })
  const adminBob = adminDialog.getByRole('listitem').filter({ hasText: 'bob' })
  await adminBob.getByRole('button', { name: 'More actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Remove', exact: true }).click()
  await expect.poll(() => adminDialog.getByRole('listitem').filter({ hasText: 'bob' }).count()).toBe(0)
  await adminDialog.getByRole('button', { name: 'alice', exact: true }).click({ noWaitAfter: true })
  await page.waitForURL(aliceEntry)
  await page.locator('#root').waitFor({ state: 'attached' })

  // Logging out keeps the entry listed for a fresh sign in; each row can be removed individually.
  await page.goto(`${origin}/recovery`)
  await page.getByRole('button', { name: 'Log out', exact: true }).click({ noWaitAfter: true })
  await page.waitForURL(`${origin}/login`)
  await managementTab.getByText('This browser signed out.', { exact: true }).waitFor()
  await recoveryTab.getByText('This browser signed out.', { exact: true }).waitFor()
  await openAccountList()
  const aliceRow = page.locator('li.account-item').filter({ hasText: 'alice' })
  expect(await aliceRow.textContent()).toContain('Sign in again')
  await aliceRow.locator('summary').click()
  await aliceRow.getByRole('button', { name: 'Remove', exact: true }).click({ noWaitAfter: true })
  await page.waitForURL(`${origin}/login`)
  await page.getByRole('heading', { name: 'Choose an account', exact: true }).waitFor()
  expect(await page.locator('li.account-item').filter({ hasText: 'alice' }).count()).toBe(0)

  // Signing out of all accounts returns the plain form.
  await page.getByRole('button', { name: 'Sign out of all accounts', exact: true }).click({ noWaitAfter: true })
  await page.waitForURL(`${origin}/login`)
  await page.getByRole('heading', { name: 'Sign in to dsh-phalanx', exact: true }).waitFor()
  await expect.poll(() => messages.filter(value => (value as { type?: string }).type === 'signed-out-all').length).toBeGreaterThan(0)
  expect(messages.length).toBeGreaterThan(0)
  for (const value of messages) {
    expect(Object.keys(value as object)).toEqual(['type'])
    expect(['switched', 'logged-out', 'signed-out-all']).toContain((value as { type: string }).type)
  }
  await managementTab.close()
  await recoveryTab.close()
  await page.getByLabel('Username', { exact: true }).fill('alice')
  await page.getByLabel('Password', { exact: true }).fill('password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click({ noWaitAfter: true })
  await page.waitForURL(aliceEntry)
  await page.locator('#root').waitFor({ state: 'attached' })
}, 300_000)
