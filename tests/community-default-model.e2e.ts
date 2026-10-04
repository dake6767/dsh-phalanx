import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'
import { createCommunityApplication } from '../src/composition/community-application.js'
import type { CommunityApplication } from '../src/ports/community-application.js'
import { CommunityAccountStore } from '../src/adapters/community-account-store.js'
import { MODEL_GATEWAY_PATH } from '../src/dsh/model-protocol.js'
import { assertPinnedDshRevision, runtimeSection, defaultWorkspacePath } from './support/real-dsh-runtime.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { signInCommunity, selectCommunityWorkspace, runCommunityTerminal } from './fixtures/community-native-browser.js'
import { newValidationContext, saveBrowserEvidence } from './fixtures/browser-evidence.js'
import { startCommunityModel } from './fixtures/community-model.js'
import { cookieHeader, createRealDshRpc } from './support/real-dsh-rpc.js'

describe('community default model through native DSH', () => {
  let root: string | undefined
  let application: CommunityApplication | undefined
  let accounts: CommunityAccountStore | undefined
  let browser: Browser | undefined
  let model: Awaited<ReturnType<typeof startCommunityModel>> | undefined
  afterEach(async test => {
    await saveBrowserEvidence(test); model?.release(); await browser?.close(); await application?.stop()
    accounts?.close(); await model?.close()
    if (root !== undefined) await rm(root, { recursive: true, force: true })
    root = undefined; application = undefined; accounts = undefined; browser = undefined; model = undefined
  })
  it('streams before completion, cancels the upstream turn and keeps the provider secret out of native entry', async () => {
    if (runtimeSettings.dshRoot === undefined || runtimeSettings.containerImage !== undefined) throw new Error('This acceptance requires pinned development DSH, without a container image')
    assertPinnedDshRevision(runtimeSettings)
    root = await mkdtemp(join(tmpdir(), 'community-native-model-'))
    model = await startCommunityModel()
    application = createCommunityApplication({ listen: { host: '127.0.0.1', port: 0 },
      sessionSecret: 'community-default-model-session-secret-32-bytes', runtime: runtimeSection(root, model.origin, runtimeSettings),
      modelGateway: { upstreamApiKey: 'community-provider-fixture-key' } })
    accounts = new CommunityAccountStore(join(root, 'community-accounts.db'))
    await accounts.create({ username: 'member', email: 'member@example.test', password: 'password' })
    const origin = await application.start()
    expect((await fetch(`${origin}${MODEL_GATEWAY_PATH}`, { method: 'POST' })).status).toBe(401)
    browser = await chromium.launch({ headless: true })
    const context = await newValidationContext(browser); const page = await context.newPage()
    const frames: string[] = []
    page.on('websocket', socket => socket.on('framereceived', event => { frames.push(String(event.payload)) }))
    await signInCommunity(page, origin, 'member', 'password')
    await selectCommunityWorkspace(context, page, origin, defaultWorkspacePath(root, 'member'))
    const catalog = await createRealDshRpc().remoteRpc<{ groups: { models: { id: string }[] }[], failures: unknown[] }>(origin, await cookieHeader(context, origin), 'session/modelCatalog', {})
    expect(catalog.failures).toEqual([])
    expect(catalog.groups.some(group => group.models.some(item => item.id === 'deepseek-chat'))).toBe(true)
    const composer = page.locator('[data-composer-input]')
    await composer.fill('STREAM_MODEL_TASK: Reply with the deterministic marker.'); await composer.press('Enter')
    await page.getByText('COMMUNITY_', { exact: true }).or(page.getByText('This turn failed', { exact: true })).first().waitFor({ timeout: 60_000 })
    expect(await page.getByText('COMMUNITY_', { exact: true }).isVisible(), await page.locator('body').innerText()).toBe(true)
    expect(await page.getByText('COMMUNITY_MODEL_READY', { exact: true }).count()).toBe(0)
    model.release()
    await page.locator('p').filter({ hasText: 'COMMUNITY_MODEL_READY' }).first().waitFor({ timeout: 60_000 })
    await composer.fill('CANCEL_MODEL_TASK: Hold the reply until I cancel it.'); await composer.press('Enter')
    await page.getByText('CANCEL_STARTED', { exact: true }).waitFor({ timeout: 60_000 })
    await page.getByRole('button', { name: 'Stop generating', exact: true }).click()
    await model.cancelled
    await runCommunityTerminal(page, "if [ -z \"${DSH_PHALANX_MODEL_UPSTREAM_API_KEY-}\" ] && [ -z \"${DEEPSEEK_API_KEY-}\" ]; then printf '\\103\\117\\115\\115\\125\\116\\111\\124\\131\\137\\123\\105\\103\\122\\105\\124\\137\\101\\102\\123\\105\\116\\124'; fi", 'COMMUNITY_SECRET_ABSENT')
    expect(await page.content()).not.toContain('community-provider-fixture-key')
    expect(frames.join('\n')).not.toContain('community-provider-fixture-key')
  })
})
