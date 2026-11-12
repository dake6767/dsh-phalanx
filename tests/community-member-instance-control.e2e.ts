// Validation: T2; real credentials: none; actual Linux rootless DSH and administrator browser operations.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser } from 'playwright'
import { afterEach, expect, it } from 'vitest'
import { execFileText } from '../src/adapters/runtime-command.js'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import type { CommunityRuntimeConfig } from '../src/domain/community-config.js'
import { DSH_PATCH_CONFIG, dshWebProfilePath } from '../src/dsh/profile-layout.js'
import type { CommunityApplication } from '../src/ports/community-application.js'
import { newValidationContext, saveBrowserEvidence } from './fixtures/browser-evidence.js'
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
