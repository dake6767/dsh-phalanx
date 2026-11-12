// Validation: T2; real credentials: none; actual Linux rootless DSH. Missing inputs must fail the T2 report gate.
import { randomUUID } from 'node:crypto'
import { request } from 'node:http'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser } from 'playwright'
import { afterEach, expect, it } from 'vitest'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import type { CommunityRuntimeConfig } from '../src/domain/community-config.js'
import type { CommunityApplication } from '../src/ports/community-application.js'
import { newValidationContext, saveBrowserEvidence } from './fixtures/browser-evidence.js'
import { startCommunityModel } from './fixtures/community-model.js'
import {
  openCommunitySession,
  runCommunityTerminal,
  selectCommunityWorkspace,
  signInCommunity,
  startCommunitySession,
} from './fixtures/community-native-browser.js'
import { removeCommunityFixture } from './fixtures/owned-cleanup.js'
import { candidateApplication } from './support/candidate-application.js'
import { modelAccessToken, openTestAccounts } from './support/community-application.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { cookieHeader, createBrowserDshRpc } from './support/real-dsh-rpc.js'
import { assertPinnedDshRevision, defaultWorkspacePath, instanceWorkspacePath, runtimeSection } from './support/real-dsh-runtime.js'

let root: string | undefined, application: CommunityApplication | undefined, runtime: CommunityRuntimeConfig | undefined
let browser: Browser | undefined, model: Awaited<ReturnType<typeof startCommunityModel>> | undefined
afterEach(async test => {
  const errors: unknown[] = []
  let rebuilt = false
  for (const cleanup of [
    () => saveBrowserEvidence(test),
    () => model?.release(),
    () => browser?.close(),
    () => application?.stop(),
    async () => {
      if (runtime !== undefined) await new CommunityRuntimeDriver(runtime).rebuild()
      rebuilt = true
    },
    () => model?.close(),
    async () => {
      if (root !== undefined && rebuilt) await removeCommunityFixture(root)
    },
  ]) {
    try {
      await cleanup()
    } catch (error) {
      errors.push(error)
    }
  }
  root = undefined
  application = undefined
  runtime = undefined
  browser = undefined
  model = undefined
  if (errors.length) throw new AggregateError(errors, 'Native network acceptance cleanup failed')
})

