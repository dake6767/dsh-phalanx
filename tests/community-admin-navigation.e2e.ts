// Validation: T1; real credentials: none; controlled browser/process fixtures. CI selects its explicit public-entry subset.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser } from 'playwright'
import { afterEach, expect, it } from 'vitest'
import { createCommunityApplication } from '../src/composition/community-application.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import type { CommunityApplication } from '../src/ports/community-application.js'
let app: CommunityApplication | undefined
let browser: Browser | undefined
let root: string | undefined
afterEach(async () => { await browser?.close(); await app?.stop(); if (root) await rm(root, { recursive: true, force: true }) })
it('keeps management addresses, appearance and mobile navigation accessible across refresh', async () => {
  root = await mkdtemp(join(tmpdir(), 'admin-navigation-'))
  app = createCommunityApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'navigation-fixture-session-secret-32-bytes', runtime: { command: '/unavailable-dsh', args: [], dataRoot: root, defaultModel: { provider: 'deepseek-official', model: 'deepseek-chat', upstream: { baseUrl: 'https://api.deepseek.com' } } } })
  const origin = await app.start(); browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ locale: 'en', colorScheme: 'dark' }); page.setDefaultTimeout(10_000)
  await page.goto(`${origin}/bootstrap#credential=${readBootstrapCredential(root)!.credential}`)
  await page.getByLabel('Username', { exact: true }).fill('admin'); await page.getByLabel('Password', { exact: true }).fill('password')
  await page.getByRole('button', { name: 'Create administrator' }).click(); await page.waitForURL(`${origin}/admin`)
  await page.getByRole('heading', { name: 'Account management', exact: true }).waitFor()
  expect(await page.locator('html').getAttribute('data-theme')).toBe('dark')
  await page.getByRole('radio', { name: 'Light', exact: true }).click()
  for (const [path, title] of [['usage-records', 'Usage records'], ['groups', 'Group management'], ['models', 'Model management'], ['settings', 'System settings'], ['accounts', 'Account management']] as const) {
    await page.getByRole('link', { name: title, exact: true }).click(); await page.waitForURL(`${origin}/admin/${path}`)
    await page.reload(); await page.getByRole('heading', { name: title, exact: true }).waitFor()
    expect(await page.locator('html').getAttribute('data-theme')).toBe('light')
    expect(await page.getByRole('radio', { name: 'Light', exact: true }).getAttribute('aria-checked')).toBe('true')
  }
  let checking = true;
  await page.route('**/admin/api/experts', route => route.fulfill({ json: { revision: '1', models: [], plugins: [], mcp: [], experts: [{ id: 'writer', revision: 1, name: 'Fixture writer', description: 'Writes', icon: '', persona: 'Write.', published: false, skills: [], skillPacks: [], plugins: [], mcp: [], examples: [], model: null, modelLabel: null, modelUnavailable: false, missing: ['skill:missing'], failures: [{ username: 'member', entries: ['preset'] }], ...(checking ? { checking: ['member'] } : {}) }] } }));
  await page.goto(`${origin}/admin/experts`);
  await page.getByText('Checking capabilities…', { exact: true }).waitFor();
  await page.getByText('Unavailable entries', { exact: true }).waitFor();
  await page.getByText('Expert load failed for member', { exact: true }).waitFor();
  checking = false;
  await expect.poll(() => page.getByText('Checking capabilities…', { exact: true }).count(), { timeout: 15000 }).toBe(0);
  await page.getByText('Expert load failed for member', { exact: true }).waitFor();
  await page.unroute('**/admin/api/experts');
  checking = true;
  await page.route('**/admin/api/plugins', route => route.fulfill({ json: [{ packageName: 'example', version: '1', currentVersion: '1', source: 'npm', title: 'Fixture plugin', description: '', stage: 'available', published: false, failures: [{ username: 'member', code: 'plugin-managed-load-failed' }], ...(checking ? { checking: ['member'] } : {}) }] }));
  await page.goto(`${origin}/admin/plugins`);
  await page.getByText('Checking capabilities…', { exact: true }).waitFor();
  await page.getByText('Load failed for 1 members.', { exact: true }).waitFor();
  checking = false;
  await expect.poll(() => page.getByText('Checking capabilities…', { exact: true }).count(), { timeout: 15000 }).toBe(0);
  await page.getByText('Load failed for 1 members.', { exact: true }).waitFor();
  await page.unroute('**/admin/api/plugins');
  await page.goto(`${origin}/admin#model-settings`); await page.waitForURL(`${origin}/admin/models`)
  await page.setViewportSize({ width: 390, height: 844 }); await page.reload()
  await page.getByRole('button', { name: 'Open navigation', exact: true }).click()
  await page.getByRole('link', { name: 'System settings', exact: true }).click()
  await page.getByRole('heading', { name: 'System settings', exact: true }).waitFor()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  const limits = page.getByRole('region', { name: 'Member instances', exact: true })
  await limits.getByText('Limits do not apply in development mode.', { exact: true }).waitFor()
  await limits.getByText('Member containers have no limits.', { exact: true }).waitFor()
  await limits.getByLabel('CPU (cores)', { exact: true }).fill('invalid')
  await limits.getByRole('button', { name: 'Save instance limits', exact: true }).click()
  await limits.getByRole('alert').filter({ hasText: 'Enter positive resource limits' }).waitFor()
  expect((await (await page.request.get(`${origin}/admin/api/instance-resources`)).json()).revision).toBe(0)
  await limits.getByLabel('Idle reclamation (seconds)', { exact: true }).fill('0')
  await limits.getByLabel('CPU (cores)', { exact: true }).fill('0.5')
  await limits.getByLabel('Memory (MiB)', { exact: true }).fill('512')
  await limits.getByLabel('Processes', { exact: true }).fill('64')
  await limits.getByRole('button', { name: 'Save instance limits', exact: true }).click()
  await limits.getByRole('status').filter({ hasText: 'Instance limits saved.' }).waitFor()
  await page.reload(); await limits.getByLabel('CPU (cores)', { exact: true }).waitFor()
  expect(await limits.getByLabel('CPU (cores)', { exact: true }).inputValue()).toBe('0.5')
  const settings = await (await page.request.get(`${origin}/admin/api/instance-resources`)).json()
  expect(settings.idleSeconds).toBe(0)
  await limits.getByLabel('Idle reclamation (seconds)', { exact: true }).fill('60')
  await limits.getByRole('button', { name: 'Use suggested limits', exact: true }).click()
  expect(await limits.getByLabel('Memory (MiB)', { exact: true }).inputValue()).toBe(String(settings.suggested.memoryMiB))
  await page.getByRole('button', { name: 'Open navigation', exact: true }).click()
  await page.getByRole('link', { name: 'Account management', exact: true }).click()
  const resourceGuard = page.getByRole('dialog', { name: 'Unsaved changes', exact: true })
  await resourceGuard.getByRole('button', { name: 'Discard changes', exact: true }).click()
  await page.waitForURL(`${origin}/admin/accounts`)
  const persisted = await (await page.request.get(`${origin}/admin/api/instance-resources`)).json()
  expect(persisted.defaults).toEqual({ cpus: 0.5, memoryMiB: 512, pids: 64 }); expect(persisted.idleSeconds).toBe(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect((await page.request.get(`${origin}/admin/models`)).status()).toBe(200)
  expect((await (await browser.newContext({ locale: 'en' })).request.get(`${origin}/admin/assets/missing.js`, { maxRedirects: 0 })).status()).toBe(303)
})

