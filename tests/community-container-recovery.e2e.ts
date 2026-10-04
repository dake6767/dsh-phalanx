import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser } from 'playwright'
import { afterEach, expect, it } from 'vitest'
import { candidateApplication } from './support/candidate-application.js'
import { CommunityAccountStore } from '../src/adapters/community-account-store.js'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import type { CommunityApplication } from '../src/ports/community-application.js'
import type { CommunityRuntimeConfig } from '../src/domain/community-config.js'
import { MODEL_GATEWAY_PATH } from '../src/dsh/model-protocol.js'
import { SESSION_LIST } from '../src/dsh/session-protocol.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { assertPinnedDshRevision, runtimeSection, instanceWorkspacePath, defaultWorkspacePath } from './support/real-dsh-runtime.js'
import { cookieHeader, createRealDshRpc, rpcBody } from './support/real-dsh-rpc.js'
import { newValidationContext, saveBrowserEvidence } from './fixtures/browser-evidence.js'
import { signInCommunity, selectCommunityWorkspace, runCommunityTerminal, sendCommunityTerminal } from './fixtures/community-native-browser.js'
import { startCommunityModel } from './fixtures/community-model.js'
import { communityEntryUrl } from './support/community-space.js'

let root: string | undefined
let application: CommunityApplication | undefined
let browser: Browser | undefined
let runtime: CommunityRuntimeConfig | undefined
let model: Awaited<ReturnType<typeof startCommunityModel>> | undefined

afterEach(async test => {
  await saveBrowserEvidence(test)
  model?.release(); await browser?.close(); await application?.stop()
  if (runtime !== undefined) await new CommunityRuntimeDriver(runtime).rebuild()
  await model?.close()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined; application = undefined; browser = undefined; runtime = undefined; model = undefined
})

