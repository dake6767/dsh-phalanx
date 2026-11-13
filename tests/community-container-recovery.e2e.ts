// Validation: T2; real credentials: none; actual Linux rootless DSH. Missing inputs must fail the T2 report gate.
import { memberSpacePath } from './support/real-dsh-runtime.js'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser } from 'playwright'
import { afterEach, expect, it } from 'vitest'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import { ContainerMemberCredentials } from '../src/adapters/member-credentials.js'
import type { CommunityRuntimeConfig } from '../src/domain/community-config.js'
import { effectiveUserDataRoot } from '../src/domain/storage-layout.js'
import { MODEL_GATEWAY_PATH } from '../src/dsh/model-protocol.js'
import { dshWebProfilePath } from '../src/dsh/profile-layout.js'
import { SESSION_LIST } from '../src/dsh/session-protocol.js'
import type { CommunityApplication } from '../src/ports/community-application.js'
import { newValidationContext, saveBrowserEvidence } from './fixtures/browser-evidence.js'
import { startCommunityModel } from './fixtures/community-model.js'
import { runCommunityTerminal, selectCommunityWorkspace, sendCommunityTerminal, signInCommunity } from './fixtures/community-native-browser.js'
import { removeCommunityFixture } from './fixtures/owned-cleanup.js'
import { candidateApplication } from './support/candidate-application.js'
import { openTestAccounts } from './support/community-application.js'
import { communityEntryUrl } from './support/community-space.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { cookieHeader, createRealDshRpc, rpcBody } from './support/real-dsh-rpc.js'
import { assertPinnedDshRevision, instanceWorkspacePath, runtimeSection } from './support/real-dsh-runtime.js'

let root: string | undefined
let application: CommunityApplication | undefined
let browser: Browser | undefined
let runtime: CommunityRuntimeConfig | undefined
let model: Awaited<ReturnType<typeof startCommunityModel>> | undefined

afterEach(async test => {
  await saveBrowserEvidence(test)
  model?.release()
  await browser?.close()
  await application?.stop()
  if (runtime !== undefined) await new CommunityRuntimeDriver(runtime).rebuild()
  await model?.close()
  if (root !== undefined) await removeCommunityFixture(root)
  root = undefined
  application = undefined
  browser = undefined
  runtime = undefined
  model = undefined
})

