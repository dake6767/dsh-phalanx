import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser } from 'playwright'
import { afterEach, expect, it } from 'vitest'
import { BusinessRuleError } from '../src/domain/business-error.js'
import { createCommunityApplication } from '../src/composition/community-application.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import type { CommunityApplication } from '../src/ports/community-application.js'
import { CommunitySystemUpdateUnavailableError, type CommunitySystemUpdatePort } from '../src/ports/community-system-update.js'
import type { CommunitySystemUpdateOperation, CommunitySystemUpdateEvent } from '../src/domain/admin-contract.js'

let app: CommunityApplication | undefined
let browser: Browser | undefined
let root: string | undefined
afterEach(async () => { await browser?.close(); await app?.stop(); if (root) await rm(root, { recursive: true, force: true }) })
it('prepares manually, cancels without applying and reconnects to the accepted operation after a lost response and refresh', async () => {
  let operation: CommunitySystemUpdateOperation | null = null
  let events: CommunitySystemUpdateEvent[] = []
  let blockStatus = false
  let unavailable = false
  let statusEntered!: () => void; let releaseStatus!: () => void
  let staleError = false
  let statusBlocked = new Promise<void>(resolve => { statusEntered = resolve })
  let statusReleased = new Promise<void>(resolve => { releaseStatus = resolve })
  let checks = 0; let applies = 0; let failCheck = false
  let submitted!: () => void
  const accepted = new Promise<void>(resolve => { submitted = resolve })
  const statusCalls: (string | undefined)[] = []
  const port: CommunitySystemUpdatePort = {
    status: async id => { statusCalls.push(id); if (unavailable) throw new CommunitySystemUpdateUnavailableError('Control unavailable'); if (blockStatus) { blockStatus = false; statusEntered(); await statusReleased; if (staleError) { staleError = false; throw new BusinessRuleError('missing', 'Old operation unavailable', 'update-request-refused') } return { currentVersion: 'v0.1.2', runningVersion: 'v0.1.2', operation: null, events: [] } } return { currentVersion: 'v0.1.2', runningVersion: 'v0.1.2', operation, events } },
    check: async () => { checks++; return { currentVersion: 'v0.1.2', runningVersion: 'v0.1.2', operation, events, check: failCheck ? { status: 'failed', checkedAt: '2026-10-05T00:00:00Z', reason: 'Release source unavailable' } : { status: 'available', checkedAt: '2026-10-05T00:00:00Z', version: 'v0.1.3', manifestSha256: 'a'.repeat(64), releaseNotes: '<script>untrusted()</script>\nUpdate notes.' } } },
    prepare: async () => { operation = { id: '12345678-1234-1234-1234-123456789abc', phase: 'prepared', targetVersion: 'v0.1.3', sourceVersion: 'v0.1.2', targetCommit: 'b'.repeat(40), platformSha256: 'a'.repeat(64), imageDigest: `sha256:${'c'.repeat(64)}` }; return { operation } },
    apply: async () => { applies++; operation = { ...operation!, phase: 'stopping' }; submitted(); throw new CommunitySystemUpdateUnavailableError('Connection lost after acceptance') },
  }
  root = await mkdtemp(join(tmpdir(), 'system-update-browser-'))
  app = createCommunityApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'system-update-browser-fixture-32-bytes', runtime: { command: '/unavailable-dsh', args: [], dataRoot: root, defaultModel: { provider: 'deepseek-official', model: 'deepseek-chat', upstream: { baseUrl: 'https://api.deepseek.com' } } } }, { systemUpdate: port })
  const origin = await app.start(); browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ locale: 'en' }); const page = await context.newPage(); page.setDefaultTimeout(15_000)
  await page.goto(`${origin}/bootstrap#credential=${readBootstrapCredential(root)!.credential}`)
  await page.getByLabel('Username', { exact: true }).fill('admin'); await page.getByLabel('Password', { exact: true }).fill('password')
  await page.getByRole('button', { name: 'Create administrator' }).click(); await page.waitForURL(`${origin}/admin`)
  await page.getByRole('link', { name: 'System settings', exact: true }).click()
  const panel = page.getByRole('region', { name: 'System update', exact: true })
  await panel.getByText('Running version: v0.1.2', { exact: true }).waitFor()
  expect(checks).toBe(0)
  await page.getByRole('button', { name: 'Check for updates', exact: true }).click()
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
  await page.getByRole('button', { name: 'Check for updates', exact: true }).click()
  await panel.getByText('Formal update available: v0.1.3', { exact: true }).waitFor()
  await panel.getByRole('button', { name: 'Apply update', exact: true }).click()
  unavailable = true
  await panel.getByText(/Reconnecting to the original update/u).waitFor()
  await panel.getByText('Running version: Unknown while reconnecting.', { exact: true }).waitFor()
  expect(await panel.getByText('Last verified running version: v0.1.2', { exact: true }).count()).toBe(1)
  expect(await panel.getByRole('button', { name: 'Apply update', exact: true }).isDisabled()).toBe(true)
  expect(await panel.getByRole('button', { name: 'Download update', exact: true }).isDisabled()).toBe(true)
  expect(await dialog.getByRole('button', { name: 'Confirm and apply now', exact: true }).isDisabled()).toBe(true)
  expect(await panel.getByRole('link', { name: 'server recovery instructions', exact: true }).count()).toBe(1)
  unavailable = false
  await panel.getByText('Running version: v0.1.2', { exact: true }).waitFor()
  await dialog.getByRole('button', { name: 'Confirm and apply now', exact: true }).click(); await accepted
  await panel.getByText(/Reconnecting to the original update/u).waitFor()
  operation = { ...operation!, phase: 'restored', failure: 'Target failed readiness' }
  await panel.getByText('Update failed; the previous version was restored.', { exact: true }).waitFor()
  await panel.getByText('Update failure: Target failed readiness', { exact: true }).waitFor()
  await page.reload(); await panel.getByText('Update failed; the previous version was restored.', { exact: true }).waitFor()
  expect(applies).toBe(1); expect(statusCalls).toContain(operation.id)
  expect(await panel.textContent()).toContain('Running version: v0.1.2')
  failCheck = true
  await page.getByRole('button', { name: 'Check for updates', exact: true }).click()
  await panel.getByText('Update availability unknown: Release source unavailable', { exact: true }).waitFor()
  expect(await panel.getByText('Formal update available: v0.1.3', { exact: true }).count()).toBe(0)
  operation = { ...operation!, phase: 'preparing' }
  events = [{ phase: 'Upgrade preparation', status: 'running', action: 'Downloading platform', message: 'Still working; waiting for this step to finish', bytes: 400, total: 1000, phaseElapsed: 8, elapsed: 12 }]
  await panel.getByText('Downloading platform', { exact: true }).waitFor()
  await panel.getByRole('progressbar', { name: 'Download progress' }).waitFor()
  expect(await panel.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('40')
  await panel.getByText('Phase elapsed: 8s · Total elapsed: 12s', { exact: true }).waitFor()
  const diagnostics = panel.getByRole('button', { name: 'Update diagnostics', exact: true })
  expect(await diagnostics.getAttribute('aria-expanded')).toBe('false')
  await diagnostics.click()
  expect(await diagnostics.getAttribute('aria-expanded')).toBe('true')
  await panel.getByText(`Operation: ${operation.id}`, { exact: true }).waitFor()
  await diagnostics.click()
  expect(await diagnostics.getAttribute('aria-expanded')).toBe('false')
  events = [{ phase: 'Upgrade preparation', status: 'running', action: 'Pulling instance image', message: 'Still working', bytes: 500, phaseElapsed: 10, elapsed: 14 }]
  await panel.getByText('Pulling instance image', { exact: true }).waitFor()
  expect(await panel.getByRole('progressbar').count()).toBe(0)
  await panel.getByText('500 bytes received', { exact: true }).waitFor()
  for (const [phase, message] of [['prepare-failed', 'Download or verification failed. Check for updates and retry.'], ['recovery-failed', 'Recovery failed. An operator must use the current installer for recovery.'], ['succeeded', 'Update completed successfully.']] as const) {
    const { failure: _failure, recoveryFailure: _recoveryFailure, instruction: _instruction, ...identity } = operation!
    operation = { ...identity, phase, ...(phase === 'succeeded' ? {} : { failure: 'Fixture update failure' }), ...(phase === 'recovery-failed' ? { recoveryFailure: 'Fixture restoration failure', instruction: 'Run the current installer recovery command on the server.' } : {}) }
    void _failure; void _recoveryFailure; void _instruction
    events = []
    await panel.getByText(message, { exact: true }).waitFor()
    if (phase === 'recovery-failed') { await panel.getByText('Recovery failure: Fixture restoration failure', { exact: true }).waitFor(); await panel.getByText('Run the current installer recovery command on the server.', { exact: true }).waitFor() }
  }
  await page.setViewportSize({ width: 390, height: 844 })
  await page.evaluate(() => localStorage.setItem('dsh-phalanx.appearance.v1', 'dark')); await page.reload()
  await panel.getByText('Update completed successfully.', { exact: true }).waitFor()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  statusBlocked = new Promise<void>(resolve => { statusEntered = resolve })
  statusReleased = new Promise<void>(resolve => { releaseStatus = resolve })
  staleError = true; blockStatus = true; await statusBlocked
  failCheck = false
  await page.getByRole('button', { name: 'Check for updates', exact: true }).click()
  await panel.getByText('Formal update available: v0.1.3', { exact: true }).waitFor()
  await panel.getByRole('button', { name: 'Download update', exact: true }).click()
  await panel.getByText('Downloaded and verified; ready to apply.', { exact: true }).waitFor()
  const oldError = page.waitForResponse(response => response.url().includes('/admin/api/system-update') && response.status() === 404)
  releaseStatus(); await oldError
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  expect(await panel.getByText('Old operation unavailable', { exact: true }).count()).toBe(0)
  await panel.getByText('Downloaded and verified; ready to apply.', { exact: true }).waitFor()
  expect((await context.request.post(`${origin}/admin/api/accounts`, { headers: { origin }, data: { username: 'other-admin', email: 'other@example.test', password: 'password' } })).status()).toBe(201)
  expect((await context.request.post(`${origin}/admin/api/accounts/other-admin/actions`, { headers: { origin }, data: { action: 'set-admin', admin: true } })).status()).toBe(200)
  expect((await context.request.post(`${origin}/admin/api/accounts/admin/actions`, { headers: { origin }, data: { action: 'set-admin', admin: false, groupId: 'default' } })).status()).toBe(200)
  await panel.getByRole('alert').filter({ hasText: /administrator/iu }).waitFor()
  expect(await panel.getByText(/Reconnecting to the original update/u).count()).toBe(0)
  expect(await panel.getByText('Update diagnostics', { exact: true }).count()).toBe(0)
  expect(await page.getByRole('button', { name: 'Check for updates', exact: true }).isDisabled()).toBe(true)
})
