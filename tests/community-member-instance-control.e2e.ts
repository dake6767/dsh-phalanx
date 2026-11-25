// Validation: T2; real credentials: none; actual Linux rootless DSH and administrator browser operations.
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser } from 'playwright'
import { afterEach, expect, it } from 'vitest'
import { execFileText } from '../src/adapters/runtime-command.js'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import type { CommunityRuntimeConfig } from '../src/domain/community-config.js'
import { DSH_CONTAINER_HOME, DSH_PATCH_CONFIG, DSH_PROFILE_MANIFEST, dshWebProfilePath } from '../src/dsh/profile-layout.js'
import { PROFILE_WRITER_HOME_LABEL } from '../src/dsh/container-write-lock.js'
import type { CommunityApplication } from '../src/ports/community-application.js'
import { newValidationContext, saveBrowserEvidence } from './fixtures/browser-evidence.js'
import { communityEntryUrl } from './support/community-space.js'
import { memberContainerShutdownProbe } from './fixtures/member-container-shutdown-probe.js'
import { memberProfileLockModule } from './fixtures/member-profile-lock-module.js'
import { startCommunityModel } from './fixtures/community-model.js'
import { runCommunityTerminal, selectCommunityWorkspace, signInCommunity } from './fixtures/community-native-browser.js'
import { removeCommunityFixture } from './fixtures/owned-cleanup.js'
import { candidateApplication } from './support/candidate-application.js'
import { openTestAccounts, openTestDatabase } from './support/community-application.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { cookieHeader, createBrowserDshRpc } from './support/real-dsh-rpc.js'
import { assertPinnedDshRevision, defaultWorkspacePath, instanceWorkspacePath, memberSpacePath, runtimeSection } from './support/real-dsh-runtime.js'
let root: string | undefined
let app: CommunityApplication | undefined
let browser: Browser | undefined
let runtime: CommunityRuntimeConfig | undefined
let model: Awaited<ReturnType<typeof startCommunityModel>> | undefined

async function lockIdentity(lock: string) {
  try {
    const { dev, ino, birthtimeNs } = await lstat(lock, { bigint: true })
    return `${dev}:${ino}:${birthtimeNs}`
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return undefined
  }
}

afterEach(async test => {
  await saveBrowserEvidence(test)
  model?.release()
  await browser?.close()
  await app?.stop()
  if (runtime) await new CommunityRuntimeDriver(runtime).rebuild()
  await model?.close()
  if (root) await removeCommunityFixture(root)
})

