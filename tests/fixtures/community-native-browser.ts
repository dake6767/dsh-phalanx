import type { BrowserContext, Page } from 'playwright'
import { expect } from 'vitest'
import { SESSION_LIST } from '../../src/dsh/session-protocol.js'
import { cookieHeader, createBrowserDshRpc } from '../support/real-dsh-rpc.js'
import { ensureWorkspaceSelected } from './real-dsh-browser.js'
/** Narrow layouts keep the native sidebar inert until its opener is used. */
export async function openCommunitySidebar(page: Page): Promise<void> {
  const opener = page.locator('[data-sidebar-opener]')
  const toggle = page.locator('[data-sidebar-toggle]')
  await toggle.waitFor({ state: 'attached' })
  // ResizeObserver updates the native drawer mode after the viewport itself changes.
  await expect
    .poll(() =>
      toggle.evaluate(element => {
        const narrow = matchMedia('(width < 768px)').matches && !document.documentElement.hasAttribute('data-windows-titlebar')
        return narrow === Boolean(element.closest('[data-sidebar-drawer]'))
      }),
    )
    .toBe(true)
  await expect.poll(async () => (await opener.isVisible()) || (await toggle.isVisible())).toBe(true)
  if (await page.locator('[data-sidebar-drawer][data-sidebar-collapsed]').count()) {
    await opener.click()
    await expect.poll(() => page.locator('[data-sidebar-drawer][data-sidebar-collapsed]').count()).toBe(0)
  }
}

/** The upstream account menu remains available when the platform client fails. */
export async function openNativeSettings(page: Page, language: 'en' | 'zh' = 'en'): Promise<void> {
  await openCommunitySidebar(page)
  const accountMenu = language === 'zh' ? '账号菜单' : 'Account menu'
  const settings = language === 'zh' ? '设置' : 'Settings'
  const gearMenu = language === 'zh' ? '设置菜单' : 'Settings menu'
  await page
    .getByRole('button', { name: gearMenu, exact: true })
    .or(page.getByRole('button', { name: accountMenu, exact: true }))
    .click()
  await page.getByRole('menuitem', { name: settings, exact: true }).click()
  await page.getByRole('dialog', { name: settings, exact: true }).waitFor()
}

export async function openCommunityAccountMenu(page: Page): Promise<void> {
  await openCommunitySidebar(page)
  await page.getByRole('button', { name: /^Platform account:/u }).click()
  await page.getByRole('menuitem', { name: 'Restart instance', exact: true }).waitFor()
}

export async function signInCommunity(page: Page, origin: string, username: string, password: string, admin = false): Promise<void> {
  await page.goto(`${origin}/login?other=1`)
  await page.getByLabel('Username', { exact: true }).fill(username)
  await page.getByLabel('Password', { exact: true }).fill(password)
  const submitted = page.waitForResponse(response => new URL(response.url()).pathname === '/login' && response.request().method() === 'POST', {
    timeout: 300_000,
  })
  await page.getByRole('button', { name: 'Sign in', exact: true }).click({ noWaitAfter: true })
  expect((await submitted).status()).toBe(303)
  await page.waitForURL(url => url.origin === origin && (admin ? url.pathname === '/admin' : /^\/app\/[^/]+\/$/u.test(url.pathname)), { timeout: 300_000 })
  if (!admin) await page.locator('#root').waitFor({ state: 'attached', timeout: 300_000 })
}

export async function selectCommunityWorkspace(context: BrowserContext, page: Page, origin: string, workspace: string, containerMode = false): Promise<void> {
  const rpc = createBrowserDshRpc(context)
  await ensureWorkspaceSelected(
    {
      containerMode,
      sessionCwds: async (world, entryOrigin) =>
        (await rpc.remoteRpc<{ items: { cwd?: string }[] }>(entryOrigin, await cookieHeader(world, entryOrigin), SESSION_LIST, { _request: {} })).items.map(
          item => item.cwd,
        ),
    },
    context,
    page,
    origin,
    workspace,
  )
}

