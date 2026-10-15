// Validation: T2; real credentials: none; actual Linux rootless DSH. Missing inputs must fail the T2 report gate.
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { createCommunityApplication } from '../src/composition/community-application.js'
import { CommunityAccountStore } from '../src/adapters/community-account-store.js'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { runtimeSection, assertPinnedDshRevision } from './support/real-dsh-runtime.js'
import { signInCommunity } from './fixtures/community-native-browser.js'
import { loopbackPort } from '../src/adapters/loopback-port.js'

it.each([false, true])('renews only real preview gestures and reclaims the actual container (page closed=%s)', async closePage => {
  assertPinnedDshRevision(runtimeSettings)
  const root = await mkdtemp(join(tmpdir(), 'preview-idle-')), runtime = runtimeSection(root, 'https://example.test', runtimeSettings)
  const port = await loopbackPort(), previewPort = await loopbackPort()
  const origin = `http://127.0.0.1:${port}`, previewOrigin = `http://127.0.0.1:${previewPort}`
  let now = Date.now()
  const app = createCommunityApplication({ listen: { host: '127.0.0.1', port, publicOrigin: origin }, preview: { port: previewPort, publicOrigin: previewOrigin }, idleReclaimSeconds: 4, sessionSecret: 'preview-idle-private-fixture-32-bytes', runtime }, { clock: { now: () => now } })
  const accounts = new CommunityAccountStore(join(root, 'community-accounts.db')); await accounts.create({ username: 'alice', email: 'alice@example.test', password: 'password' }); accounts.close()
  await app.start(); const browser = await chromium.launch({ headless: true }), context = await browser.newContext({ locale: 'en' }), page = await context.newPage()
  try {
    await signInCommunity(page, origin, 'alice', 'password')
    const space = new URL(page.url()).pathname.split('/')[2]!
    const instructions = await (await context.request.get(origin + '/service-preview/')).text()
    const path = instructions.match(new RegExp('/preview/' + space + '/4300/[a-f0-9]{64}/'))![0]
    const ownership = createHash('sha256').update(root).digest('hex')
    const container = execFileSync('podman', ['ps', '--filter', `label=dsh-phalanx.community-root=${ownership}`, '--format', '{{.Names}}'], { encoding: 'utf8' }).trim()
    execFileSync('podman', ['exec', '-i', container, 'sh', '-c', 'cat > /tmp/preview-sample.mjs'], { input: await readFile(new URL('./fixtures/preview-service.mjs', import.meta.url)) })
    execFileSync('podman', ['exec', '-d', '--env', `PREVIEW_BASE=${path}`, container, 'node', '/tmp/preview-sample.mjs'])
    await expect.poll(async () => (await context.request.get(previewOrigin + path)).status(), { timeout: 30000 }).toBe(200)
    const preview = await context.newPage(); let previewSocketClosed = false
    preview.on('websocket', socket => { if (socket.url() === previewOrigin.replace(/^http/u, 'ws') + path + 'hmr') socket.on('close', () => { previewSocketClosed = true }) })
    await preview.goto(origin + '/service-preview/')
    await preview.getByRole('button', { name: 'Open preview', exact: true }).click()
    await preview.frameLocator('iframe').getByText('HMR READY', { exact: true }).waitFor()
    await page.close()
    // CDP evaluation deliberately avoids Playwright's implicit user-gesture grant.
    const cdp = await context.newCDPSession(preview)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.DSH_PHALANX_E2E_CPU_RATE ?? 1) })
    const inactive = () => cdp.send('Runtime.evaluate', { expression: 'navigator.userActivation.isActive', returnByValue: true, userGesture: false }).then(result => result.result.value)
    await expect.poll(inactive, { timeout: 10000 }).toBe(false)
    now += 3500
    await preview.bringToFront()
    const gesture = preview.waitForResponse(response => response.url().endsWith('/__activity') && response.request().method() === 'POST')
    await preview.frameLocator('iframe').getByRole('button', { name: 'Check API', exact: true }).click()
    expect((await gesture).status()).toBe(204)
    now += 1000
    expect((await context.request.get(previewOrigin + path + 'api')).status()).toBe(200)
    expect((await context.request.post(previewOrigin + path + '__activity')).status()).toBe(403)
    await expect.poll(inactive, { timeout: 10000 }).toBe(false)
    if (closePage) await preview.close()
    now += 5000
    // Background HTTP/WS traffic does not renew the lease; the production timer owns reclamation.
    await expect.poll(async () => (await context.request.get(previewOrigin + path + 'api')).status(), { timeout: 20000 }).not.toBe(200)
    // Poll the actual connection without a browser evaluation granting a synthetic
    // user gesture, which would make the expired wrapper remove its iframe.
    if (!closePage) await expect.poll(() => previewSocketClosed, { timeout: 30000 }).toBe(true)
    await expect.poll(() => execFileSync('podman', ['ps', '--filter', `label=dsh-phalanx.community-root=${ownership}`, '--format', '{{.Names}}'], { encoding: 'utf8' }).trim(), { timeout: 20000 }).toBe('')
  } finally { await browser.close(); await app.stop(); await new CommunityRuntimeDriver(runtime).rebuild(); await rm(root, { recursive: true, force: true }) }
}, 90000)