it('starts and restarts new and legacy member spaces from the administrator menu without losing native configuration or files', async () => {
  assertPinnedDshRevision(runtimeSettings)
  root = await mkdtemp(join(tmpdir(), 'member-admin-instances-'))
  model = await startCommunityModel()
  runtime = runtimeSection(root, model.origin, runtimeSettings)
  app = candidateApplication({
    listen: { host: '127.0.0.1', port: 0 },
    sessionSecret: 'member-admin-instance-fixture-secret',
    runtime,
    modelGateway: { upstreamApiKey: 'community-provider-fixture-key' },
  })
  const accounts = await openTestAccounts(root)
  try {
    await accounts.createFirstAdmin({ username: 'admin', email: '', password: 'password' })
    for (const username of ['legacy', 'member']) await accounts.create({ username, email: '', password: 'password' })
    await accounts.setAdmin('member', true)
  } finally {
    await accounts.close()
  }
  const database = await openTestDatabase(root)
  try {
    await database.query("UPDATE dsh_phalanx.accounts SET storage_key='legacy' WHERE username='legacy'")
  } finally {
    await database.close()
  }
  const origin = await app.start()
  browser = await chromium.launch({ headless: true })
  const manager = await newValidationContext(browser, { locale: 'en' }),
    admin = await manager.newPage()
  await signInCommunity(admin, origin, 'admin', 'password', true)
  for (const username of ['legacy', 'member']) {
    await admin.goto(origin + '/admin')
    await admin.getByRole('button', { name: `More actions for ${username}`, exact: true }).click()
    await admin.getByRole('menuitem', { name: 'Start instance', exact: true }).click()
    await admin.getByText('Instance operation completed.', { exact: true }).waitFor()
    const facts = async () =>
      (await (await manager.request.get(origin + '/admin/api/accounts')).json()).items.find((row: { username: string }) => row.username === username)
    const before = await facts()
    const instanceKey = async () => (await (await manager.request.get(origin + `/admin/api/instance-resources?username=${username}`)).json()).instanceKey
    const originalInstance = await instanceKey()
    expect(originalInstance).toEqual(expect.any(String))
    const space = await memberSpacePath(root, username)
    expect(space.endsWith(username === 'legacy' ? '/legacy' : '/_spaces/' + before.spaceId)).toBe(true)
    const memberContext = await newValidationContext(browser, { locale: 'en' }),
      page = await memberContext.newPage()
    await signInCommunity(page, origin, 'admin', 'password', true)
    const managementTab = await memberContext.newPage()
    await managementTab.goto(origin + '/admin')
    await managementTab.getByRole('heading', { name: 'Account management', exact: true }).waitFor()
    await page.getByRole('button', { name: `More actions for ${username}`, exact: true }).click()
    await page.getByRole('menuitem', { name: 'Switch to this member’s DSH', exact: true }).click()
    expect(await page.getByLabel('Username', { exact: true }).inputValue()).toBe(username)
    await page.getByLabel('Password', { exact: true }).fill('wrong-password')
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await page.getByRole('alert').waitFor()
    expect(await (await memberContext.request.get(origin + '/account/identity')).json()).toMatchObject({ username: 'admin' })
    await page.getByLabel('Password', { exact: true }).fill('password')
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await page.waitForURL(origin + `/app/${before.spaceId}/`)
    await managementTab.getByText(`This browser switched to account ${username}.`, { exact: true }).waitFor()
    expect(await (await memberContext.request.get(origin + '/account/identity')).json()).toEqual({ username, admin: username === 'member' })
    const all = (await (await manager.request.get(origin + '/admin/api/accounts')).json()).items
    const peer = all.find((row: { username: string }) => row.username === (username === 'legacy' ? 'member' : 'legacy'))
    expect((await memberContext.request.get(origin + `/app/${peer.spaceId}/`)).status()).toBe(403)
    const workspace = instanceWorkspacePath(await defaultWorkspacePath(root, username), runtime.container !== undefined)
    await selectCommunityWorkspace(memberContext, page, origin, workspace, runtime.container !== undefined)
    await runCommunityTerminal(page, `printf MEMBER_PERSISTED > '${workspace}/member-retained.txt'; cat '${workspace}/member-retained.txt'`, 'MEMBER_PERSISTED')
    const home = join(space, 'home'),
      packageRoot = join(home, 'restart-fixture')
    await mkdir(packageRoot)
    const packageName = '@example/restart-persistence'
    await writeFile(
      join(packageRoot, 'package.json'),
      JSON.stringify({ name: packageName, version: '1.0.0', type: 'module', main: './index.js', dsh: { bundle: { patch: './patch.yml' } } }),
    )
    await writeFile(
      join(packageRoot, 'index.js'),
      `import {readFileSync,writeFileSync} from 'node:fs';import {join} from 'node:path';export const name='restart-persistence';export function apply(_ctx,config){writeFileSync(join(process.env.HOME,'restart-plugin-output'),readFileSync(join(process.env.HOME,'restart-plugin-input'),'utf8')+'|'+config.marker)}`,
    )
    await writeFile(
      join(packageRoot, 'patch.yml'),
      JSON.stringify([{ insert: [{ id: 'restart-persistence', name: packageName, config: { marker: username } }] }]),
    )
    await writeFile(join(home, 'restart-plugin-input'), 'PERSISTED_PLUGIN_DATA')
    const packed = JSON.parse(await execFileText('npm', ['pack', packageRoot, '--ignore-scripts', '--json', '--pack-destination', home])) as {
      filename: string
    }[]
    const instanceHome = runtime.container ? '/dsh-phalanx/home' : home
    const rpc = createBrowserDshRpc(memberContext),
      cookie = await cookieHeader(memberContext, origin)
    await rpc.remoteRpc(origin, cookie, 'pluginManager/installBundle', { spec: join(instanceHome, packed[0]!.filename), options: { enabled: true } })
    const output = join(home, 'restart-plugin-output')
    await expect.poll(() => readFile(output, 'utf8').catch(() => '')).toBe('PERSISTED_PLUGIN_DATA|' + username)
    await rm(output)
    const patch = join(dshWebProfilePath(join(space, 'home')), DSH_PATCH_CONFIG)
    const original = await readFile(patch)
    await admin.getByRole('button', { name: `More actions for ${username}`, exact: true }).click()
    await admin.getByRole('menuitem', { name: 'Restart instance', exact: true }).click()
    await admin.getByRole('dialog', { name: 'Restart instance', exact: true }).getByRole('button', { name: 'Restart instance', exact: true }).click()
    await admin.getByRole('dialog', { name: 'Restart instance', exact: true }).waitFor({ state: 'detached' })
    const after = await facts()
    expect(after.spaceId).toBe(before.spaceId)
    expect(after.instance.state).toBe('ready')
    expect(await instanceKey()).not.toBe(originalInstance)
    expect(await readFile(patch)).toEqual(original)
    await expect.poll(() => readFile(output, 'utf8').catch(() => ''), { timeout: 30000 }).toBe('PERSISTED_PLUGIN_DATA|' + username)
    await page.goto(origin + `/app/${before.spaceId}/`)
    await selectCommunityWorkspace(memberContext, page, origin, workspace, runtime.container !== undefined)
    await runCommunityTerminal(page, `cat '${workspace}/member-retained.txt'`, 'MEMBER_PERSISTED')
    await page.goto(origin + '/login')
    await page.getByRole('button', { name: 'adminAdministrator', exact: true }).click()
    await page.waitForURL(origin + '/admin')
    expect(await (await memberContext.request.get(origin + '/account/identity')).json()).toEqual({ username: 'admin', admin: true })
    await memberContext.close()
  }
}, 600_000)