it('keeps two rootless native user spaces isolated and rebuilds their own files and sessions after platform restart', async () => {
  if (process.platform !== 'linux' || process.getuid?.() === 0 || runtimeSettings.containerImage === undefined) throw new Error('This acceptance requires real Linux rootless containers')
  assertPinnedDshRevision(runtimeSettings)
  root = await mkdtemp(join(tmpdir(), 'community-container-recovery-'))
  model = await startCommunityModel()
  runtime = runtimeSection(root, model.origin, runtimeSettings)
  const config = { listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'community-container-session-secret-at-least-32-bytes',
    runtime, modelGateway: { upstreamApiKey: 'community-provider-fixture-key' } }
  application = candidateApplication(config)
  const store = new CommunityAccountStore(join(root, 'community-accounts.db'))
  try { for (const username of ['alice', 'bob']) await store.create({ username, email: `${username}@example.test`, password: 'password' }) }
  finally { store.close() }
  const origin = await application.start()
  expect((await fetch(`${origin}${MODEL_GATEWAY_PATH}`, { method: 'POST' })).status).toBe(404)
  expect((await fetch(`http://127.0.0.1:${runtime.container!.gatewayPort}${MODEL_GATEWAY_PATH}`, { method: 'POST' })).status).toBe(401)
  browser = await chromium.launch({ headless: true })
  const worlds = await Promise.all(['alice', 'bob'].map(async username => {
    const context = await newValidationContext(browser!); const page = await context.newPage()
    await signInCommunity(page, origin, username, 'password')
    await selectCommunityWorkspace(context, page, origin, instanceWorkspacePath(defaultWorkspacePath(root!, username), true), true)
    return { username, context, page }
  }))
  const rpc = createRealDshRpc()
  const list = async (world: typeof worlds[number], entry: string) => await rpc.remoteRpc<{ items: { sessionId: string, cwd?: string }[] }>(entry, await cookieHeader(world.context, entry), SESSION_LIST, { _request: {} })
  const sessions = await Promise.all(worlds.map(async world => (await list(world, origin)).items.find(item => item.cwd?.includes('default-workspace'))!))
  expect(sessions[0]!.sessionId).not.toBe(sessions[1]!.sessionId)
  await Promise.all(worlds.map(async world => {
    const marker = `${world.username.toUpperCase()}_SPACE`
    await runCommunityTerminal(world.page, `printf '%s\\n' '${world.username}' > user-space.txt; cat user-space.txt; printf '\\125\\123\\105\\122\\137\\106\\111\\114\\105\\137\\117\\113'`, 'USER_FILE_OK')
    const composer = world.page.locator('[data-composer-input]')
    await composer.fill(`${marker}: Reply with the deterministic marker.`); await composer.press('Enter')
    await world.page.getByText('COMMUNITY_', { exact: true }).waitFor({ timeout: 90_000 })
  }))
  model.release()
  await Promise.all(worlds.map(async world => { await world.page.locator('p').filter({ hasText: 'COMMUNITY_MODEL_READY' }).first().waitFor({ timeout: 90_000 }) }))
  for (let i = 0; i < worlds.length; i++) {
    const world = worlds[i]!; const other = worlds[1 - i]!
    const cookie = await cookieHeader(world.context, origin)
    const crossed = await rpc.remoteRpcResult(origin, cookie, 'workspaceFiles/read', { workspaceFileScopeId: sessions[1 - i]!.sessionId, path: 'user-space.txt', range: { offset: 1 } })
    expect(crossed.ok).toBe(false)
    const spoofed = await fetch(`${communityEntryUrl(origin, cookie)}api/${SESSION_LIST}?userId=${other.username}&instance=${sessions[1 - i]!.sessionId}`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: rpcBody(SESSION_LIST, { _request: {} }) })
    expect(spoofed.status).toBe(200)
    const response = await spoofed.json() as { result: { ok: boolean, value: { items: { sessionId: string }[] } } }
    expect(response.result.ok).toBe(true)
    expect(response.result.value.items.some(item => item.sessionId === sessions[1 - i]!.sessionId)).toBe(false)
    expect((await list(world, origin)).items.some(item => item.sessionId === sessions[1 - i]!.sessionId)).toBe(false)
    await sendCommunityTerminal(world.page,
      `if [ ! -e '${join(root, 'users', other.username, 'home')}' ] && [ ! -e '${join(root, 'users', other.username, 'workspace')}' ] && [ -z "\${DSH_PHALANX_MODEL_UPSTREAM_API_KEY-}" ]; then printf '\\111\\123\\117\\114\\101\\124\\105\\104'; fi`, 'ISOLATED')
    await Promise.all(Array.from({ length: 4 }, async () => { expect((await list(world, origin)).items.some(item => item.sessionId === sessions[i]!.sessionId)).toBe(true) }))
  }
  // Native user capabilities stay on public entry; Podman only observes container ownership/loopback.
  const cli = runtimeSettings.containerRuntimeCli
  const ownership = createHash('sha256').update(root).digest('hex')
  const names = () => execFileSync(cli, ['ps', '--all', '--filter', `label=dsh-phalanx.community-root=${ownership}`, '--format', '{{.Names}}'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
  const before = names(); expect(before).toHaveLength(2)
  for (const name of before) {
    const inspected = JSON.parse(execFileSync(cli, ['inspect', name], { encoding: 'utf8' })) as { Config: { User: string }, HostConfig: { Privileged: boolean }, NetworkSettings: { Ports: Record<string, { HostIp: string }[]> } }[]
    expect(inspected[0]!.Config.User).toBe(`${process.getuid!()}:${process.getgid!()}`)
    expect(inspected[0]!.HostConfig.Privileged).toBe(false)
    expect(inspected[0]!.NetworkSettings.Ports[`${runtime.container!.internalPort}/tcp`]).toEqual([expect.objectContaining({ HostIp: '127.0.0.1' })])
  }
  await application.stop(); expect(names()).toEqual(expect.arrayContaining(before))
  application = candidateApplication(config)
  const restarted = await application.start()
  expect(names()).toEqual([])
  for (let i = 0; i < worlds.length; i++) {
    const world = worlds[i]!
    await signInCommunity(world.page, restarted, world.username, 'password')
    await selectCommunityWorkspace(world.context, world.page, restarted, instanceWorkspacePath(defaultWorkspacePath(root, world.username), true), true)
    await runCommunityTerminal(world.page, `if [ "$(cat user-space.txt)" = '${world.username}' ]; then printf '\\122\\105\\123\\124\\117\\122\\105\\104'; fi`, 'RESTORED')
    expect((await list(world, restarted)).items.some(item => item.sessionId === sessions[i]!.sessionId)).toBe(true)
    expect((await list(world, restarted)).items.some(item => item.sessionId === sessions[1 - i]!.sessionId)).toBe(false)
  }
  expect(names()).toHaveLength(2)
  expect(names().some(name => before.includes(name))).toBe(false)
}, 600_000)
