// Validation: T2; real credentials: none; actual Linux rootless DSH. Missing inputs must fail the T2 report gate.
import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import type { CommunityConfig } from '../src/domain/community-config.js'
import { openNativeSettings, selectCommunityWorkspace, signInCommunity } from './fixtures/community-native-browser.js'
import { removeCommunityFixture } from './fixtures/owned-cleanup.js'
import { candidateApplication } from './support/candidate-application.js'
import { openTestAccounts } from './support/community-application.js'
import { platformPluginClient } from './support/platform-client.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { cookieHeader, createBrowserDshRpc } from './support/real-dsh-rpc.js'
import { assertPinnedDshRevision, defaultWorkspacePath, instanceWorkspacePath, runtimeSection } from './support/real-dsh-runtime.js'

it('keeps native HTML interaction independent of coding view and isolated from platform authority', async () => {
  assertPinnedDshRevision(runtimeSettings)
  const root = await mkdtemp(join(tmpdir(), 'html-preview-'))
  const runtime: CommunityConfig['runtime'] = runtimeSection(root, 'https://example.test', runtimeSettings)
  const app = candidateApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'html-preview-fixture-session-32-bytes', runtime })
  const accounts = await openTestAccounts(root)
  await accounts.createFirstAdmin({ username: 'fixtureadmin', email: '', password: 'password' })
  await accounts.create({ username: 'alice', email: 'alice@example.test', password: 'password' })
  await accounts.close()
  const origin = await app.start()
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ locale: 'en', viewport: { width: 1500, height: 1000 } })
  const page = await context.newPage()
  page.setDefaultTimeout(30000)
  let failure = 'none'
  let navigationCookie: string | undefined
  const destination = createServer((request, response) => {
    navigationCookie = request.headers.cookie ?? ''
    response.end('<script>try{parent.document.body;document.write("unsafe")}catch{document.write("Navigation stays opaque")}</script>')
  })
  await new Promise<void>(resolve => destination.listen(0, '127.0.0.1', resolve))
  const address = destination.address()
  if (!address || typeof address === 'string') throw Error('Missing fixture address')
  try {
    await context.route('**/plugins/**', async route => {
      if (new URL(route.request().url()).pathname.endsWith('/events')) {
        await route.continue()
        return
      }
      const response = await route.fetch()
      const body = await response.text()
      const entry =
        "ctx.slots.inject('sidebar.footer.action',()=>ctx.slots.register({name:'sidebar.footer.action',id:'html-fixture'},()=>h('button',{onClick:()=>ctx.sidebarRight.openResource('dsh-resource://file/session/'+window.__htmlSession+'/interactive.html')},'Open HTML fixture')));"
      const module =
        failure === 'initialization'
          ? platformPluginClient.replace('const documentHtml=', "throw Error('fixture HTML initialization failure');const documentHtml=")
          : failure === 'render'
            ? platformPluginClient.replace(
                'function HtmlBody({content,resourceAddress}){',
                "function HtmlBody({content,resourceAddress}){throw Error('fixture HTML render failure');",
              )
            : platformPluginClient
      const patched = module
        .replace("inject:['slots','locale']", "inject:['slots','locale','sidebarRight']")
        .replace("const namespace='phalanx-account';", entry + "const namespace='phalanx-account';")
      await route.fulfill({ response, body: body.replace(platformPluginClient, patched) })
    })
    await signInCommunity(page, origin, 'alice', 'password')
    const workspace = defaultWorkspacePath(root, 'alice')
    await mkdir(workspace, { recursive: true })
    await cp(new URL('./fixtures/artifacts/interactive.html', import.meta.url), join(workspace, 'interactive.html'))
    await selectCommunityWorkspace(context, page, origin, instanceWorkspacePath(workspace, runtime.container !== undefined), runtime.container !== undefined)
    const rpc = createBrowserDshRpc(context)
    const sessions = await rpc.remoteRpc<{ items: { sessionId: string; cwd: string }[] }>(origin, await cookieHeader(context, origin), 'session/list', {
      _request: {},
    })
    const id = sessions.items.find(item => item.cwd === instanceWorkspacePath(workspace, runtime.container !== undefined))!.sessionId
    await page.evaluate(value => {
      Object.assign(window, { __htmlSession: value })
    }, id)
    const verify = async () => {
      const frame = page.frameLocator('iframe[title="Interactive HTML"]')
      await frame.getByRole('button', { name: 'Count: 0', exact: true }).click()
      await frame.getByRole('button', { name: 'Count: 1', exact: true }).waitFor()
      await frame.getByLabel('Name').fill('中文')
      await frame.getByRole('button', { name: 'Submit', exact: true }).click()
      await frame.getByText('Hello 中文', { exact: true }).waitFor()
      await expect.poll(() => frame.locator('#security').textContent()).toBe('{"parent":"blocked","cookie":"blocked","storage":"blocked","fetch":"blocked"}')
    }
    await page.getByRole('button', { name: 'Open HTML fixture', exact: true }).click()
    await verify()
    await page.getByRole('button', { name: 'Read the file again', exact: true }).click()
    await verify()
    for (const enabled of [true, false]) {
      await openNativeSettings(page)
      const toggle = page.getByRole('switch', { name: 'Show coding view', exact: true })
      await toggle.waitFor()
      if (((await toggle.getAttribute('aria-checked')) === 'true') !== enabled) await toggle.click()
      await expect.poll(() => toggle.getAttribute('aria-checked')).toBe(String(enabled))
      await page.keyboard.press('Escape')
      await toggle.waitFor({ state: 'hidden' })
      await page.getByRole('button', { name: 'Open HTML fixture', exact: true }).click()
      await page.getByRole('button', { name: 'Read the file again', exact: true }).click()
      await verify()
    }
    await page.getByRole('button', { name: 'Close', exact: true }).last().click()
    await expect.poll(() => page.locator('iframe[title="Interactive HTML"]').count()).toBe(0)
    await page.getByRole('button', { name: 'Open HTML fixture', exact: true }).click()
    await verify()
    await page.reload()
    await page.evaluate(value => {
      Object.assign(window, { __htmlSession: value })
    }, id)
    await page.getByRole('button', { name: 'Open HTML fixture', exact: true }).click()
    await verify()
    const evidence = process.env.DSH_PHALANX_E2E_EVIDENCE_DIR
    if (evidence) {
      await mkdir(evidence, { recursive: true })
      await page.screenshot({ path: join(evidence, 'interactive-html.png'), fullPage: true })
    }
    // Meta CSP restricts resource requests, but a sandboxed document can navigate itself.
    const documentFrame = page.frames().find(frame => frame.url() === 'about:srcdoc')!
    await documentFrame.evaluate(url => {
      location.href = url
    }, `http://127.0.0.1:${address.port}/navigation`)
    await page.frameLocator('iframe[title="Interactive HTML"]').getByText('Navigation stays opaque', { exact: true }).waitFor()
    expect(navigationCookie).toBe('')
    for (const mode of ['initialization', 'render']) {
      failure = mode
      await page.reload()
      await page.evaluate(value => {
        Object.assign(window, { __htmlSession: value })
      }, id)
      await page.getByRole('button', { name: 'Open HTML fixture', exact: true }).click()
      await page.getByRole('alert').filter({ hasText: 'HTML preview is unavailable' }).waitFor()
      await page.getByRole('button', { name: /^Platform account:/u }).click()
      await page.getByRole('menuitem', { name: 'Log out', exact: true }).waitFor()
      await page.keyboard.press('Escape')
      await page.getByRole('button', { name: 'Platform App Center', exact: true }).click()
      await page.getByRole('heading', { name: 'Platform App Center', exact: true }).waitFor()
    }
  } catch (error) {
    const evidence = process.env.DSH_PHALANX_E2E_EVIDENCE_DIR
    if (evidence) {
      await mkdir(evidence, { recursive: true })
      await page.screenshot({ path: join(evidence, 'html-failure.png'), fullPage: true })
      await writeFile(join(evidence, 'html-failure.txt'), await page.locator('body').innerText())
    }
    throw error
  } finally {
    destination.closeAllConnections()
    await new Promise<void>(resolve => destination.close(() => resolve()))
    await browser.close()
    await app.stop()
    await new CommunityRuntimeDriver(runtime).rebuild()
    await removeCommunityFixture(root)
  }
}, 180000)
