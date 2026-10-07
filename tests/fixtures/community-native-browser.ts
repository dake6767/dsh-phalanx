import type { BrowserContext, Page } from 'playwright'
import { expect } from 'vitest'
import { SESSION_LIST } from '../../src/dsh/session-protocol.js'
import { cookieHeader, createBrowserDshRpc } from '../support/real-dsh-rpc.js'
import { ensureWorkspaceSelected } from './real-dsh-browser.js'
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