it('keeps two rootless native user spaces isolated and rebuilds their own files and sessions after platform restart', async () => {
  if (process.platform !== 'linux' || process.getuid?.() === 0 || runtimeSettings.containerImage === undefined)
    throw new Error('This acceptance requires real Linux rootless containers')
  assertPinnedDshRevision(runtimeSettings)
  root = await mkdtemp(join(tmpdir(), 'community-container-recovery-'))
  model = await startCommunityModel()
  runtime = runtimeSection(root, model.origin, runtimeSettings)
  const configFixtureKey = 'community-provider-fixture-key'
  const config = {
    listen: { host: '127.0.0.1', port: 0 },
    sessionSecret: 'community-container-session-secret-at-least-32-bytes',
    runtime,
    modelGateway: { upstreamApiKey: configFixtureKey },
  }
  application = candidateApplication(config)
  const store = await openTestAccounts(root)
  await store.createFirstAdmin({ username: 'fixtureadmin', email: '', password: 'password' })
  try {
    for (const username of ['alice', 'bob']) await store.create({ username, email: `${username}@example.test`, password: 'password' })
  } finally {
    await store.close()
  }
  const origin = await application.start()
  expect((await fetch(`${origin}${MODEL_GATEWAY_PATH}`, { method: 'POST' })).status).toBe(404)
  expect((await fetch(`http://127.0.0.1:${runtime.container!.gatewayPort}${MODEL_GATEWAY_PATH}`, { method: 'POST' })).status).toBe(401)
  browser = await chromium.launch({ headless: true })
  const worlds = await Promise.all(
    ['alice', 'bob'].map(async username => {
      const context = await newValidationContext(browser!)
      const page = await context.newPage()
      await signInCommunity(page, origin, username, 'password')
      await selectCommunityWorkspace(context, page, origin, instanceWorkspacePath('', true), true)
      return { username, context, page }
    }),
  )
  const rpc = createRealDshRpc()
  const list = async (world: (typeof worlds)[number], entry: string) =>
    await rpc.remoteRpc<{ items: { sessionId: string; cwd?: string }[] }>(entry, await cookieHeader(world.context, entry), SESSION_LIST, { _request: {} })
  const sessions = await Promise.all(worlds.map(async world => (await list(world, origin)).items.find(item => item.cwd?.includes('default-workspace'))!))
  expect(sessions[0]!.sessionId).not.toBe(sessions[1]!.sessionId)
  await Promise.all(
    worlds.map(async world => {
      const marker = `${world.username.toUpperCase()}_SPACE`
      await runCommunityTerminal(
        world.page,
        `printf '%s\\n' '${world.username}' > user-space.txt; cat user-space.txt; printf '\\125\\123\\105\\122\\137\\106\\111\\114\\105\\137\\117\\113'`,
        'USER_FILE_OK',
      )
      const composer = world.page.locator('[data-composer-input]')
      await composer.fill(`${marker}: Reply with the deterministic marker.`)
      await composer.press('Enter')
      await world.page.getByText('COMMUNITY_', { exact: true }).waitFor({ timeout: 90_000 })
    }),
  )
  model.release()
  await Promise.all(
    worlds.map(async world => {
      await world.page.locator('p').filter({ hasText: 'COMMUNITY_MODEL_READY' }).first().waitFor({ timeout: 90_000 })
    }),
  )
  for (let i = 0; i < worlds.length; i++) {
    const world = worlds[i]!
    const other = worlds[1 - i]!
    const cookie = await cookieHeader(world.context, origin)
    const crossed = await rpc.remoteRpcResult(origin, cookie, 'workspaceFiles/read', {
      workspaceFileScopeId: sessions[1 - i]!.sessionId,
      path: 'user-space.txt',
      range: { offset: 1 },
    })
    expect(crossed.ok).toBe(false)
    const spoofed = await fetch(`${communityEntryUrl(origin, cookie)}api/${SESSION_LIST}?userId=${other.username}&instance=${sessions[1 - i]!.sessionId}`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: rpcBody(SESSION_LIST, { _request: {} }),
    })
    expect(spoofed.status).toBe(200)
    const response = (await spoofed.json()) as { result: { ok: boolean; value: { items: { sessionId: string }[] } } }
    expect(response.result.ok).toBe(true)
    expect(response.result.value.items.some(item => item.sessionId === sessions[1 - i]!.sessionId)).toBe(false)
    expect((await list(world, origin)).items.some(item => item.sessionId === sessions[1 - i]!.sessionId)).toBe(false)
    await sendCommunityTerminal(
      world.page,
      `if [ ! -e '${join(await memberSpacePath(root, other.username), 'home')}' ] && [ ! -e '${join(await memberSpacePath(root, other.username), 'workspace')}' ] && [ -z "\${DSH_PHALANX_MODEL_UPSTREAM_API_KEY-}" ]; then printf '\\111\\123\\117\\114\\101\\124\\105\\104'; fi`,
      'ISOLATED',
    )
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        expect((await list(world, origin)).items.some(item => item.sessionId === sessions[i]!.sessionId)).toBe(true)
      }),
    )
  }
  // Native user capabilities stay on public entry; Podman only observes container ownership/loopback.
  const cli = runtimeSettings.containerRuntimeCli
  const ownership = createHash('sha256').update(root).digest('hex')
  const names = () =>
    execFileSync(cli, ['ps', '--all', '--filter', `label=dsh-phalanx.community-root=${ownership}`, '--format', '{{.Names}}'], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter(Boolean)
  const beforeHostnames = new Map<string, string>()
  const before = names()
  expect(before).toHaveLength(2)
  const memberContainer = (username: string) => {
    const owned = execFileSync(
      cli,
      ['ps', '--filter', `label=dsh-phalanx.community-root=${ownership}`, '--filter', `label=dsh-phalanx.user=${username}`, '--format', '{{.Names}}'],
      { encoding: 'utf8' },
    ).trim()
    if (!names().includes(owned)) throw Error('Expected one running member container')
    return owned
  }
  const credentials = (username: string) => {
    const carrier = memberContainer(username)
    return new ContainerMemberCredentials(cli, async () => carrier)
  }
  const attributes = { application: 'credential-fixture', account: 'personal' }
  const [alice] = worlds
  let aliceStore = credentials('alice')
  let bobStore = credentials('bob')
  expect(await aliceStore.lookup(attributes)).toBeUndefined()
  await aliceStore.store(attributes, 'fixture-alice-value\nline two\n')
  expect(await bobStore.lookup(attributes)).toBeUndefined()
  await bobStore.store(attributes, 'fixture-bob-value')
  expect(await aliceStore.lookup(attributes)).toBe('fixture-alice-value\nline two\n')
  await aliceStore.store({ ...attributes, account: 'capacity' }, 'x'.repeat(8191))
  await expect(aliceStore.store({ ...attributes, account: 'capacity' }, 'x'.repeat(8192))).rejects.toMatchObject({
    code: 'runtime-credentials-unavailable',
  })
  expect(await aliceStore.lookup({ ...attributes, account: 'capacity' })).toBe('x'.repeat(8191))
  const profile = dshWebProfilePath(join(await memberSpacePath(root, 'alice'), 'home'))
  const unlock = join(profile, '.phalanx-credentials', 'unlock')
  expect((await lstat(unlock)).mode & 0o777).toBe(0o600)
  const originalUnlock = await readFile(unlock)
  const keyring = await readFile(join(profile, '.phalanx-credentials', 'keyrings', 'login.keyring'))
  expect(keyring.includes('fixture-alice-value') || keyring.includes(configFixtureKey)).toBe(false)
  for (const name of before) {
    const inspected = JSON.parse(execFileSync(cli, ['inspect', name], { encoding: 'utf8' })) as {
      Config: { User: string; Hostname: string; Labels: Record<string, string>; Env: readonly string[] }
      HostConfig: { Privileged: boolean }
      NetworkSettings: { Ports: Record<string, { HostIp: string }[]> }
    }[]
    const config = inspected[0]!.Config
    expect(config.Labels['dsh-phalanx.space']).toMatch(/^[a-f0-9]{32}$/u)
    beforeHostnames.set(config.Labels['dsh-phalanx.user']!, config.Hostname)
    expect(inspected[0]!.Config.User).toBe(`${process.getuid!()}:${process.getgid!()}`)
    expect(config.Env.some(value => value.includes(configFixtureKey))).toBe(false)
    expect(execFileSync(cli, ['logs', name], { encoding: 'utf8' }).includes(configFixtureKey)).toBe(false)
    expect(inspected[0]!.HostConfig.Privileged).toBe(false)
    expect(inspected[0]!.NetworkSettings.Ports[`${runtime.container!.internalPort}/tcp`]).toEqual([expect.objectContaining({ HostIp: '127.0.0.1' })])
  }
  await application.stop()
  expect(names()).toEqual(expect.arrayContaining(before))
  application = candidateApplication(config)
  const restarted = await application.start()
  expect(names()).toEqual([])
  for (let i = 0; i < worlds.length; i++) {
    const world = worlds[i]!
    await signInCommunity(world.page, restarted, world.username, 'password')
    await selectCommunityWorkspace(world.context, world.page, restarted, instanceWorkspacePath('', true), true)
    await runCommunityTerminal(
      world.page,
      `if [ "$(cat user-space.txt)" = '${world.username}' ]; then printf '\\122\\105\\123\\124\\117\\122\\105\\104'; fi`,
      'RESTORED',
    )
    expect((await list(world, restarted)).items.some(item => item.sessionId === sessions[i]!.sessionId)).toBe(true)
    expect((await list(world, restarted)).items.some(item => item.sessionId === sessions[1 - i]!.sessionId)).toBe(false)
  }
  expect(names()).toHaveLength(2)
  expect(names().some(name => before.includes(name))).toBe(false)
  await expect(aliceStore.lookup(attributes)).rejects.toMatchObject({ code: 'runtime-credentials-unavailable' })
  aliceStore = credentials('alice')
  bobStore = credentials('bob')
  for (const name of names()) {
    const record = JSON.parse(execFileSync(cli, ['inspect', name], { encoding: 'utf8' }))[0] as { Config: { Hostname: string; Labels: Record<string, string> } }
    expect(record.Config.Hostname).toBe(beforeHostnames.get(record.Config.Labels['dsh-phalanx.user']!))
  }
  expect(await aliceStore.lookup(attributes)).toBe('fixture-alice-value\nline two\n')
  expect(await bobStore.lookup(attributes)).toBe('fixture-bob-value')
  const aliceCarrier = memberContainer('alice')
  const bobCarrier = memberContainer('bob')
  await chmod(unlock, 0o644)
  const recover = (path: 'restart' | 'reset') =>
    alice!.context.request.post(restarted + '/recovery/' + path, { headers: { origin: restarted }, data: { confirmed: true }, timeout: 300_000 })
  const failed = await recover('restart')
  expect(failed.status()).toBe(503)
  expect(await failed.json()).toMatchObject({ code: 'runtime-credentials-unavailable' })
  expect(names()).toEqual([bobCarrier])
  expect(await bobStore.lookup(attributes)).toBe('fixture-bob-value')
  await chmod(unlock, 0o600)
  expect((await recover('restart')).status()).toBe(200)
  expect(memberContainer('alice')).not.toBe(aliceCarrier)
  await expect(aliceStore.lookup(attributes)).rejects.toMatchObject({ code: 'runtime-credentials-unavailable' })
  aliceStore = credentials('alice')
  expect(await aliceStore.lookup(attributes)).toBe('fixture-alice-value\nline two\n')
  const reset = await recover('reset')
  expect(reset.status()).toBe(200)
  await expect(aliceStore.lookup(attributes)).rejects.toMatchObject({ code: 'runtime-credentials-unavailable' })
  expect(await credentials('alice').lookup(attributes)).toBeUndefined()
  expect(await bobStore.lookup(attributes)).toBe('fixture-bob-value')
  expect(memberContainer('bob')).toBe(bobCarrier)
  const backupRoot = join(effectiveUserDataRoot(runtime), '_environment-backups')
  const spaces = await readdir(backupRoot)
  expect(spaces).toHaveLength(1)
  const backups = await readdir(join(backupRoot, spaces[0]!))
  expect(backups).toHaveLength(1)
  const backedUp = await readFile(join(backupRoot, spaces[0]!, backups[0]!, 'files/.dsh/profiles/web/.phalanx-credentials/unlock'))
  expect(backedUp.equals(originalUnlock)).toBe(true)
  expect((await readFile(unlock)).equals(originalUnlock)).toBe(false)
}, 600_000)
