import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser } from 'playwright'
import { afterEach, expect, it } from 'vitest'
import { candidateApplication } from './support/candidate-application.js'
import { CommunityAccountStore } from '../src/adapters/community-account-store.js'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import { FileCommunityModelAccess } from '../src/adapters/community-model-access.js'
import type { CommunityApplication } from '../src/ports/community-application.js'
import type { CommunityRuntimeConfig } from '../src/domain/community-config.js'
import { assertPinnedDshRevision, runtimeSection, defaultWorkspacePath, instanceWorkspacePath } from './support/real-dsh-runtime.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { newValidationContext, saveBrowserEvidence } from './fixtures/browser-evidence.js'
import { signInCommunity, selectCommunityWorkspace, runCommunityTerminal } from './fixtures/community-native-browser.js'
import { startCommunityModel } from './fixtures/community-model.js'

let root: string | undefined, application: CommunityApplication | undefined, runtime: CommunityRuntimeConfig | undefined
let browser: Browser | undefined, model: Awaited<ReturnType<typeof startCommunityModel>> | undefined
afterEach(async test => {
  await saveBrowserEvidence(test); model?.release(); await browser?.close(); await application?.stop()
  if (runtime !== undefined) await new CommunityRuntimeDriver(runtime).rebuild()
  await model?.close(); if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined; application = undefined; runtime = undefined; browser = undefined; model = undefined
})
it('denies declared public host aliases and fails closed without a deployment host inventory in real containers', async () => {
  assertPinnedDshRevision(runtimeSettings)
  const aliases = process.env.DSH_PHALANX_E2E_HOST_PUBLIC_ADDRESSES?.split(',')
  if (aliases === undefined || aliases.length === 0) throw new Error('The validation host public IPv4 inventory is required')
  root = await mkdtemp(join(tmpdir(), 'community-native-network-isolation-'))
  model = await startCommunityModel(); runtime = runtimeSection(root, model.origin, runtimeSettings)
  if (runtime.container === undefined) throw new Error('Public host isolation requires Linux rootless containers')
  const config = { listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'community-network-session-secret-at-least-32-bytes', runtime,
    modelGateway: { upstreamApiKey: 'community-provider-fixture-key' } }
  const accounts = new CommunityAccountStore(join(root, 'community-accounts.db'))
  try { await accounts.create({ username: 'bob', email: 'bob@example.test', password: 'password' }) } finally { accounts.close() }
  browser = await chromium.launch({ headless: true })
  for (const declared of [true, false]) {
    application = candidateApplication({ ...config, ...(declared ? { network: { hostPublicAddresses: aliases } } : {}) })
    const origin = await application.start()
    const context = await newValidationContext(browser); const page = await context.newPage()
    await signInCommunity(page, origin, 'bob', 'password')
    const workspace = defaultWorkspacePath(root, 'bob')
    await selectCommunityWorkspace(context, page, origin, instanceWorkspacePath(workspace, true), true)
    await page.getByRole('button', { name: 'New session', exact: true }).first().click()
    await page.getByText('Into the Unknown', { exact: true }).waitFor()
    await page.locator('[data-composer-input]').fill('NETWORK_PROBE_TASK: Reply with your fixture marker.')
    await page.locator('[data-composer-input]').press('Enter')
    await page.getByText('COMMUNITY_', { exact: true }).waitFor({ timeout: 90_000 }); model.release()
    await page.getByText('COMMUNITY_MODEL_READY', { exact: true }).waitFor()
    // Only this member's fictional scoped credential enters the arranged private script, never its command.
    const storedAccounts = new CommunityAccountStore(join(root, 'community-accounts.db'))
    const spaceId = storedAccounts.getState('bob')!.spaceId
    storedAccounts.close()
    const token = new FileCommunityModelAccess(join(root, 'model-access.json')).forUser('bob', spaceId)
    await writeFile(join(workspace, 'host-probe.cjs'), `
const http=require('node:http');
const request=http.request({host:'127.0.0.1',port:${runtime.container.gatewayPort},method:'CONNECT',path:process.argv[2],headers:{'proxy-authorization':'Basic '+Buffer.from(${JSON.stringify(`dsh:${token}`)}).toString('base64')}});
const result=(response,socket)=>{process.stdout.write('STATUS_'+response.statusCode+'_PROBE_FINISHED_'+process.argv[3]);socket?.destroy();response.resume()};
request.on('connect',result);request.on('response',result);request.on('error',()=>process.stdout.write('ERROR_PROBE_FINISHED_'+process.argv[3]));request.setTimeout(10000,()=>request.destroy());request.end();
`, { mode: 0o600 })
    const targets = declared ? aliases.map(address => `${address}:22`) : ['1.1.1.1:443']
    for (const [index, target] of targets.entries()) {
      const probe = `host-${declared ? 'declared' : 'missing'}-${index}`
      await runCommunityTerminal(page, `node host-probe.cjs ${target} ${probe}`, `PROBE_FINISHED_${probe}`)
      const output = (await page.locator('.xterm-screen:visible .xterm-rows').allTextContents()).join('\n')
      const status = new RegExp(`STATUS_([0-9]+)_PROBE_FINISHED_${probe}`, 'u').exec(output)?.[1]
      expect(status, 'Native proxy returned the wrong isolation status').toBe(declared ? '403' : '502')
    }
    await context.close(); await application.stop(); application = undefined
  }
}, 600_000)