it('creates and edits accounts in drawers, keeps failed drafts, and protects independent account actions', async () => {
  root = await mkdtemp(join(tmpdir(), 'admin-drawers-'))
  app = createCommunityApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'drawers-fixture-session-secret-32-bytes', runtime: { command: '/unavailable-dsh', args: [], dataRoot: root, defaultModel: { provider: 'deepseek-official', model: 'deepseek-chat', upstream: { baseUrl: 'https://api.deepseek.com' } } } })
  const origin = await app.start(); browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ locale: 'en', colorScheme: 'dark' }); page.setDefaultTimeout(10_000)
  await page.goto(`${origin}/bootstrap#credential=${readBootstrapCredential(root)!.credential}`)
  await page.getByLabel('Username', { exact: true }).fill('admin'); await page.getByLabel('Password', { exact: true }).fill('password')
  await page.getByRole('button', { name: 'Create administrator' }).click(); await page.waitForURL(`${origin}/admin`)
  for (const username of ['member', 'other']) {
    await page.getByRole('button', { name: 'Add account', exact: true }).click()
    const drawer = page.getByRole('dialog', { name: 'Create a member', exact: true })
    await drawer.getByLabel('Username', { exact: true }).fill(username); await drawer.getByLabel('Email', { exact: true }).fill(`${username}@example.test`)
    await drawer.getByLabel('Temporary password').fill('password')
    await drawer.getByRole('button', { name: 'Create account', exact: true }).click()
    await drawer.waitFor({ state: 'detached' }); await page.getByRole('row').filter({ hasText: `${username}@example.test` }).waitFor()
  }
  await page.getByRole('button', { name: 'Edit member', exact: true }).click()
  const drawer = page.getByRole('dialog', { name: 'Edit account: member', exact: true })
  expect(await drawer.getByLabel('Username', { exact: true }).getAttribute('readonly')).not.toBeNull()
  expect(await drawer.getByText('Space ID', { exact: true }).count()).toBe(1)
  const limits = drawer.getByRole('region', { name: 'Instance resource limits', exact: true })
  await limits.getByRole('button', { name: /Limit source/u }).click()
  await page.getByRole('option', { name: 'Custom limits', exact: true }).click()
  await limits.getByLabel('CPU (cores)', { exact: true }).fill('2')
  await limits.getByText('Resident instance', { exact: true }).click()
  await drawer.getByLabel('Email', { exact: true }).fill('discarded@example.test')
  await drawer.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.getByRole('dialog', { name: 'Unsaved changes', exact: true }).getByRole('button', { name: 'Discard changes', exact: true }).click()
  await drawer.waitFor({ state: 'detached' })
  await page.getByRole('button', { name: 'Edit member', exact: true }).click()
  expect(await drawer.getByLabel('Email', { exact: true }).inputValue()).toBe('member@example.test')
  await expect.poll(() => limits.getByRole('checkbox', { name: 'Resident instance', exact: true }).isChecked()).toBe(false)
  await limits.getByRole('button', { name: /Limit source/u }).click()
  await page.getByRole('option', { name: 'Custom limits', exact: true }).click()
  await limits.getByLabel('CPU (cores)', { exact: true }).fill('2')
  await limits.getByLabel('Memory (MiB)', { exact: true }).fill('1024')
  await limits.getByLabel('Processes', { exact: true }).fill('256')
  await limits.getByText('Resident instance', { exact: true }).click()
  await drawer.getByRole('button', { name: 'Save changes', exact: true }).click(); await drawer.waitFor({ state: 'detached' })
  expect(await (await page.request.get(`${origin}/admin/api/instance-resources?username=member`)).json()).toMatchObject({ resident: true, source: 'custom', target: { cpus: 2, memoryMiB: 1024, pids: 256 } })
  await page.getByRole('button', { name: 'Edit member', exact: true }).click()

  await drawer.getByLabel('Email', { exact: true }).fill('OTHER@EXAMPLE.TEST')
  await drawer.getByRole('button', { name: 'Save changes', exact: true }).click()
  await drawer.getByRole('alert').filter({ hasText: 'Email is already in use' }).waitFor()
  expect(await drawer.getByLabel('Email', { exact: true }).inputValue()).toBe('OTHER@EXAMPLE.TEST')
  await drawer.getByRole('button', { name: 'Cancel', exact: true }).click()
  const guard = page.getByRole('dialog', { name: 'Unsaved changes', exact: true })
  await guard.getByRole('button', { name: 'Save changes', exact: true }).click()
  await guard.waitFor({ state: 'detached' })
  await drawer.getByRole('alert').filter({ hasText: 'Email is already in use' }).waitFor()
  await drawer.getByLabel('Email', { exact: true }).fill('invalid-email')
  await drawer.getByRole('button', { name: 'Cancel', exact: true }).click()
  await guard.getByRole('button', { name: 'Save changes', exact: true }).click()
  await guard.waitFor({ state: 'detached' })
  await drawer.getByRole('alert').filter({ hasText: 'enter a valid email' }).waitFor()
  expect(await drawer.getByLabel('Email', { exact: true }).inputValue()).toBe('invalid-email')
  await drawer.getByRole('button', { name: 'Cancel', exact: true }).click()
  await guard.getByRole('button', { name: 'Continue editing', exact: true }).click()
  await drawer.getByLabel('Email', { exact: true }).fill('changed@example.test')
  await drawer.getByRole('button', { name: 'Cancel', exact: true }).click()
  await guard.getByRole('button', { name: 'Save changes', exact: true }).click()
  await drawer.waitFor({ state: 'detached' }); await page.getByRole('row').filter({ hasText: 'changed@example.test' }).waitFor()
  await page.getByRole('button', { name: 'Edit member', exact: true }).click()
  await drawer.getByLabel('Email', { exact: true }).fill('unsaved@example.test')
  await guard.waitFor({ state: 'detached' })
  await drawer.getByRole('heading', { name: 'Edit account: member', exact: true }).hover()
  const headingBox = (await drawer.getByRole('heading', { name: 'Edit account: member', exact: true }).boundingBox())!
  const drawerBox = (await drawer.boundingBox())!
  await page.mouse.move(headingBox.x + 8, headingBox.y + headingBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(headingBox.x + drawerBox.width * 0.5, headingBox.y + headingBox.height / 2, { steps: 8 })
  await page.mouse.up()
  expect(await guard.count()).toBe(0)
  expect((await drawer.boundingBox())!.x).toBeCloseTo(drawerBox.x, 0)
  expect(await drawer.getByLabel('Email', { exact: true }).inputValue()).toBe('unsaved@example.test')
  await page.keyboard.press('Escape'); await guard.getByRole('button', { name: 'Discard changes', exact: true }).click(); await drawer.waitFor({ state: 'detached' })
  await expect.poll(() => page.getByRole('button', { name: 'Edit member', exact: true }).evaluate(element => element === document.activeElement)).toBe(true)
  await page.getByRole('button', { name: 'More actions for member', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Make member an administrator', exact: true }).click()
  const role = page.getByRole('dialog', { name: 'Make administrator: member', exact: true })
  await role.getByRole('button', { name: 'Confirm action', exact: true }).click(); await role.waitFor({ state: 'detached' })
  const accounts = await (await page.request.get(`${origin}/admin/api/accounts`)).json()
  expect(accounts.items.find((row: { username: string }) => row.username === 'member')).toMatchObject({ email: 'changed@example.test', admin: true })
  await page.setViewportSize({ width: 390, height: 844 }); await page.getByRole('button', { name: 'Edit member', exact: true }).click()
  await drawer.getByLabel('Email', { exact: true }).fill('mobile@example.test'); await drawer.getByRole('button', { name: 'Save changes', exact: true }).click(); await drawer.waitFor({ state: 'detached' })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: join(process.env.DSH_PHALANX_E2E_EVIDENCE_DIR ?? root!, 'phalanx-accounts-dark-mobile.png'), fullPage: true })
  await page.getByRole('button', { name: 'Edit member', exact: true }).click()
  await drawer.getByLabel('Email', { exact: true }).fill('double@example.test')
  let entered!: () => void; let release!: () => void; let submissions = 0
  const admitted = new Promise<void>(resolve => { entered = resolve }); const released = new Promise<void>(resolve => { release = resolve })
  await page.route('**/admin/api/accounts/member/actions', async route => { submissions++; entered(); await released; await route.continue(); })
  await drawer.getByRole('button', { name: 'Save changes', exact: true }).dblclick(); await admitted
  expect(await drawer.getByRole('button', { name: 'Saving…', exact: true }).isDisabled()).toBe(true)
  release(); await drawer.waitFor({ state: 'detached' }); expect(submissions).toBe(1)
  await page.unroute('**/admin/api/accounts/member/actions')
  await page.getByRole('button', { name: 'Edit member', exact: true }).click()
  await drawer.getByLabel('Email', { exact: true }).fill('deleted@example.test')
  expect((await page.request.post(`${origin}/admin/api/accounts/member/actions`, { data: { action: 'delete' }, headers: { origin } })).status()).toBe(200)
  await drawer.getByRole('button', { name: 'Save changes', exact: true }).click()
  await drawer.getByRole('alert').filter({ hasText: 'Account was not found' }).waitFor()
  expect(await drawer.getByLabel('Email', { exact: true }).inputValue()).toBe('deleted@example.test')
  await drawer.screenshot({ path: join(process.env.DSH_PHALANX_E2E_EVIDENCE_DIR ?? root!, 'phalanx-account-drawer-dark-mobile.png') })

})
