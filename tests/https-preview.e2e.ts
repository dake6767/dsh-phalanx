import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, type Browser, type BrowserContext, type WebSocket } from 'playwright'
import { afterEach, expect, it } from 'vitest'
import { newValidationContext, saveBrowserEvidence } from './fixtures/browser-evidence.js'
import { signInCommunity, selectCommunityWorkspace, runCommunityTerminal } from './fixtures/community-native-browser.js'
import { instanceWorkspacePath } from './support/real-dsh-runtime.js'

interface PreviewAccess {
  origin: string
  administrator: { username: string; password: string }
  bootstrapCredential?: string
}
let browser: Browser | undefined, admin: BrowserContext | undefined
let origin: string | undefined, memberName: string | undefined
afterEach(async test => {
  try {
    await saveBrowserEvidence(test)
    if (admin !== undefined && origin !== undefined && memberName !== undefined) {
      const response = await admin.request.post(`${origin}/admin/api/accounts/${memberName}/actions`, {
        headers: { origin }, data: { action: 'delete' },
      })
      expect(response.status(), 'remove only the owned preview test member').toBe(200)
    }
  } finally {
    await browser?.close()
    browser = undefined; admin = undefined; origin = undefined; memberName = undefined
  }
})

it('uses a trusted nonstandard HTTPS entry for management, Secure cookies, native streaming and WSS', async () => {
  const accessFile = process.env.DSH_PHALANX_PREVIEW_ACCESS_FILE
  const evidence = process.env.DSH_PHALANX_E2E_EVIDENCE_DIR
  if (accessFile === undefined || evidence === undefined) throw new Error('Requires a deployed isolated HTTPS preview and private access/evidence files')
  const access = JSON.parse(await readFile(accessFile, 'utf8')) as PreviewAccess
  const entry = new URL(access.origin)
  if (entry.protocol !== 'https:' || entry.port === '' || entry.port === '443') throw new Error('Preview acceptance requires a nonstandard HTTPS port')
  origin = entry.origin
  browser = await chromium.launch({ headless: true })
  admin = await newValidationContext(browser)
  const page = await admin.newPage()
  // Default context validates the device's installed CA; no ignore flag or SPKI bypass.
  const response = await page.goto(`${origin}/healthz`)
  expect(response?.status()).toBe(200)
  expect((await admin.request.get(`${origin}/healthz`, { headers: { host: entry.hostname } })).status()).toBe(403)
  const security = await response?.securityDetails()
  expect(security?.protocol).toMatch(/^TLS/u)
  if (access.bootstrapCredential !== undefined) {
    const bootstrapPage = await page.goto(`${origin}/bootstrap#credential=${encodeURIComponent(access.bootstrapCredential)}`)
    if (bootstrapPage?.status() === 200) {
      await page.getByLabel('Username').fill(access.administrator.username)
      await page.getByLabel('Password', { exact: true }).fill(access.administrator.password)
      await page.getByRole('button', { name: 'Create administrator' }).click()
      await page.waitForURL(`${origin}/admin`)
    } else expect(bootstrapPage?.status()).toBe(404)
  }
  await signInCommunity(page, origin, access.administrator.username, access.administrator.password, true)
  await page.getByRole('heading', { name: 'Account management' }).waitFor()
  const username = `https-${randomUUID().slice(0, 8)}`, password = randomUUID()
  await page.getByLabel('Username').fill(username)
  await page.getByLabel('Email').fill(`${username}@example.test`)
  await page.getByLabel('Temporary password').fill(password)
  await page.getByRole('button', { name: 'Create account', exact: true }).click()
  await page.getByRole('status').filter({ hasText: `Account ${username} created.` }).waitFor()
  memberName = username
  expect((await admin.request.post(`${origin}/admin/api/accounts`, { headers: { origin: 'https://other.example.test:18443' },
    data: { username: 'forged', email: 'forged@example.test', password } })).status()).toBe(403)
  const context = await newValidationContext(browser), member = await context.newPage()
  const sockets = new Set<WebSocket>(), received = new Set<WebSocket>(), closed = new Set<WebSocket>()
  member.on('websocket', socket => {
    sockets.add(socket)
    socket.on('framereceived', () => { received.add(socket) })
    socket.on('close', () => { closed.add(socket) })
  })
  await signInCommunity(member, origin, username, password)
  const cookies = await context.cookies(origin)
  expect(cookies.some(cookie => cookie.name === 'dsh-phalanx_session')).toBe(true)
  expect(cookies.every(cookie => cookie.secure)).toBe(true)
  await selectCommunityWorkspace(context, member, origin, instanceWorkspacePath('/fixture-host-workspace', true), true)
  await runCommunityTerminal(member, "printf 'HTTPS_%s' 'TERMINAL_READY'; id -u", 'HTTPS_TERMINAL_READY')
  const composer = member.locator('[data-composer-input]')
  await member.evaluate(() => {
    const observation = { partial: false, observer: undefined as MutationObserver | undefined }
    observation.observer = new MutationObserver(() => {
      const paragraphs = [...document.querySelectorAll('p')].map(paragraph => paragraph.textContent ?? '')
      if (paragraphs.some(text => text.includes('HTTPS_STREAM_STARTED')) &&
        !paragraphs.some(text => text.includes('HTTPS_MODEL_READY'))) observation.partial = true
    })
    observation.observer.observe(document.body, { childList: true, subtree: true, characterData: true })
    ;(window as unknown as { previewStream: typeof observation }).previewStream = observation
  })
  await composer.fill('Begin with the uppercase words HTTPS STREAM STARTED joined by underscores. Then write 150 words about secure connections. End with uppercase words HTTPS MODEL READY joined by underscores. Do not use tools.'); await composer.press('Enter')
  await member.locator('p').filter({ hasText: 'HTTPS_MODEL_READY' }).first().waitFor({ timeout: 90_000 })
  const partialStreaming = await member.evaluate(() => {
    const observation = (window as unknown as { previewStream: { partial: boolean; observer: MutationObserver } }).previewStream
    observation.observer.disconnect(); return observation.partial
  })
  expect(partialStreaming, 'native reply becomes visible before its final token').toBe(true)
  expect(sockets.size).toBeGreaterThan(0)
  expect([...sockets].every(socket => new URL(socket.url()).protocol === 'wss:' && new URL(socket.url()).host === entry.host)).toBe(true)
  expect(received.size).toBeGreaterThan(0)
  expect((await context.request.get(`${origin}/admin/api/accounts`)).status()).toBe(403)
  const admittedSockets = [...received].filter(socket => !socket.isClosed())
  expect(admittedSockets.length, 'frame-bearing connections are live immediately before disable').toBeGreaterThan(0)
  const disabled = await admin.request.post(`${origin}/admin/api/accounts/${username}/actions`, { headers: { origin },
    data: { action: 'set-disabled', disabled: true } })
  expect(disabled.status()).toBe(200)
  await expect.poll(() => admittedSockets.every(socket => closed.has(socket) && socket.isClosed()), { timeout: 30_000 }).toBe(true)
  const revoked = await context.request.get(`${origin}/`, { maxRedirects: 0 })
  expect(revoked.status()).toBe(303)
  expect(new URL(revoked.headers().location!, origin).origin).toBe(origin)
  await writeFile(join(evidence, 'https-preview-result.json'), JSON.stringify({ status: 'passed',
    origin, tls: security, certificateBypass: false, secureCookies: true, nativeTerminal: true,
    nativeModel: true, partialStreaming, wss: [...received].map(socket => new URL(socket.url()).pathname), wrongOrigin: 403,
    memberManagementDenied: 403, disabledMemberRedirect: 303, liveFrameBearingSocketsBeforeDisable: admittedSockets.length,
    revocationTrackedByConnectionIdentity: true, revokedWssClosed: true }, null, 2)+'\n', { mode: 0o600 })
}, 600_000)
