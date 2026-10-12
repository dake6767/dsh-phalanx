import type { CommunityConfig } from '../src/domain/community-config.js'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, mkdir, readFile, writeFile, cp, rm, symlink, chmod, open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { downloadProxy } from './fixtures/download-proxy.js'
import { loopbackPort } from '../src/adapters/loopback-port.js'
import { candidateApplication } from './support/candidate-application.js'
import { CommunityAccountStore } from '../src/adapters/community-account-store.js'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import { platformPluginClient } from '../src/dsh/community-platform-client.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { runtimeSection, defaultWorkspacePath, instanceWorkspacePath, assertPinnedDshRevision } from './support/real-dsh-runtime.js'
import { signInCommunity, selectCommunityWorkspace } from './fixtures/community-native-browser.js'
import { streamText, streamToolCall, hasToolResult, latestHumanText } from './support/real-dsh-model.js'
import { cookieHeader, createBrowserDshRpc } from './support/real-dsh-rpc.js'
import { newValidationContext, saveBrowserEvidence } from './fixtures/browser-evidence.js'

it('downloads current originals from native delivery cards and document actions with member file fences', async test => {
  assertPinnedDshRevision(runtimeSettings)
  const root = await mkdtemp(join(tmpdir(), 'artifact-downloads-'))
  const backendPort = await loopbackPort(); const proxy = await downloadProxy(`http://127.0.0.1:${backendPort}`)
  const names = ['../中文报告.docx', '中文报告.pdf', 'image.png', 'archive.zip', 'opaque.bin', 'large.bin']
  const model = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array))
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString())
      response.setHeader('content-type', 'text/event-stream')
      if (latestHumanText(body).startsWith('Generate the session title')) streamText(response, 'Artifacts')
      else if (hasToolResult(body, 'deliver-files', false)) streamText(response, 'FILES_READY')
      else if (hasToolResult(body, 'deliver-files', true)) streamText(response, 'FILES_FAILED')
      else streamToolCall(response, 'deliver-files', 'present', { files: names.map(path => ({ path })) })
    })().catch(() => response.destroy())
  })
  await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve))
  const runtime: CommunityConfig['runtime'] = runtimeSection(root, `http://127.0.0.1:${(model.address() as AddressInfo).port}`, runtimeSettings)
  const app = candidateApplication({ listen: { host: '127.0.0.1', port: backendPort, publicOrigin: proxy.origin }, sessionSecret: 'artifact-test-session-secret-32-bytes', runtime, modelGateway: { upstreamApiKey: 'community-provider-fixture-key' } })
  const accounts = new CommunityAccountStore(join(root, 'community-accounts.db'))
  for (const username of ['alice', 'bob']) await accounts.create({ username, email: `${username}@example.test`, password: 'password' })
  accounts.close()
  const origin = await app.start(); const browser = await chromium.launch({ headless: true })
  const context = await newValidationContext(browser, { viewport: { width: 1500, height: 1000 } }); const page = await context.newPage(); page.setDefaultTimeout(45000)
  try {
    await signInCommunity(page, origin, 'alice', 'password'); console.log('artifacts signed in')
    const workspace = defaultWorkspacePath(root, 'alice'); await mkdir(workspace, { recursive: true })
    for (const file of names.slice(0, 2)) await cp(new URL(`./fixtures/artifacts/${file.split('/').at(-1)}`, import.meta.url), join(workspace, file))
    await writeFile(join(workspace, 'image.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'))
    await writeFile(join(workspace, 'archive.zip'), Buffer.from('UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==', 'base64'))
    await writeFile(join(workspace, 'opaque.bin'), Buffer.from([0, 255, 7, 8]))
    await writeFile(join(workspace, 'large.bin'), Buffer.alloc(48 * 1024 * 1024, 137))
    await selectCommunityWorkspace(context, page, origin, instanceWorkspacePath(workspace, runtime.container !== undefined), runtime.container !== undefined)
    const composer = page.locator('[data-composer-input]'); await composer.fill('Present the fixture files.'); await composer.press('Enter')
    console.log('artifacts waiting for present'); await page.getByText('FILES_READY', { exact: true }).waitFor({ timeout: 90000 })
    const cards = page.locator('[data-presented-files-row]')
    await page.getByRole('button', { name: /Show all .*files/u }).click()
    await expect.poll(() => cards.getByRole('button', { name: 'Download', exact: true }).count()).toBe(names.length)
    const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
    const received: { name: string; sha256: string }[] = []
    const memory: string[] = []
    const memorySample = async () => {
      if (!runtime.container) return
      const ownership = createHash('sha256').update(root).digest('hex')
      const container = execFileSync(runtime.container.runtime, ['ps', '--filter', 'label=dsh-phalanx.community-root=' + ownership, '--filter', 'label=dsh-phalanx.user=alice', '--format', '{{.Names}}'], { encoding: 'utf8' }).trim()
      const pid = execFileSync(runtime.container.runtime, ['inspect', container, '--format', '{{.State.Pid}}'], { encoding: 'utf8' }).trim()
      memory.push((await readFile('/proc/' + pid + '/status', 'utf8')).split('\n').filter(line => /^Vm(RSS|HWM):/u.test(line)).join('\n'))
    }
    for (const [index, name] of names.entries()) {
      console.log('download start',name); if (name === 'large.bin') await memorySample()
      const download = page.waitForEvent('download')
      await cards.getByRole('button', { name: 'Download', exact: true }).nth(index).click()
      const result = await download; console.log('download accepted',name); expect(await result.failure()).toBeNull(); expect(result.suggestedFilename()).toBe(name.split('/').at(-1))
      const bytes = await readFile((await result.path())!); expect(hash(bytes)).toBe(hash(await readFile(join(workspace, name))))
      console.log('download complete',name); received.push({ name, sha256: hash(bytes) }); if (name === 'large.bin') await memorySample()
    }
    await writeFile(join(workspace, 'opaque.bin'), 'changed after the chat reply')
    const changed = page.waitForEvent('download'); await cards.getByRole('button', { name: 'Download', exact: true }).nth(4).click()
    expect(await readFile((await (await changed).path())!, 'utf8')).toBe('changed after the chat reply')
    // Open the actual delivery preview and use its own toolbar contribution.
    await cards.getByRole('button', { name: /Preview .*中文报告\.docx in sidebar/u }).click()
    await expect.poll(() => page.getByRole('button', { name: 'Download', exact: true }).count()).toBeGreaterThan(names.length)
    const toolbar = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download', exact: true }).last().click()
    expect(hash(await readFile((await (await toolbar).path())!))).toBe(received[0]!.sha256)
    const rpc = createBrowserDshRpc(context)
    const sessions = await rpc.remoteRpc<{ items: { sessionId: string; cwd: string }[] }>(origin, await cookieHeader(context, origin), 'session/list', { _request: {} })
    const sessionId = sessions.items.find(item => item.cwd === instanceWorkspacePath(workspace, runtime.container !== undefined))!.sessionId
    const endpoint = new URL('api/phalanx.download', page.url())
    const attempt = async (path: string, id = sessionId) => context.request.post(endpoint.href + '?' + new URLSearchParams({ sessionId: id, path }))
    await writeFile(join(workspace, 'private.bin'), 'permission fixture'); await chmod(join(workspace, 'private.bin'), 0)
    await symlink('/etc/passwd', join(workspace, 'escape'))
    for (const path of ['missing', 'private.bin', 'escape', '../outside', 'a\\b']) expect((await attempt(path)).status()).toBeGreaterThanOrEqual(400)
    expect((await attempt('opaque.bin', 'forged-session')).status()).toBe(403)
    const bob = await newValidationContext(browser); const bobPage = await bob.newPage(); await signInCommunity(bobPage, origin, 'bob', 'password')
    expect((await bob.request.post(endpoint.href + '?' + new URLSearchParams({ sessionId, path: 'opaque.bin' }))).status()).toBe(403)
    const bobEndpoint = new URL('api/phalanx.download', bobPage.url())
    expect((await bob.request.post(bobEndpoint.href + '?' + new URLSearchParams({ sessionId, path: 'opaque.bin' }))).status()).toBe(403)
    await rm(join(workspace, 'opaque.bin'))
    await cards.getByRole('button', { name: 'Download', exact: true }).nth(4).click()
    await cards.getByRole('alert').waitFor()
    expect(await page.getByRole('button', { name: /^Platform account:/u }).isVisible()).toBe(true)
    console.log('starting change-during-transfer'); const stalled = proxy.hold(); const interrupted = page.waitForEvent('download')
    await cards.getByRole('button', { name: 'Download', exact: true }).nth(5).click()
    const incomplete = await interrupted; await stalled.ready
    const changing = await open(join(workspace, 'large.bin'), 'r+')
    try { await changing.write(Buffer.from([42]), 0, 1, 0) } finally { await changing.close() }
    stalled.release(); console.log('transfer changed'); expect(await incomplete.failure()).not.toBeNull()
    console.log('transfer interruption passed'); for (const failure of ['initialization','render']) {
    const fault = await newValidationContext(browser)
    await fault.route('**/plugins/**', async route => {
      if (new URL(route.request().url()).pathname.endsWith('/events')) { await route.continue(); return }
      const response = await route.fetch(); const body = await response.text()
      await route.fulfill({ response, body: body.replace(platformPluginClient, platformPluginClient.replace('function DownloadAction(props){', failure === 'initialization' ? "throw Error('fixture initialization failure');function DownloadAction(props){" : "function DownloadAction(props){throw Error('fixture rendering failure');")) })
    })
    const faultPage = await fault.newPage(); await signInCommunity(faultPage, origin, 'alice', 'password')
    await faultPage.getByText('Artifacts', { exact: true }).first().click()
    await faultPage.getByRole('alert').first().waitFor()
    await faultPage.getByRole('button', { name: /^Platform account:/u }).click()
    await faultPage.getByRole('menuitem', { name: 'Log out', exact: true }).waitFor()
    await faultPage.keyboard.press('Escape'); await faultPage.getByRole('button', { name: 'Platform App Center', exact: true }).click()
    await faultPage.getByRole('heading', { name: 'Platform App Center', exact: true }).waitFor()
    await fault.close()
    }
    const evidence = process.env.DSH_PHALANX_E2E_EVIDENCE_DIR
    if (evidence) { await mkdir(evidence, { recursive: true }); await page.screenshot({ path: join(evidence, 'downloads.png'), fullPage: true }); await writeFile(join(evidence, 'download-report.json'), JSON.stringify({ received, largeFileBytes: 48 * 1024 * 1024, memoryBeforeAfter: memory }, null, 2)) }
  } catch (error) {
    const evidence = process.env.DSH_PHALANX_E2E_EVIDENCE_DIR
    if (evidence) { await mkdir(evidence, { recursive: true }); await page.screenshot({ path: join(evidence, 'failure.png'), fullPage: true }); await writeFile(join(evidence, 'failure.txt'), await page.locator('body').innerText()) }
    throw error
  } finally {
    await saveBrowserEvidence(test); await browser.close(); await proxy.close(); await app.stop(); await new CommunityRuntimeDriver(runtime).rebuild()
    model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve())); await rm(root, { recursive: true, force: true })
  }
}, 300000)
