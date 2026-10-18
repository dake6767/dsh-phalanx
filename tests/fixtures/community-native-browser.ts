import type { BrowserContext, Page } from 'playwright'
import { expect } from 'vitest'
import { SESSION_LIST } from '../../src/dsh/session-protocol.js'
import { cookieHeader, createBrowserDshRpc } from '../support/real-dsh-rpc.js'
import { ensureWorkspaceSelected } from './real-dsh-browser.js'
/** Native settings moved into the upstream account menu. */
export async function openNativeSettings(page: Page, language: 'en' | 'zh' = 'en'): Promise<void> {
  const accountMenu = language === 'zh' ? '账号菜单' : 'Account menu'
  const settings = language === 'zh' ? '设置' : 'Settings'
  await page.getByRole('button', { name: accountMenu, exact: true }).click()
  await page.getByRole('menuitem', { name: settings, exact: true }).click()
  await page.getByRole('dialog', { name: settings, exact: true }).waitFor()
}

export async function openCommunityAccountMenu(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Platform account:/u }).click()
  await page.getByRole('menuitem', { name: 'Restart instance', exact: true }).waitFor()
}

export async function signInCommunity(page: Page, origin: string, username: string, password: string, admin = false): Promise<void> {
  await page.goto(`${origin}/login`)
  await page.getByLabel('Username', { exact: true }).fill(username)
  await page.getByLabel('Password', { exact: true }).fill(password)
  const submitted = page.waitForResponse(response => new URL(response.url()).pathname === '/login' && response.request().method() === 'POST', { timeout: 300_000 })
  await page.getByRole('button', { name: 'Sign in', exact: true }).click({ noWaitAfter: true })
  expect((await submitted).status()).toBe(303)
  await page.waitForURL(url => url.origin === origin && (admin ? url.pathname === '/admin' : /^\/app\/[^/]+\/$/u.test(url.pathname)), { timeout: 300_000 })
}

export async function selectCommunityWorkspace(context: BrowserContext, page: Page, origin: string, workspace: string, containerMode = false): Promise<void> {
  const rpc = createBrowserDshRpc(context)
  await ensureWorkspaceSelected({ containerMode, sessionCwds: async (world, entryOrigin) =>
    (await rpc.remoteRpc<{ items: { cwd?: string }[] }>(entryOrigin, await cookieHeader(world, entryOrigin), SESSION_LIST, { _request: {} })).items.map(item => item.cwd) },
  context, page, origin, workspace)
}

/** Workspace groups start collapsed in a fresh browser; open the target row once. */
export async function openCommunitySession(page: Page, sessionId: string, workspace = 'Default workspace'): Promise<void> {
  const group = page.getByRole('treeitem', { name: workspace, exact: true })
  if (await group.getAttribute('aria-expanded') === 'false') await group.click({ timeout: 1000 })
  const row = page.locator(`[data-row-key=${JSON.stringify('session:' + sessionId)}]`)
  if (await row.getAttribute('aria-selected') !== 'true') await row.click({ timeout: 1000 })
}

/** The new-session hero can appear before the resident composer binds to its new session. */
export async function startCommunitySession(page: Page): Promise<string> {
  const conversation = page.locator('[data-conversation-content]:visible').filter({ has: page.locator('[data-composer-input]') })
  const previous = await conversation.getAttribute('data-conversation-session')
  await page.getByRole('button', { name: 'New session', exact: true }).first().click()
  let sessionId: string | null = null
  await expect.poll(async () => {
    sessionId = await conversation.getAttribute('data-conversation-session')
    return Boolean(sessionId && sessionId !== previous)
  }, { timeout: 60_000 }).toBe(true)
  await page.getByText('Into the Unknown', { exact: true }).waitFor()
  return sessionId!
}

/** Drive the native editor's keyboard binding and wait for its actual send action. */
export async function sendCommunityPrompt(page: Page, prompt: string): Promise<void> {
  const composer = page.locator('[data-composer-input]')
  await expect.poll(() => composer.getAttribute('contenteditable'), { timeout: 60_000 }).toBe('true')
  await page.keyboard.press('Escape')
  await composer.click()
  await composer.press('ControlOrMeta+A')
  await composer.press('Backspace')
  await composer.pressSequentially(prompt)
  await page.getByRole('button', { name: 'Send message', exact: true }).click({ timeout: 60_000 })
}

export async function runCommunityTerminal(page: Page, command: string, output: string): Promise<void> {
  const expand = page.locator('[data-sidebar-right-expand]')
  // The global native button also works when a stopped instance leaves a stale terminal tab.
  // Workspace hydration can replace the panel or restore its collapsed state during a click.
  await expect.poll(async () => {
    if (await expand.isVisible()) await expand.click({ timeout: 1_000 })
    await page.getByRole('button', { name: /^New terminal/u }).click({ timeout: 1_000 })
    return true
  }, { timeout: 30_000 }).toBe(true)
  await sendCommunityTerminal(page, command, output)
}

/** Send a command to the native terminal already opened in this user session. */
export async function sendCommunityTerminal(page: Page, command: string, output: string): Promise<void> {
  await page.locator('.xterm-helper-textarea:visible').click()
  await page.keyboard.insertText(command)
  await page.keyboard.press('Enter')
  await expect.poll(async () => await page.locator('.xterm-screen').allTextContents(), { timeout: 30_000 }).toEqual(expect.arrayContaining([expect.stringContaining(output)]))
}
