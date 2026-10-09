import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { afterEach, expect, it } from 'vitest'
import { createCommunityApplication } from '../src/composition/community-application.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import type { CommunityApplication } from '../src/ports/community-application.js'
import type { CommunityGroupView } from '../src/domain/admin-contract.js'
let app: CommunityApplication | undefined
let browser: Browser | undefined
let root: string | undefined
afterEach(async () => { await browser?.close(); await app?.stop(); if (root) await rm(root, { recursive: true, force: true }) })
const select = async (page: Page, label: string, option: string) => {
  await page.getByRole('button', { name: new RegExp(label) }).click()
  await page.getByRole('option', { name: option, exact: true }).click()
}
it('manages groups, membership, defaults and administrator transitions through HeroUI', async () => {
  root = await mkdtemp(join(tmpdir(), 'community-groups-'))
  app = createCommunityApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'groups-fixture-session-secret-32-bytes', runtime: { command: '/unavailable-dsh', args: [], dataRoot: root, defaultModel: { provider: 'deepseek-official', model: 'deepseek-chat', upstream: { baseUrl: 'https://api.deepseek.com' } } } })
  const origin = await app.start(); browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ locale: 'en' }); page.setDefaultTimeout(15_000)
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
  await page.goto(`${origin}/bootstrap#credential=${readBootstrapCredential(root)!.credential}`)
  await page.getByLabel('Username', { exact: true }).fill('admin'); await page.getByLabel('Password', { exact: true }).fill('password')
  await page.getByRole('button', { name: 'Create administrator' }).click(); await page.waitForURL(`${origin}/admin`)
  await page.getByRole('link', { name: 'Group management', exact: true }).click()
  await page.getByRole('button', { name: 'Create group', exact: true }).click()
  await page.getByLabel('Group name', { exact: true }).fill('Research')
  await page.getByRole('button', { name: 'Confirm action', exact: true }).click()
  const research = page.getByRole('row').filter({ hasText: 'Research' })
  await research.waitFor()
  await research.getByRole('button', { name: 'Set as default', exact: true }).click()
  await page.getByText('The new default applies only to accounts created afterward.', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Confirm action', exact: true }).click()
  await research.getByText('Default for new accounts', { exact: true }).waitFor()
  expect(await research.getByRole('button', { name: 'Delete group', exact: true }).isDisabled()).toBe(true)
  await page.getByRole('link', { name: 'Account management', exact: true }).click()
  await page.getByRole('button', { name: 'Add account', exact: true }).click()
  let dialog = page.getByRole('dialog', { name: 'Create a member', exact: true })
  expect(await dialog.getByRole('button', { name: /Group/ }).innerText()).toContain('Research')
  await dialog.getByLabel('Username', { exact: true }).fill('member'); await dialog.getByLabel('Email', { exact: true }).fill('member@example.test'); await dialog.getByLabel('Temporary password').fill('password')
  await dialog.getByRole('button', { name: 'Create account', exact: true }).click(); await dialog.waitFor({ state: 'detached' })
  const legacy = new DatabaseSync(join(root, 'community-accounts.db'))
  legacy.prepare('UPDATE accounts SET email = NULL WHERE username = ?').run('member'); legacy.close()
  await page.reload()
  await page.getByRole('button', { name: 'Edit member', exact: true }).click()
  dialog = page.getByRole('dialog', { name: 'Edit account: member', exact: true })
  await select(page, 'Group', 'Default group')
  await dialog.getByRole('button', { name: 'Save changes', exact: true }).click(); await dialog.waitFor({ state: 'detached' })
  const memberAfter = await (await page.request.get(`${origin}/admin/api/accounts`)).json()
  expect(memberAfter.items.find((account: { username: string }) => account.username === 'member')).toMatchObject({ email: '', groupId: 'default' })
  await select(page, 'Filter by group', 'Research')
  expect(await page.getByRole('button', { name: 'Edit member', exact: true }).count()).toBe(0)
  await select(page, 'Filter by group', 'Administrators')
  expect(await page.getByRole('button', { name: 'Disable admin', exact: true }).isDisabled()).toBe(true)
  await select(page, 'Filter by group', 'All groups')
  await page.getByRole('button', { name: 'More actions for member', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Make member an administrator', exact: true }).click()
  await page.getByRole('button', { name: 'Confirm action', exact: true }).click()
  await page.getByRole('dialog').filter({ has: page.getByRole('button', { name: 'Confirm action', exact: true }) }).waitFor({ state: 'detached' })
  await page.getByRole('button', { name: 'More actions for member', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Remove administrator role from member', exact: true }).click()
  expect(await page.getByRole('button', { name: /Target group/ }).innerText()).toContain('Research')
  await select(page, 'Target group', 'Default group')
  await page.getByRole('button', { name: 'Confirm action', exact: true }).click(); await page.getByRole('dialog').filter({ has: page.getByRole('button', { name: 'Confirm action', exact: true }) }).waitFor({ state: 'detached' })
  const groups = await (await page.request.get(`${origin}/admin/api/groups`)).json() as CommunityGroupView[]
  expect(groups.find(group => group.id === 'admin')?.memberCount).toBe(1)
  expect(groups.find(group => group.id === 'default')?.memberCount).toBe(1)
  const researchId = groups.find(group => group.name === 'Research')!.id
  const refused = await page.request.post(`${origin}/admin/api/groups`, { data: { action: 'set-default', id: researchId, confirmed: false } })
  expect(refused.status()).toBe(400); expect(await refused.json()).toMatchObject({ code: 'group-action-invalid' })
  await page.getByRole('link', { name: 'Group management', exact: true }).click()
  await research.getByRole('button', { name: 'Rename group', exact: true }).click()
  await page.getByLabel('Group name').fill('Lab'); await page.getByRole('button', { name: 'Confirm action', exact: true }).click()
  await page.getByRole('row').filter({ hasText: 'Lab' }).waitFor()
  await page.getByRole('row').filter({ hasText: 'Default group' }).getByRole('button', { name: 'Set as default', exact: true }).click()
  await page.getByRole('button', { name: 'Confirm action', exact: true }).click(); await page.getByRole('dialog').filter({ has: page.getByRole('button', { name: 'Confirm action', exact: true }) }).waitFor({ state: 'detached' })
  await page.getByRole('row').filter({ hasText: 'Lab' }).getByRole('button', { name: 'Delete group', exact: true }).click()
  await page.getByRole('button', { name: 'Confirm action', exact: true }).click(); await page.getByRole('row').filter({ hasText: 'Lab' }).waitFor({ state: 'detached' })
  const evidence = process.env.DSH_PHALANX_E2E_EVIDENCE_DIR
  if (evidence) { await mkdir(evidence, { recursive: true }); await page.screenshot({ path: join(evidence, 'groups-desktop.png'), fullPage: true }) }
  await select(page, 'Platform language', '简体中文')
  await page.getByRole('heading', { name: '分组管理', exact: true }).waitFor()
  await page.getByRole('dialog').waitFor({ state: 'detached' })
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  if (evidence) await page.screenshot({ path: join(evidence, 'groups-mobile.png'), fullPage: true })
  expect(errors).toEqual([])
})