it('honors the shutdown grace during administrative restart and startup failure cleanup', async () => {
  assertPinnedDshRevision(runtimeSettings)
  if (!runtimeSettings.containerImage || process.platform !== 'linux') throw new Error('Requires rootless Linux DSH')
  root = await mkdtemp(join(tmpdir(), 'member-shutdown-grace-'))
  model = await startCommunityModel()
  const modes = ['restart-timeout', 'startup-graceful', 'startup-timeout', 'restart-shared'] as const
  const config: CommunityRuntimeConfig = runtimeSection(root, model.origin, runtimeSettings)
  if (!config.container) throw new Error('The shutdown probe requires a container runtime')
  const podman = config.container.runtime
  const probe = await memberContainerShutdownProbe(root, podman, createHash('sha256').update(root).digest('hex'))
  const overlay = join(root, 'lock-fixture.json')
  await writeFile(overlay, JSON.stringify([{ insert: [{ id: 'profile-lock-fixture', name: join(DSH_CONTAINER_HOME, 'profile-lock-fixture.mjs') }] }]))
  runtime = { ...config, patches: [overlay], container: { ...config.container, runtime: probe.runtime } }
  app = candidateApplication({
    listen: { host: '127.0.0.1', port: 0 },
    sessionSecret: 'member-shutdown-probe-fixture-secret',
    idleReclaimSeconds: 0,
    runtime,
    modelGateway: { upstreamApiKey: 'community-provider-fixture-key' },
  })
  const accounts = await openTestAccounts(root)
  try {
    await accounts.createFirstAdmin({ username: 'admin', email: '', password: 'password' })
    for (const username of modes) await accounts.create({ username, email: '', password: 'password' })
  } finally {
    await accounts.close()
  }
  const origin = await app.start()
  browser = await chromium.launch({ headless: true })
  const context = await newValidationContext(browser, { locale: 'en' })
  await signInCommunity(await context.newPage(), origin, 'admin', 'password', true)
  const members = ((await (await context.request.get(origin + '/admin/api/accounts')).json()) as { items: { username: string; spaceId: string }[] }).items
  for (const mode of modes) {
    const member = members.find(row => row.username === mode)
    if (!member) throw new Error('Shutdown probe account was not created')
    const home = join(await memberSpacePath(root, mode), 'home')
    await mkdir(home, { recursive: true, mode: 0o700 })
    await writeFile(join(home, 'profile-lock-fixture.mjs'), memberProfileLockModule)
    const holdAtStartup = join(home, 'profile-lock-at-start')
    await writeFile(holdAtStartup, 'hold', { mode: 0o600 })
    const profile = dshWebProfilePath(home),
      lock = join(profile, DSH_PROFILE_MANIFEST + '.lock'),
      marker = join(profile, 'graceful-lock-fixture')
    const operate = (action: 'start' | 'restart') =>
      context.request.post(origin + `/admin/api/accounts/${mode}/instance`, {
        headers: { origin },
        data: { action, confirmed: true, spaceId: member.spaceId },
        timeout: 300_000,
      })
    const restart = mode.startsWith('restart-')
    const shared = mode === 'restart-shared'
    let predecessorLock: string | undefined
    let predecessorRecord: string | undefined
    if (restart) {
      expect((await operate('start')).status()).toBe(200)
      predecessorRecord = await readFile(lock, 'utf8')
      expect(predecessorRecord).toMatch(/^[1-9][0-9]*\n$/u)
      predecessorLock = await lockIdentity(lock)
      expect(predecessorLock, mode).toBeDefined()
      await rm(holdAtStartup)
    }
    const peer = shared
      ? (
          await execFileText(podman, [
            'run',
            '--rm',
            '--detach',
            '--network=none',
            '--userns=keep-id',
            '--volume',
            `${home}:${DSH_CONTAINER_HOME}`,
            '--entrypoint=/bin/sleep',
            runtimeSettings.containerImage,
            '180',
          ])
        ).trim()
      : undefined
    try {
      if (mode === 'restart-timeout') await writeFile(probe.launchLock, lock, { mode: 0o600 })
      await writeFile(probe.scenario, mode, { mode: 0o600 })
      const outcome = await operate(restart ? 'restart' : 'start')
      expect(outcome.status(), await outcome.text()).toBe(shared ? 503 : restart ? 200 : 500)
      if (peer) await expect(execFileText(podman, ['inspect', '--format', '{{.State.Running}}', peer])).resolves.toBe('true\n')
    } finally {
      await rm(probe.scenario, { force: true })
      if (mode === 'restart-timeout') await rm(probe.launchLock, { force: true })
      if (peer && /^[a-f0-9]{64}$/u.test(peer)) await execFileText(podman, ['rm', '-f', '--ignore', peer])
    }
    const recorded = (await readFile(probe.receipt, 'utf8')).trimEnd().split('\n').at(-1)
    if (!recorded) throw new Error('Podman did not record the member shutdown')
    const {
      mode: recordedMode,
      target,
      seconds,
      state,
      code,
      claimedWriter,
    } = JSON.parse(recorded) as {
      mode: string
      target: string
      seconds: number
      state: string
      code: number
      claimedWriter: boolean
    }
    expect(recordedMode).toBe(mode)
    expect(state).toBe('exited')
    expect(seconds).toBe(10)
    expect(code).toBe(mode === 'startup-graceful' ? 143 : 137)
    if (mode === 'startup-graceful') expect(await readFile(marker, 'utf8')).toBe('released')
    else await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(execFileText(podman, ['container', 'exists', target])).rejects.toMatchObject({ code: 1 })
    const lockOutcome = `${mode}, stopped carrier had an exclusive writer claim: ${claimedWriter}`
    const remaining = await lockIdentity(lock)
    if (shared) {
      expect(remaining, lockOutcome).toBe(predecessorLock)
      expect(await readFile(lock, 'utf8'), lockOutcome).toBe(predecessorRecord)
    } else if (mode === 'restart-timeout') {
      const replacementStarts = (await readFile(probe.launchReceipt, 'utf8'))
        .trimEnd()
        .split('\n')
        .map(line => JSON.parse(line))
      expect(replacementStarts, lockOutcome).toEqual([
        { launch: 'configuration', present: false },
        { launch: 'instance', present: false },
      ])
      expect(remaining, lockOutcome).not.toBe(predecessorLock)
      console.info('Profile lock at replacement entry:', { predecessorRetired: true, replacementLockPresent: remaining !== undefined })
    } else expect(remaining, lockOutcome).toBeUndefined()
    expect(JSON.parse(await readFile(join(profile, DSH_PROFILE_MANIFEST), 'utf8'))).toMatchObject({ phalanxAcceptance: 'retained' })
  }
}, 600_000)