/** Workspace groups start collapsed in a fresh browser; open the target row once. */
export async function openCommunitySession(page: Page, sessionId: string, workspace = 'Default workspace'): Promise<void> {
  const group = page.getByRole('treeitem', { name: workspace, exact: true })
  if ((await group.getAttribute('aria-expanded')) === 'false') await group.click({ timeout: 1000 })
  const row = page.locator(`[data-row-key=${JSON.stringify('session:' + sessionId)}]`)
  if ((await row.getAttribute('aria-selected')) !== 'true') await row.click({ timeout: 1000 })
}

/** Reuse a selected blank, or create another conversation after a turn has started. */
export async function startCommunitySession(page: Page): Promise<string> {
  const conversation = page.locator('[data-conversation-content]:visible').filter({ has: page.locator('[data-composer-input]') })
  const context = page.context(),
    origin = new URL(page.url()).origin,
    rpc = createBrowserDshRpc(context)
  const selectedSession = async () => {
    const current = await conversation.getAttribute('data-conversation-session')
    if (!current || (await conversation.locator('[data-composer-input]').getAttribute('contenteditable')) !== 'true') return undefined
    const row = page.locator(`[data-row-key=${JSON.stringify('session:' + current)}]`)
    if ((await row.count()) !== 1 || (await row.getAttribute('aria-selected')) !== 'true') return undefined
    return current
  }
  const state = async () => {
    const current = await selectedSession()
    if (!current) return undefined
    const sessions = await rpc.remoteRpc<{ items: { sessionId: string; blank: boolean }[] }>(origin, await cookieHeader(context, origin), SESSION_LIST, {
      _request: {},
    })
    const row = sessions.items.find(row => row.sessionId === current)
    if (typeof row?.blank !== 'boolean') return undefined
    if (row.blank && !(await conversation.getByText('Into the Unknown', { exact: true }).isVisible())) return undefined
    if ((await selectedSession()) !== current) return undefined
    return { id: current, blank: row.blank }
  }
  let previous: Awaited<ReturnType<typeof state>>
  await expect.poll(async () => Boolean((previous = await state())), { timeout: 60_000 }).toBe(true)
  if (previous!.blank) return previous!.id
  const previousId = previous!.id
  await page
    .getByRole('button', { name: 'New session', exact: true })
    .filter({ hasNot: page.locator('[data-copy-version]') })
    .first()
    .click()
  let sessionId: string | undefined
  await expect
    .poll(
      async () => {
        const current = await state()
        if (!current?.blank || current.id === previousId) return false
        sessionId = current.id
        return true
      },
      { timeout: 60_000 },
    )
    .toBe(true)
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
  const entry = page.locator('[data-sidebar-right-guide-entry="terminal"]')
  // An existing terminal hides the guide; open a new tab before creating another terminal.
  // Workspace hydration can replace the panel or restore its collapsed state during a click.
  await expect
    .poll(
      async () => {
        if (await expand.isVisible()) await expand.click({ timeout: 1_000 })
        if (!(await entry.isVisible())) await page.locator('[data-dockkit-add-tab]:visible').first().click({ timeout: 1_000 })
        await entry.getByRole('button', { name: /^New terminal/u }).click({ timeout: 1_000 })
        return true
      },
      { timeout: 30_000 },
    )
    .toBe(true)
  await sendCommunityTerminal(page, command, output)
}

/** Send a command to the native terminal already opened in this user session. */
export async function sendCommunityTerminal(page: Page, command: string, output: string): Promise<void> {
  await page.locator('.xterm-helper-textarea:visible').click()
  await page.keyboard.insertText(command)
  await page.keyboard.press('Enter')
  await expect
    .poll(async () => await page.locator('.xterm-screen').allTextContents(), { timeout: 30_000 })
    .toEqual(expect.arrayContaining([expect.stringContaining(output)]))
}
