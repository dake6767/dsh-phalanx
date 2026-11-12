// Validation: T2; real credentials: none; controlled browser/process fixtures.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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

it('operates a member from the ordered menu and requires its password before switching to DSH', async () => {
  root = await mkdtemp(join(tmpdir(), 'member-menu-'))
  const failureMarker = join(root, 'fail-instance'),
    runtimeFixture = join(root, 'runtime.mjs')
  await writeFile(
    runtimeFixture,
    `import {existsSync} from 'node:fs'; if (existsSync(${JSON.stringify(failureMarker)}) && !process.argv.includes('--dump-config')) process.exit(1); await import(${JSON.stringify(new URL('./fixtures/runtime.mjs', import.meta.url).href)});`,
  )
  app = createCommunityApplication({
    listen: { host: '127.0.0.1', port: 0 },
    sessionSecret: 'member-menu-fixture-secret-32-bytes',
    runtime: {
      command: process.execPath,
      args: [runtimeFixture],
      dataRoot: root,
      defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'http://127.0.0.1:1' } },
    },
  })
  const origin = await app.start()
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ locale: 'en' }),
    page = await context.newPage()
  await context.request.post(origin + '/bootstrap', {
    headers: { origin },
    form: { credential: readBootstrapCredential(root)!.credential, username: 'admin', password: 'password' },
    maxRedirects: 0,
  })
  const created = await context.request.post(origin + '/admin/api/accounts', {
    headers: { origin },
    data: { username: 'member', email: '', password: 'member-password' },
  })
  const member = (await created.json()) as { spaceId: string }
  const operate = (client: typeof context.request, username = 'member', spaceId = member.spaceId) =>
    client.post(origin + `/admin/api/accounts/${username}/instance`, { headers: { origin }, data: { action: 'start', confirmed: true, spaceId } })
  expect((await operate(context.request, 'missing')).status()).toBe(400)
  expect((await operate(context.request, 'member', '0'.repeat(32))).status()).toBe(400)
  const memberContext = await browser.newContext()
  await memberContext.request.post(origin + '/login', { headers: { origin }, form: { username: 'member', password: 'member-password' }, maxRedirects: 0 })
  expect((await operate(memberContext.request)).status()).toBe(403)
  await memberContext.close()
  const action = (username: string, data: object) => context.request.post(origin + `/admin/api/accounts/${username}/actions`, { headers: { origin }, data })
  expect((await action('member', { action: 'set-disabled', disabled: true })).status()).toBe(200)
  expect((await operate(context.request)).status()).toBe(400)
  expect((await action('member', { action: 'set-disabled', disabled: false })).status()).toBe(200)
  expect(
    (
      await context.request.post(origin + '/admin/api/accounts', { headers: { origin }, data: { username: 'other', email: '', password: 'password' } })
    ).status(),
  ).toBe(201)
  expect((await action('other', { action: 'set-admin', admin: true })).status()).toBe(200)
  const revoked = await browser.newContext()
  await revoked.request.post(origin + '/login', { headers: { origin }, form: { username: 'other', password: 'password' }, maxRedirects: 0 })
  expect((await action('other', { action: 'set-admin', admin: false, groupId: 'default' })).status()).toBe(200)
  expect((await operate(revoked.request)).status()).toBe(403)
  await revoked.close()
  const menu = async () => {
    await page.getByRole('button', { name: 'More actions for member', exact: true }).click()
  }
  await page.goto(origin + '/admin')
  await menu()
  const labels = await page.getByRole('menuitem').allTextContents()
  expect(labels[0]).toBe('Switch to this member’s DSH')
  expect(labels.indexOf('Start instance')).toBe(labels.indexOf('Reset DSH environment for member') - 1)
  expect(await page.getByRole('separator').count()).toBe(0)
  await page.getByRole('menuitem', { name: 'Start instance', exact: true }).click()
  await page.getByText('Instance operation completed.', { exact: true }).waitFor()
  await menu()
  await page.getByRole('menuitem', { name: 'Restart instance', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Restart instance', exact: true })
  expect(await dialog.textContent()).toContain('Running tasks and terminal commands will be interrupted.')
  await writeFile(failureMarker, 'controlled startup failure')
  await dialog.getByRole('button', { name: 'Restart instance', exact: true }).click()
  await dialog.getByRole('alert').waitFor()
  expect(await dialog.getByRole('alert').textContent()).not.toBe('')
  expect(await page.getByText('Instance operation completed.', { exact: true }).count()).toBe(0)
  await expect
    .poll(
      async () =>
        (await (await context.request.get(origin + '/admin/api/accounts')).json()).items.find((row: { username: string }) => row.username === 'member').instance
          .state,
    )
    .toBe('stopped')
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await menu()
  await page.getByRole('menuitem', { name: 'Start instance', exact: true }).waitFor()
  await rm(failureMarker)
  await page.getByRole('menuitem', { name: 'Start instance', exact: true }).click()
  await page.getByText('Instance operation completed.', { exact: true }).waitFor()
  await menu()
  await page.getByRole('menuitem', { name: 'Restart instance', exact: true }).click()
  await dialog.getByRole('button', { name: 'Restart instance', exact: true }).click()
  await dialog.waitFor({ state: 'detached' })
  await menu()
  await page.getByRole('menuitem', { name: 'Switch to this member’s DSH', exact: true }).click()
  expect(await page.getByLabel('Username', { exact: true }).getAttribute('readonly')).not.toBeNull()
  expect(await page.getByLabel('Username', { exact: true }).inputValue()).toBe('member')
  await page.getByRole('link', { name: 'Cancel', exact: true }).click()
  await page.waitForURL(origin + '/admin')
  await menu()
  await page.getByRole('menuitem', { name: 'Switch to this member’s DSH', exact: true }).click()
  await page.getByLabel('Password', { exact: true }).fill('wrong-password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await page.getByRole('alert').waitFor()
  expect(await page.getByLabel('Username', { exact: true }).inputValue()).toBe('member')
  expect((await context.request.get(origin + '/admin/api/accounts')).status()).toBe(200)
  await page.getByLabel('Password', { exact: true }).fill('member-password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await page.waitForURL(origin + `/app/${member.spaceId}/`)
  await page.locator('#root').waitFor()
  await page.goto(origin + '/login')
  await page.getByRole('button', { name: 'adminAdministrator', exact: true }).click()
  await page.waitForURL(origin + '/admin')
})
