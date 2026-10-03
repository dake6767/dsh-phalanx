import { existsSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { BrowserContext, Page } from 'playwright'
import { expect } from 'vitest'

const onboardingHandled = new WeakSet<Page>()

export interface WorkspaceFixture {
  readonly containerMode: boolean
  readonly sessionCwds: (context: BrowserContext, origin: string) => Promise<readonly (string | undefined)[]>
}

export async function loginAndChooseWorkspace(
  fixture: WorkspaceFixture,
  context: BrowserContext,
  origin: string,
  username: string,
  password: string,
  workspace: string,
  observePage?: (page: Page) => void,
): Promise<Page> {
  const page = await context.newPage()
  observePage?.(page)
  await page.goto(origin)
  await page.getByRole('heading', { name: 'Sign in to dsh-phalanx' }).waitFor()
  await page.getByLabel('Username').fill(username)
  await page.getByLabel('Password').fill(password)
  // The explicit navigation wait owns startup latency after this click.
  await page.getByRole('button', { name: 'Sign in' }).click({ noWaitAfter: true })
  await page.waitForURL(`${origin}/`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
  await ensureWorkspaceSelected(fixture, context, page, origin, workspace)
  return page
}

export async function ensureWorkspaceSelected(
  fixture: WorkspaceFixture,
  context: BrowserContext,
  page: Page,
  origin: string,
  workspace: string,
): Promise<void> {
  if (!onboardingHandled.has(page)) {
    await page.addLocatorHandler(page.getByRole('dialog', { name: 'Preview Notice', exact: true }),
      async dialog => { await dialog.getByRole('button', { name: 'Continue', exact: true }).click() })
    onboardingHandled.add(page)
  }
  const composer = page.locator('[data-composer-input]')
  await composer.waitFor({ state: 'visible', timeout: 120_000 })
  const canonicalWorkspace = fixture.containerMode ? workspace : await canonicalHostPath(workspace)
  let lastObserved: string | undefined
  const hasWorkspaceSession = async (): Promise<boolean> => {
    try {
      const cwds = await fixture.sessionCwds(context, origin)
      lastObserved = JSON.stringify(cwds)
      return cwds.includes(canonicalWorkspace)
    } catch {
      lastObserved = 'session/list request failed'
      return false
    }
  }
  if (await hasWorkspaceSession()) {
    if (await composer.getAttribute('contenteditable') !== 'true') {
      await page.getByRole('button', { name: 'Choose workspace', exact: true }).click()
      const title = basename(workspace) === 'default-workspace' ? 'Default workspace' : basename(workspace)
      await page.getByRole('menuitem', { name: title, exact: true }).click()
    }
  } else {
    await page.getByRole('button', { name: 'Add workspace' }).click()
    await adoptDirectoryViaBrowseDialog(page, workspace)
    try {
      await expect.poll(hasWorkspaceSession, { timeout: 30_000 }).toBe(true)
    } catch (error) {
      const alerts = await page.getByRole('alert').allTextContents().catch(() => [])
      throw new Error(`DSH did not create a Session for workspace ${canonicalWorkspace}; last session/list: ${lastObserved ?? 'not observed'}; alerts: ${JSON.stringify(alerts)}`, { cause: error })
    }
  }
  await expect.poll(async () => await composer.getAttribute('contenteditable'), { timeout: 30_000 }).toBe('true')
}

async function canonicalHostPath(path: string): Promise<string> {
  let existingAncestor = path
  const missingSegments: string[] = []
  while (!existsSync(existingAncestor)) {
    const parent = dirname(existingAncestor)
    if (parent === existingAncestor) throw new Error(`no existing ancestor for ${path}`)
    missingSegments.unshift(basename(existingAncestor))
    existingAncestor = parent
  }
  return join(await realpath(existingAncestor), ...missingSegments)
}

async function adoptDirectoryViaBrowseDialog(page: Page, directory: string): Promise<void> {
  const dialog = page.getByRole('dialog', { name: 'Select Workspace Directory' })
  await dialog.waitFor({ state: 'visible', timeout: 30_000 })
  const pathInput = dialog.getByRole('textbox', { name: 'Edit path' })
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (!await pathInput.isVisible()) await dialog.getByRole('button', { name: 'Edit path' }).click()
    try {
      await pathInput.fill(directory, { timeout: 5_000 })
      await page.keyboard.press('Enter')
      await pathInput.waitFor({ state: 'detached', timeout: 5_000 })
      await expect.poll(async () => (await dialog.getByRole('navigation').locator('button').allTextContents()).at(-1)?.trim(),
        { timeout: 5_000 }).toBe(basename(directory))
      break
    } catch (error) {
      if (attempt === 3) throw error
    }
  }
  await dialog.getByRole('button', { name: 'Edit path', exact: true }).waitFor({ timeout: 30_000 })
  await dialog.getByRole('button', { name: 'Open', exact: true }).click()
}