it('allows explicitly unmapped HTTP and HTTPS egress while denying undeclared, host and cross-member access in real containers', async () => {
  assertPinnedDshRevision(runtimeSettings)
  const aliases = process.env.DSH_PHALANX_E2E_HOST_PUBLIC_ADDRESSES?.split(',')
  if (aliases === undefined || aliases.length === 0) throw new Error('The validation host public IPv4 inventory is required')
  root = await mkdtemp(join(tmpdir(), 'community-native-network-isolation-'))
  model = await startCommunityModel()
  runtime = runtimeSection(root, model.origin, runtimeSettings)
  if (runtime.container === undefined) throw new Error('Public host isolation requires Linux rootless containers')
  const config = {
    listen: { host: '127.0.0.1', port: 0 },
    sessionSecret: 'community-network-session-secret-at-least-32-bytes',
    runtime,
    modelGateway: { upstreamApiKey: 'community-provider-fixture-key' },
  }
  const accounts = await openTestAccounts(root)
  await accounts.createFirstAdmin({ username: 'fixtureadmin', email: '', password: 'password' })
  try {
    await accounts.create({ username: 'bob', email: 'bob@example.test', password: 'password' })
    await accounts.create({ username: 'carol', email: 'carol@example.test', password: 'password' })
  } finally {
    await accounts.close()
  }
  browser = await chromium.launch({ headless: true })
  for (const policy of ['declared', 'undeclared', 'none'] as const) {
    const declared = policy === 'declared'
    // Suppress only the harness default when deliberately testing an absent declaration.
    const savedInventory = process.env.DSH_PHALANX_E2E_HOST_PUBLIC_ADDRESSES
    try {
      if (policy === 'undeclared') delete process.env.DSH_PHALANX_E2E_HOST_PUBLIC_ADDRESSES
      application = candidateApplication({ ...config, ...(policy === 'undeclared' ? {} : { network: { hostPublicAddresses: declared ? aliases : [] } }) })
    } finally {
      if (savedInventory === undefined) delete process.env.DSH_PHALANX_E2E_HOST_PUBLIC_ADDRESSES
      else process.env.DSH_PHALANX_E2E_HOST_PUBLIC_ADDRESSES = savedInventory
    }
    const origin = await application.start()
    let firstMemberToken: string | undefined
    for (const username of policy === 'none' ? ['bob', 'carol'] : ['bob']) {
      const context = await newValidationContext(browser)
      const page = await context.newPage()
      await signInCommunity(page, origin, username, 'password')
      const workspace = await defaultWorkspacePath(root, username)
      await selectCommunityWorkspace(context, page, origin, instanceWorkspacePath(workspace, true), true)
      // Bind the resident composer to a selected blank before typing.
      await startCommunitySession(page)
      await page.locator('[data-composer-input]').fill('NETWORK_PROBE_TASK: Reply with your fixture marker.')
      await page.locator('[data-composer-input]').press('Enter')
      // Follow the actual running session if workspace hydration restores a blank tab.
      const rpc = createBrowserDshRpc(context)
      await expect
        .poll(
          async () => {
            if (await page.getByText('COMMUNITY_', { exact: true }).isVisible()) return true
            const sessions = await rpc.remoteRpc<{ items: { sessionId: string; running: boolean }[] }>(
              origin,
              await cookieHeader(context, origin),
              'session/list',
              { _request: {} },
            )
            const active = sessions.items.find(row => row.running)
            if (active) await page.locator(`[data-row-key=${JSON.stringify('session:' + active.sessionId)}]`).click({ timeout: 1000 })
            return false
          },
          { timeout: 90000 },
        )
        .toBe(true)
      await page.getByText('COMMUNITY_', { exact: true }).waitFor({ timeout: 90_000 })
      model.release()
      await page.getByText('COMMUNITY_MODEL_READY', { exact: true }).waitFor()
      // A completed conversation must switch to a blank before the next turn; a prior blank may be reused.
      const completed = await page
        .locator('[data-conversation-content]:visible')
        .filter({ has: page.locator('[data-composer-input]') })
        .getAttribute('data-conversation-session')
      expect(completed).toBeTruthy()
      const nextSession = await startCommunitySession(page)
      expect(nextSession).not.toBe(completed)
      await rpc.remoteRpc(origin, await cookieHeader(context, origin), 'session/prompt', {
        request: { requestId: randomUUID(), sessionId: nextSession, mode: 'queue', content: [{ type: 'text', text: 'NETWORK_NEXT_SESSION_TASK' }] },
      })
      await openCommunitySession(page, nextSession)
      const nextConversation = page.locator(`[data-conversation-content][data-conversation-session=${JSON.stringify(nextSession)}]:visible`)
      await nextConversation.getByText('COMMUNITY_', { exact: true }).waitFor({ timeout: 90_000 })
      model.release()
      await nextConversation.getByText('COMMUNITY_MODEL_READY', { exact: true }).waitFor()
      const inventory = await rpc.remoteRpc<{ items: { sessionId: string; blank: boolean }[] }>(origin, await cookieHeader(context, origin), 'session/list', {
        _request: {},
      })
      expect(inventory.items.find(row => row.sessionId === nextSession)?.blank).toBe(false)
      // Only this member's fictional scoped credential enters the arranged private script, never its command.
      const storedAccounts = await openTestAccounts(root)
      const spaceId = (await storedAccounts.getState(username))!.spaceId
      await storedAccounts.close()
      const token = await modelAccessToken(root, username, spaceId)
      if (username === 'bob') firstMemberToken = token
      const publicHttp = process.env.DSH_PHALANX_E2E_PERSONAL_UPSTREAM
      const publicHttps = process.env.DSH_PHALANX_E2E_PUBLIC_HTTPS_UPSTREAM
      const certificate = process.env.DSH_PHALANX_PREVIEW_TEST_CERT
      if (!publicHttp || !publicHttps || !certificate) throw new Error('Controlled public HTTP/HTTPS fixtures are required')
      await writeFile(join(workspace, 'member-network-probe.mjs'), await readFile(new URL('./fixtures/member-network-probe.mjs', import.meta.url)), {
        mode: 0o600,
      })
      await writeFile(
        join(workspace, 'member-network-probe.json'),
        JSON.stringify({
          token,
          gateway: runtime.container.gatewayPort,
          http: publicHttp + '/health',
          https: publicHttps,
          ca: await readFile(certificate, 'utf8'),
        }),
        { mode: 0o600 },
      )
      const targets = declared
        ? aliases.map(address => `${address}:22`)
        : policy === 'undeclared'
          ? ['11.254.254.254:18443']
          : ['127.0.0.1:22', '10.0.0.1:80', '169.254.169.254:80']
      for (const [index, target] of targets.entries()) {
        const probe = `host-${policy + '-' + username}-${index}`
        await runCommunityTerminal(page, `node member-network-probe.mjs connect ${target} ${probe}`, `PROBE_FINISHED_${probe}`)
        const output = (await page.locator('.xterm-screen:visible .xterm-rows').allTextContents()).join('\n')
        const status = new RegExp(`STATUS_([0-9]+)_PROBE_FINISHED_${probe}`, 'u').exec(output)?.[1]
        expect(status, 'Native proxy returned the wrong isolation status').toBe(policy === 'undeclared' ? '502' : '403')
      }
      if (policy === 'none') {
        const marker = `none-${username}`
        await runCommunityTerminal(page, `node member-network-probe.mjs public unused ${marker}`, `PROBE_FINISHED_${marker}`)
        const output = (await page.locator('.xterm-screen:visible .xterm-rows').allTextContents()).join('\n')
        expect(output).toContain(`HTTP_200_HTTPS_200_PROBE_FINISHED_${marker}`)
        if (username === 'carol') {
          const adminContext = await newValidationContext(browser)
          const adminPage = await adminContext.newPage()
          await signInCommunity(adminPage, origin, 'fixtureadmin', 'password', true)
          expect(
            (
              await adminContext.request.post(origin + '/admin/api/accounts/bob/actions', {
                headers: { origin },
                data: { action: 'set-disabled', disabled: true },
              })
            ).status(),
          ).toBe(200)
          await adminContext.close()
          if (!firstMemberToken) throw new Error('First member credential was not captured before disable')
          const denied = await new Promise<number>((resolve, reject) => {
            const probe = request(
              {
                host: '127.0.0.1',
                port: runtime!.container!.gatewayPort,
                path: publicHttp + '/health',
                headers: { 'proxy-authorization': 'Basic ' + Buffer.from('dsh:' + firstMemberToken).toString('base64') },
              },
              response => {
                response.resume()
                resolve(response.statusCode!)
              },
            )
            probe.on('error', reject)
            probe.setTimeout(10000, () => probe.destroy(new Error('Revoked member probe deadline')))
            probe.end()
          })
          expect(denied).toBe(403)
          await runCommunityTerminal(page, 'node member-network-probe.mjs public unused carol-after-bob-disabled', 'PROBE_FINISHED_carol-after-bob-disabled')
          const retained = (await page.locator('.xterm-screen:visible .xterm-rows').allTextContents()).join('\n')
          expect(retained).toContain('HTTP_200_HTTPS_200_PROBE_FINISHED_carol-after-bob-disabled')
        }
      }
      await context.close()
    }
    await application.stop()
    application = undefined
  }
}, 600_000)
