import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser } from 'playwright'
import { afterEach, expect, it } from 'vitest'
import { createCommunityApplication } from '../src/composition/community-application.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import type { CommunityApplication } from '../src/ports/community-application.js'
import { CommunitySystemUpdateUnavailableError, type CommunitySystemUpdatePort } from '../src/ports/community-system-update.js'
import type { CommunitySystemUpdateOperation } from '../src/domain/admin-contract.js'

let app: CommunityApplication | undefined
let browser: Browser | undefined
let root: string | undefined
afterEach(async () => { await browser?.close(); await app?.stop(); if (root) await rm(root, { recursive: true, force: true }) })
it('prepares manually, cancels without applying and reconnects to the accepted operation after a lost response and refresh', async () => {
  let operation: CommunitySystemUpdateOperation | null = null
  let blockStatus = false
  let statusEntered!: () => void; let releaseStatus!: () => void
  const statusBlocked = new Promise<void>(resolve => { statusEntered = resolve })
  const statusReleased = new Promise<void>(resolve => { releaseStatus = resolve })
  let checks = 0; let applies = 0; let failCheck = false
  let submitted!: () => void
  const accepted = new Promise<void>(resolve => { submitted = resolve })
  const statusCalls: (string | undefined)[] = []
  const port: CommunitySystemUpdatePort = {
    status: async id => { statusCalls.push(id); if (blockStatus) { blockStatus = false; statusEntered(); await statusReleased; return { currentVersion: 'v0.1.2', runningVersion: 'v0.1.2', operation: null, events: [] } } return { currentVersion: 'v0.1.2', runningVersion: 'v0.1.2', operation, events: [] } },
    check: async () => { checks++; return { currentVersion: 'v0.1.2', runningVersion: 'v0.1.2', operation, events: [], check: failCheck ? { status: 'failed', checkedAt: '2026-10-05T00:00:00Z', reason: 'Release source unavailable' } : { status: 'available', checkedAt: '2026-10-05T00:00:00Z', version: 'v0.1.3', manifestSha256: 'a'.repeat(64), releaseNotes: '<script>untrusted()</script>\nUpdate notes.' } } },
    prepare: async () => { operation = { id: '12345678-1234-1234-1234-123456789abc', phase: 'prepared', targetVersion: 'v0.1.3', sourceVersion: 'v0.1.2', targetCommit: 'b'.repeat(40), platformSha256: 'a'.repeat(64), imageDigest: `sha256:${'c'.repeat(64)}` }; return { operation } },
    apply: async () => { applies++; operation = { ...operation!, phase: 'stopping' }; submitted(); throw new CommunitySystemUpdateUnavailableError('Connection lost after acceptance') },
  }
  root = await mkdtemp(join(tmpdir(), 'system-update-browser-'))
  app = createCommunityApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'system-update-browser-fixture-32-bytes', runtime: { command: '/unavailable-dsh', args: [], dataRoot: root, defaultModel: { provider: 'deepseek-official', model: 'deepseek-chat', upstream: { baseUrl: 'https://api.deepseek.com' } } } }, { systemUpdate: port })
  const origin = await app.start(); browser = await chromium.launch({ headless: true })
  const context = await browser.newContext(); const page = await context.newPage(); page.setDefaultTimeout(15_000)
  await page.goto(`${origin}/bootstrap#credential=${readBootstrapCredential(root)!.credential}`)
  await page.getByLabel('Username', { exact: true }).fill('admin'); await page.getByLabel('Password', { exact: true }).fill('password')
  await page.getByRole('button', { name: 'Create administrator' }).click(); await page.waitForURL(`${origin}/admin`)
  await page.getByRole('link', { name: 'System update', exact: true }).click()
  const panel = page.getByRole('region', { name: 'System update', exact: true })
  await panel.getByText('Running version: v0.1.2', { exact: true }).waitFor()
  expect(checks).toBe(0)
  await panel.getByRole('button', { name: 'Check for updates', exact: true }).click()
  await panel.getByText('Formal update available: v0.1.3', { exact: true }).waitFor()
  expect(await panel.locator('script').count()).toBe(0)
  expect(await panel.locator('pre').textContent()).toContain('<script>untrusted()</script>')
  blockStatus = true; await statusBlocked
  await panel.getByRole('button', { name: 'Download update', exact: true }).click()
  await panel.getByText('Downloaded and verified; ready to apply.', { exact: true }).waitFor()
  await panel.getByRole('button', { name: 'Apply update', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Apply update: v0.1.3', exact: true })
  expect(await dialog.textContent()).toMatch(/all running tasks.*unsaved/iu)
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); expect(applies).toBe(0)
  const staleResponse = page.waitForResponse(response => response.url().includes('/admin/api/system-update') && response.request().method() === 'GET'); releaseStatus(); await staleResponse
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  statusCalls.length = 0
  await page.reload(); await panel.getByText('Downloaded and verified; ready to apply.', { exact: true }).waitFor()
  expect(statusCalls[0]).toBe('12345678-1234-1234-1234-123456789abc')
  await panel.getByRole('button', { name: 'Apply update', exact: true }).click()
  await dialog.getByRole('button', { name: 'Confirm and apply now', exact: true }).click(); await accepted
  await panel.getByText(/Reconnecting to the original update/u).waitFor()
  operation = { ...operation!, phase: 'restored', failure: 'Target failed readiness' }
  await panel.getByText('Update failed; the previous version was restored.', { exact: true }).waitFor()
  expect(await panel.getByRole('alert').count()).toBe(0)
  await page.reload(); await panel.getByText('Update failed; the previous version was restored.', { exact: true }).waitFor()
  expect(applies).toBe(1); expect(statusCalls).toContain(operation.id)
  expect(await panel.textContent()).toContain('Running version: v0.1.2')
  failCheck = true
  await panel.getByRole('button', { name: 'Check for updates', exact: true }).click()
  await panel.getByText('Update availability unknown: Release source unavailable', { exact: true }).waitFor()
  expect(await panel.getByText('Formal update available: v0.1.3', { exact: true }).count()).toBe(0)
})