it('recovers a real profile write lock across PID reuse and replies after one login with no platform MCP', async () => {
  assertPinnedDshRevision(runtimeSettings)
  if (!runtimeSettings.containerImage || process.platform !== 'linux') throw new Error('Requires rootless Linux DSH')
  root = await mkdtemp(join(tmpdir(), 'member-profile-lock-'))
  const dataRoot = root
  model = await startCommunityModel()
  const overlay = join(root, 'lock-fixture.json')
  await writeFile(overlay, JSON.stringify([{ insert: [{ id: 'profile-lock-fixture', name: join(DSH_CONTAINER_HOME, 'profile-lock-fixture.mjs') }] }]))
  runtime = { ...runtimeSection(root, model.origin, runtimeSettings), patches: [overlay] }
  app = candidateApplication({
    listen: { host: '127.0.0.1', port: 0 },
    sessionSecret: 'member-profile-lock-fixture-secret',
    idleReclaimSeconds: 0,
    runtime,
    modelGateway: { upstreamApiKey: 'community-provider-fixture-key' },
  })
  const accounts = await openTestAccounts(root)
  try {
    await accounts.createFirstAdmin({ username: 'admin', email: '', password: 'password' })
    await accounts.create({ username: 'member', email: '', password: 'password' })
  } finally {
    await accounts.close()
  }
  const origin = await app.start()
  const database = await openTestDatabase(root)
  try {
    const tables = await database.query<{ count: string }>('SELECT count(*) FROM dsh_phalanx.mcp_services')
    expect(tables[0]?.count).toBe('0')
  } finally {
    await database.close()
  }
  const home = join(await memberSpacePath(root, 'member'), 'home')
  await mkdir(home, { recursive: true, mode: 0o700 })
  await writeFile(join(home, 'profile-lock-fixture.mjs'), memberProfileLockModule)
  const manifest = join(dshWebProfilePath(home), DSH_PROFILE_MANIFEST)
  const lock = manifest + '.lock'
  const rootLabel = createHash('sha256').update(dataRoot).digest('hex')
  const podman = runtimeSettings.containerRuntimeCli
  const carrier = async () => {
    const id = (
      await execFileText(podman, [
        'ps',
        '--filter',
        `label=dsh-phalanx.community-root=${rootLabel}`,
        '--filter',
        'label=dsh-phalanx.user=member',
        '--format',
        '{{.ID}}',
      ])
    ).trim()
    expect(id).toMatch(/^[a-f0-9]+$/u)
    return id
  }
  browser = await chromium.launch({ headless: true })
  const oldContext = await newValidationContext(browser, { locale: 'en' })
  const oldPage = await oldContext.newPage()
  await signInCommunity(oldPage, origin, 'member', 'password')
  const observe = async (context: typeof oldContext, hold?: 'force' | 'graceful') => {
    const cookie = await cookieHeader(context, origin)
    const url = communityEntryUrl(origin, cookie) + 'profile-write-lock-fixture' + (hold === 'graceful' ? '?graceful=1' : '')
    const response = await context.request.fetch(url, { method: hold ? 'POST' : 'GET', headers: { origin } })
    expect(response.status(), await response.text()).toBe(200)
    return (await response.json()) as { pid: number; committed?: string }
  }
  const oldId = await carrier()
  const generation = await execFileText(podman, [
    'inspect',
    '--type',
    'container',
    '--format',
    `{{index .Config.Labels "${PROFILE_WRITER_HOME_LABEL}"}}`,
    oldId,
  ])
  expect(generation.trim()).toMatch(/^\d+:\d+:\d+\/[0-9a-f-]{36}$/u)
  const before = await observe(oldContext, 'force')
  expect(before.committed).toBe('retained')
  expect(await readFile(lock, 'utf8')).toBe(String(before.pid) + '\n')
  const killedLock = await lockIdentity(lock)
  expect(killedLock).toBeDefined()
  const committed = await readFile(manifest)
  await execFileText(podman, ['kill', '--signal', 'KILL', oldId])
  await oldContext.close()

  const context = await newValidationContext(browser, { locale: 'en' })
  const page = await context.newPage()
  let loginRequests = 0
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/login') loginRequests++
  })
  await signInCommunity(page, origin, 'member', 'password')
  expect(await carrier()).not.toBe(oldId)
  expect(await observe(context)).toEqual(before)
  // A freshly started replacement carrier may hold its own transient profile writer lock immediately after entry.
  expect(await lockIdentity(lock)).not.toBe(killedLock)
  await expect.poll(() => lockIdentity(lock), { timeout: 15_000 }).toBeUndefined()
  expect(await readFile(manifest)).toEqual(committed)
  const workspace = instanceWorkspacePath(await defaultWorkspacePath(root, 'member'), true)
  await selectCommunityWorkspace(context, page, origin, workspace, true)
  const composer = page.locator('[data-composer-input]')
  await composer.fill('STREAM_MODEL_TASK: reply with the marker.')
  await composer.press('Enter')
  await page.getByText('COMMUNITY_', { exact: true }).waitFor({ timeout: 60_000 })
  model.release()
  await page.locator('p').filter({ hasText: 'COMMUNITY_MODEL_READY' }).first().waitFor({ timeout: 60_000 })
  expect(loginRequests).toBe(1)

  const graceful = await observe(context, 'graceful')
  expect(await readFile(lock, 'utf8')).toBe(String(graceful.pid) + '\n')
  const gracefulLock = await lockIdentity(lock)
  expect(gracefulLock).toBeDefined()
  const restart = await context.request.post(origin + '/recovery/restart', { headers: { origin }, data: { confirmed: true }, timeout: 300_000 })
  expect(restart.status()).toBe(200)
  expect(await readFile(join(dshWebProfilePath(home), 'graceful-lock-fixture'), 'utf8')).toBe('released')
  expect(await lockIdentity(lock)).not.toBe(gracefulLock)
  await expect.poll(() => lockIdentity(lock), { timeout: 15_000 }).toBeUndefined()
}, 600_000)
