import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium, type Browser } from 'playwright'
import { afterEach, expect, it } from 'vitest'
import { signInCommunity } from './fixtures/community-native-browser.js'
import { newValidationContext, saveBrowserEvidence } from './fixtures/browser-evidence.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'

let root: string | undefined, child: ChildProcess | undefined, exited: Promise<void> | undefined
let browser: Browser | undefined
afterEach(async test => {
  await saveBrowserEvidence(test)
  await browser?.close()
  if (child?.pid !== undefined && child.exitCode === null && child.signalCode === null) process.kill(-child.pid, 'SIGTERM')
  await exited
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined; child = undefined; exited = undefined; browser = undefined
})

it('uses the built service and admin UI through bootstrap, member entry, HTTP and browser WebSocket', async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-phalanx-ci-'))
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('DSH_PHALANX_')))
  child = spawn(process.execPath, ['dist/composition/cli.js'], { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...env,
    DSH_PHALANX_HOST: '127.0.0.1', DSH_PHALANX_PORT: '0', DSH_PHALANX_DATA_ROOT: root,
    DSH_PHALANX_SESSION_SECRET: 'ci-fixture-session-secret-at-least-32-bytes',
    DSH_PHALANX_RUNTIME_COMMAND: process.execPath,
    DSH_PHALANX_RUNTIME_ARGS_JSON: JSON.stringify([resolve('tests/fixtures/runtime.mjs')]),
    DSH_PHALANX_ALLOWED_MODEL_PROVIDER: 'deepseek-official', DSH_PHALANX_ALLOWED_MODEL: 'fixture',
    DSH_PHALANX_MODEL_UPSTREAM_BASE_URL: 'http://127.0.0.1:1',
  } })
  exited = new Promise(resolve => child!.once('close', () => resolve()))
  child.stderr?.resume()
  const origin = await new Promise<string>((resolve, reject) => {
    let output = ''
    child!.once('error', reject)
    child!.once('exit', () => reject(new Error('Built service exited before readiness')))
    child!.stdout?.on('data', data => {
      output += String(data)
      const match = /dsh-phalanx listening at (http:\/\/127\.0\.0\.1:\d+)/u.exec(output)
      if (match?.[1] !== undefined) resolve(match[1])
    })
  })
  const credential = readBootstrapCredential(root)!.credential
  browser = await chromium.launch({ headless: true })
  const adminContext = await newValidationContext(browser), admin = await adminContext.newPage()
  await admin.goto(`${origin}/bootstrap`)
  await admin.getByLabel('Bootstrap credential').fill(credential)
  await admin.getByLabel('Username').fill('admin')
  await admin.getByLabel('Email').fill('admin@example.test')
  await admin.getByLabel('Password', { exact: true }).fill('admin-password')
  await admin.getByRole('button', { name: 'Create administrator' }).click()
  await admin.waitForURL(`${origin}/login`)
  await signInCommunity(admin, origin, 'admin', 'admin-password', true)
  await admin.getByRole('heading', { name: 'Account management' }).waitFor()
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
    const socket = new WebSocket(`${location.origin.replace('http', 'ws')}/ci-echo`)
    socket.onopen = () => socket.send('CI_WEBSOCKET_READY')
    socket.onerror = () => reject(new Error('Product WebSocket failed'))
    socket.onmessage = event => { socket.close(); resolve(String(event.data)) }
  }))
  expect(echo).toBe('CI_WEBSOCKET_READY')
})
