// Validation: T1; real credentials: none; controlled browser/process fixtures. CI selects its explicit public-entry subset.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium, type Browser } from 'playwright'
import { startPlatformCli } from './support/platform-cli.js'
import { afterEach, expect, it } from 'vitest'
import { signInCommunity } from './fixtures/community-native-browser.js'
import { newValidationContext, saveBrowserEvidence } from './fixtures/browser-evidence.js'
import { ensureWorkspaceSelected } from './fixtures/real-dsh-browser.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'

let root: string | undefined, cli: Awaited<ReturnType<typeof startPlatformCli>> | undefined
let browser: Browser | undefined
afterEach(async test => {
  await saveBrowserEvidence(test)
  await browser?.close()
  await cli?.stop()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined; cli = undefined; browser = undefined
})

it('uses the built service and admin UI through bootstrap, member entry, HTTP and browser WebSocket', async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-phalanx-ci-'))
  const installed = process.env.DSH_PHALANX_CI_INSTALL_ROOT
  cli = await startPlatformCli(installed === undefined ? process.execPath : join(installed, 'start'), installed === undefined ? ['dist/composition/cli.js'] : [], {
    DSH_PHALANX_HOST: '127.0.0.1', DSH_PHALANX_PORT: '0', DSH_PHALANX_DATA_ROOT: root,
    DSH_PHALANX_SESSION_SECRET: 'ci-fixture-session-secret-at-least-32-bytes',
    DSH_PHALANX_RUNTIME_COMMAND: process.execPath,
    DSH_PHALANX_RUNTIME_ARGS_JSON: JSON.stringify([resolve('tests/fixtures/runtime.mjs')]),
    DSH_PHALANX_ALLOWED_MODEL_PROVIDER: 'deepseek-official', DSH_PHALANX_ALLOWED_MODEL: 'fixture',
    DSH_PHALANX_MODEL_UPSTREAM_BASE_URL: 'http://127.0.0.1:1',
  })
  const origin = cli.origin
  const credential = readBootstrapCredential(root)!.credential
  browser = await chromium.launch({ headless: true })
  const adminContext = await newValidationContext(browser), admin = await adminContext.newPage()
  await admin.goto(`${origin}/bootstrap#credential=${encodeURIComponent(credential)}`)
  await admin.getByLabel('Username').fill('admin')
  await admin.getByLabel('Password', { exact: true }).fill('admin-password')
  await admin.getByRole('button', { name: 'Create administrator' }).click()
  await admin.waitForURL(`${origin}/admin`)
  await admin.getByRole('heading', { name: 'Account management' }).waitFor()
  await admin.getByRole('button', { name: 'Add account', exact: true }).click()
    await admin.getByLabel('Username').fill('member')
  await admin.getByLabel('Email').fill('member@example.test')
  await admin.getByLabel('Temporary password').fill('member-password')
  await admin.getByRole('button', { name: 'Create account', exact: true }).click()
  await admin.getByRole('status').filter({ hasText: 'Account member created.' }).waitFor()
  const memberContext = await newValidationContext(browser), member = await memberContext.newPage()
  await signInCommunity(member, origin, 'member', 'member-password')
  expect(await member.textContent('body')).toContain('fixture runtime')
  expect((await memberContext.request.get(`${origin}/healthz`)).status()).toBe(200)
  expect((await memberContext.request.get(`${origin}/admin/api/accounts`)).status()).toBe(403)
  const echo = await member.evaluate(async () => await new Promise<string>((resolve, reject) => {
    const entry = new URL('ci-echo', location.href)
    entry.protocol = entry.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(entry)
    socket.onopen = () => socket.send('CI_WEBSOCKET_READY')
    socket.onerror = () => reject(new Error('Product WebSocket failed'))
    socket.onmessage = event => { socket.close(); resolve(String(event.data)) }
  }))
  expect(echo).toBe('CI_WEBSOCKET_READY')
})

// A restored session can enable the composer while the chooser is becoming actionable.
it('accepts workspace restoration when hydration removes the pending chooser', async () => {
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext(), page = await context.newPage()
  page.setDefaultTimeout(500)
  await page.setContent(`<style>
    @keyframes moving { from { transform: translateX(0) } to { transform: translateX(200px) } }
    button { animation: moving 0.1s infinite alternate linear }
    </style><div data-composer-input contenteditable="false">Composer</div><button>Choose workspace</button>`)
  const fixture = { containerMode: true, sessionCwds: async () => {
    await page.evaluate(() => { setTimeout(() => {
      document.querySelector('[data-composer-input]')!.setAttribute('contenteditable', 'true')
      document.querySelector('button')!.remove()
    }, 100) })
    return ['/workspace/default-workspace']
  } }
  await ensureWorkspaceSelected(fixture, context, page, 'http://fixture.test', '/workspace/default-workspace')
  expect(await page.locator('[data-composer-input]').getAttribute('contenteditable')).toBe('true')
  expect(await page.getByRole('button', { name: 'Choose workspace' }).count()).toBe(0)
})

it('selects an existing workspace through the chooser', async () => {
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext(), page = await context.newPage()
  await page.setContent(`<div data-composer-input contenteditable="false">Composer</div><button>Choose workspace</button>`)
  await page.evaluate(() => {
    document.querySelector('button')!.onclick = () => {
      const item = document.createElement('button')
      item.setAttribute('role', 'menuitem'); item.textContent = 'Default workspace'
      item.onclick = () => document.querySelector('[data-composer-input]')!.setAttribute('contenteditable', 'true')
      document.body.append(item)
    }
  })
  const fixture = { containerMode: true, sessionCwds: async () => ['/workspace/default-workspace'] }
  await ensureWorkspaceSelected(fixture, context, page, 'http://fixture.test', '/workspace/default-workspace')
  expect(await page.locator('[data-composer-input]').getAttribute('contenteditable')).toBe('true')
})
