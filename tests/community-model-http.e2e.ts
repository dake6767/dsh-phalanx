import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { createProxyServer, type ProxyServer } from 'http-proxy-3'
import { chromium, type Browser } from 'playwright'
import { afterEach, expect, it } from 'vitest'
import { createCommunityApplication } from '../src/composition/community-application.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { loopbackPort } from '../src/adapters/loopback-port.js'
import type { CommunityApplication } from '../src/ports/community-application.js'

let app: CommunityApplication | undefined, browser: Browser | undefined, root: string | undefined
let proxy: ProxyServer | undefined, forwarder: Server | undefined
afterEach(async () => {
  await browser?.close(); proxy?.close()
  if (forwarder) { forwarder.closeAllConnections(); await new Promise<void>(resolve => forwarder!.close(() => resolve())) }
  await app?.stop(); if (root) await rm(root, { recursive: true, force: true })
})

it('creates and edits shared providers and independent model rows over insecure HTTP', async () => {
  root = await mkdtemp(join(tmpdir(), 'community-model-http-'))
  const port = await loopbackPort()
  const origin = `http://phalanx.example.test:${port}`
  app = createCommunityApplication({ listen: { host: '127.0.0.1', port, publicOrigin: origin }, sessionSecret: 'model-http-fixture-session-secret-at-least-32-bytes',
    runtime: { command: '/unavailable-dsh', args: [], dataRoot: root, defaultModel: {
      provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'https://api.deepseek.com' } } } })
  await app.start()
  // A non-localhost HTTP origin exercises the browser's actual secure-context rules.
  // A loopback forwarder keeps fixture traffic independent of host DNS/proxies.
  proxy = createProxyServer({ target: `http://127.0.0.1:${port}` })
  proxy.on('error', (_error, _request, response) => response.destroy())
  forwarder = createServer((request, response) => proxy!.web(request, response))
  await new Promise<void>(resolve => forwarder!.listen(0, '127.0.0.1', resolve))
  const address = forwarder.address()
  if (!address || typeof address === 'string') throw new Error('HTTP fixture did not listen')
  browser = await chromium.launch({ headless: true, proxy: { server: `http://127.0.0.1:${address.port}` } })
  const context = await browser.newContext({ locale: 'en' })
  const page = await context.newPage(); page.setDefaultTimeout(5_000)
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
  const response = await page.goto(`${origin}/bootstrap#credential=${readBootstrapCredential(root)!.credential}`)
  expect(response!.status(), await page.locator('body').innerText()).toBe(200)
  expect(await page.evaluate(() => ({ secure: isSecureContext, uuid: typeof crypto.randomUUID }))).toEqual({ secure: false, uuid: 'undefined' })
  await page.getByLabel('Username', { exact: true }).fill('admin')
  await page.getByLabel('Password', { exact: true }).fill('password')
  await page.getByRole('button', { name: 'Create administrator', exact: true }).click()
  await page.waitForURL(`${origin}/admin`)
  await page.getByRole('link', { name: 'Model management', exact: true }).click()
  await page.getByRole('button', { name: 'Add provider', exact: true }).click()
  expect(errors).toEqual([])
  await page.getByLabel('Provider name', { exact: true }).fill('HTTP provider')
  await page.getByLabel('Messages Base URL', { exact: true }).fill('https://models.example.test/anthropic')
  await page.getByLabel('API key', { exact: true }).fill('fixture-api-key')
  await page.getByLabel('Model identifier 1', { exact: true }).fill('first')
  await page.getByRole('button', { name: 'Add model', exact: true }).click()
  await page.getByLabel('Model identifier 2', { exact: true }).fill('removed')
  await page.getByRole('button', { name: 'Add model', exact: true }).click()
  await page.getByLabel('Model identifier 3', { exact: true }).fill('third')
  await page.getByRole('button', { name: 'Remove model 2', exact: true }).click()
  expect(await page.getByLabel('Model identifier 2', { exact: true }).inputValue()).toBe('third')
  await page.getByRole('button', { name: 'Add model', exact: true }).click()
  await page.getByLabel('Model identifier 3', { exact: true }).fill('fourth')
  await page.getByLabel('Model identifier 2', { exact: true }).fill('third-edited')
  await page.getByRole('button', { name: 'Save provider', exact: true }).click()
  await page.getByRole('status').filter({ hasText: 'Provider saved.' }).waitFor()
  await page.reload()
  await expect.poll(() => page.getByLabel('Model identifier 1', { exact: true }).inputValue()).toBe('first')
  expect(await page.getByLabel('Model identifier 2', { exact: true }).inputValue()).toBe('third-edited')
  expect(await page.getByLabel('Model identifier 3', { exact: true }).inputValue()).toBe('fourth')
  await page.getByRole('button', { name: 'Add model', exact: true }).click()
  await page.getByLabel('Model identifier 4', { exact: true }).fill('saved-provider-new-model')
  await page.getByRole('button', { name: 'Save provider', exact: true }).click()
  await page.getByRole('status').filter({ hasText: 'Provider saved.' }).waitFor()
  await page.reload()
  await expect.poll(() => page.getByLabel('Model identifier 4', { exact: true }).inputValue()).toBe('saved-provider-new-model')
  await page.getByRole('button', { name: 'Add provider', exact: true }).click()
  await expect.poll(() => page.getByLabel('Provider name', { exact: true }).inputValue()).toBe('')
  expect(await page.getByLabel('Model identifier 1', { exact: true }).inputValue()).toBe('')
  expect(errors).toEqual([])
})
