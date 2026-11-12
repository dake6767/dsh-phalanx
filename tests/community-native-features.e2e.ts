// Validation: T2; real credentials: none; actual Linux rootless DSH through the installed public entry.
import { memberSpacePath } from './support/real-dsh-runtime.js'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser, type BrowserContext } from 'playwright'
import { expect, it } from 'vitest'
import { FileExecutionArtifacts } from '../src/adapters/execution-artifacts.js'
import { FileSkillArtifacts } from '../src/adapters/skill-artifacts.js'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import { execFileText } from '../src/adapters/runtime-command.js'
import { DSH_PATCH_CONFIG, dshWebProfilePath } from '../src/dsh/profile-layout.js'
import { openNativeSettings, runCommunityTerminal, selectCommunityWorkspace, signInCommunity } from './fixtures/community-native-browser.js'
import { cleanupOwned, removeCommunityFixture } from './fixtures/owned-cleanup.js'
import { skillZip } from './fixtures/skills/archive.js'
import { candidateApplication } from './support/candidate-application.js'
import { appCenterButton, appCenterPanel, refreshAppCenter, setAppCenterVisibility } from './support/app-center-visibility.js'
import { nativeFeaturePredecessor } from './fixtures/native-feature-predecessor.js'
import { communityEntryUrl } from './support/community-space.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { cookieHeader, createBrowserDshRpc, rpcBody } from './support/real-dsh-rpc.js'
import { assertPinnedDshRevision, CONTAINER_HOME, runtimeSection } from './support/real-dsh-runtime.js'

it('applies group terminal choices only on restart, preserves agent and platform execution, and treats administrators and moved members alike', async () => {
  if (process.platform !== 'linux' || process.getuid?.() === 0 || !runtimeSettings.containerImage || !process.env.DSH_PHALANX_INSTALL_ROOT)
    throw new Error('Actual rootless Linux DSH is required')
  assertPinnedDshRevision(runtimeSettings)
  const root = await mkdtemp(join(tmpdir(), 'native-features-'))
  const overlay = join(root, 'observer.json')
  const runtime = { ...runtimeSection(root, 'https://example.test', runtimeSettings), patches: [overlay] }
  const app = candidateApplication({ listen: { host: '127.0.0.1', port: 0 }, idleReclaimSeconds: 0, runtime })
  let previous: Awaited<ReturnType<typeof nativeFeaturePredecessor>> | undefined
  let browser: Browser | undefined
  try {
    await writeFile(overlay, JSON.stringify([{ insert: [{ id: 'skills-observer', name: '/dsh-phalanx/home/skills-observer.mjs' }] }]))
    previous = await nativeFeaturePredecessor(root)
    const accounts = previous.accounts
    await accounts.createFirstAdmin({ username: 'admin', password: 'password', email: '' })
    const other = await accounts.createGroup('Other team')
    await accounts.create({ username: 'member', password: 'password', email: '' })
    await accounts.create({ username: 'peer', password: 'password', email: '', groupId: other.id })
    expect(await previous.database.health()).toMatchObject({ schemaVersion: 15 })
    await previous.database.close()
    previous = undefined
    browser = await chromium.launch({ headless: true })
    const origin = await app.start()
    const readiness = await browser.newContext()
    try {
      const response = await readiness.request.get(origin + '/readyz')
      expect(response.status(), await response.text()).toBe(200)
      expect((await readiness.request.get(origin + '/account/platform-features', { maxRedirects: 0 })).status()).toBe(401)
    } finally {
      await readiness.close()
    }
    // Let the real upgrade establish storage ownership before publishing member files.
    for (const username of ['admin', 'member', 'peer']) {
      const home = join(await memberSpacePath(root, username), 'home')
      await mkdir(join(home, 'Documents/deepseek-harness/default-workspace'), { recursive: true, mode: 0o700 })
      await copyFile('tests/fixtures/skill-observer.mjs', join(home, 'skills-observer.mjs'))
    }
    const admin = await browser.newContext({ locale: 'en' }),
      member = await browser.newContext({ locale: 'en' }),
      peer = await browser.newContext({ locale: 'en' })
    const adminPage = await admin.newPage(),
      page = await member.newPage(),
      peerPage = await peer.newPage()
    for (const current of [adminPage, page, peerPage]) current.setDefaultTimeout(30000)
    await signInCommunity(adminPage, origin, 'admin', 'password', true)
    const api = async (path: string, body?: object) => {
      const response = body
        ? await admin.request.post(`${origin}/admin/api/${path}`, { headers: { origin }, data: body })
        : await admin.request.get(`${origin}/admin/api/${path}`)
      expect(response.ok(), await response.text()).toBe(true)
      return response.json()
    }
    for (const id of ['admin', 'default', other.id]) {
      const state = await api(`groups/${id}/native-features`)
      expect(state.features.every((feature: { enabled: boolean }) => feature.enabled)).toBe(true)
      expect(state.showAppCenter).toBe(false)
    }
    await api('groups', { action: 'create', name: 'New team' })
    const newGroup = (await api('groups')).find((group: { name: string }) => group.name === 'New team')
    expect((await api(`groups/${newGroup.id}/native-features`)).showAppCenter).toBe(false)
    const select = async (id: string, disabledIds: string[]) => {
      const state = await api(`groups/${id}/native-features`)
      await api(`groups/${id}/native-features`, { revision: state.revision, disabledIds })
    }
    const observe = async (context: BrowserContext, body: object) => {
      const cookie = await cookieHeader(context, origin)
      const response = await context.request.post(communityEntryUrl(origin, cookie) + 'skills-fixture', { headers: { origin }, data: body })
      expect(response.status(), await response.text()).toBe(200)
      return response.json()
    }
    const terminal = async (context: BrowserContext, enabled: boolean, language: 'en' | 'zh' = 'en') => {
      const { sessionId } = await observe(context, { operation: 'create' })
      const cookie = await cookieHeader(context, origin)
      const inventory = await createBrowserDshRpc(context).remoteRpc<{ moduleName: string; enabled: boolean; fiberPhase: string | null }[]>(
        origin,
        cookie,
        'pluginManager/listPlugins',
        {},
      )
      for (const moduleName of ['@deepseek-ai/dsh-api-terminal-controller', '@deepseek-ai/dsh-client-ui-sidebar-terminal']) {
        const rows = inventory.filter(row => row.moduleName === moduleName)
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({ enabled, fiberPhase: enabled ? 'active' : null })
      }
      const response = await context.request.post(communityEntryUrl(origin, cookie) + 'api/terminal/create', {
        headers: { origin, 'content-type': 'application/json', 'accept-language': 'en-US' },
        data: rpcBody('terminal/create', { agentId: sessionId, request: { id: 'native-feature-probe', cols: 80, rows: 24 } }),
      })
      expect(response.status(), await response.text()).toBe(200)
      const body = await response.json()
      if (enabled) {
        expect(body.result).toMatchObject({ ok: true, value: { id: 'native-feature-probe' } })
        await createBrowserDshRpc(context).remoteRpc(origin, cookie, 'terminal/close', { agentId: sessionId, id: 'native-feature-probe' })
      } else {
        expect(body.result).toMatchObject({
          ok: false,
          error: {
            code: 'remote-access/denied',
            message:
              language === 'zh'
                ? '此分组未开放手动终端。Agent 执行命令和平台代执行仍可使用。'
                : 'Manual terminal access is unavailable for this group. Agent commands and platform execution remain available.',
          },
        })
        console.log('Disabled terminal public response:', JSON.stringify({ status: response.status(), result: body.result }))
      }
    }
    await signInCommunity(page, origin, 'member', 'password')
    await refreshAppCenter(page, false)
    const memberCarrier = async () =>
      (
        await execFileText(runtimeSettings.containerRuntimeCli, [
          'ps',
          '--filter',
          `label=dsh-phalanx.community-root=${createHash('sha256').update(root).digest('hex')}`,
          '--filter',
          'label=dsh-phalanx.user=member',
          '--format',
          '{{.ID}}',
        ])
      ).trim()
    const running = await memberCarrier()
    expect(running).toMatch(/^[a-f0-9]+$/u)
    await adminPage.getByRole('link', { name: 'Group management', exact: true }).click()
    await adminPage.getByRole('row').filter({ hasText: 'Default group' }).getByRole('button', { name: 'Details', exact: true }).click()
    const dialog = adminPage.getByRole('dialog', { name: 'Default group', exact: true })
    await dialog.getByRole('tab', { name: 'Feature settings', exact: true }).click()
    await dialog.getByText('Show Platform App Center', { exact: true }).click()
    await dialog.getByRole('button', { name: 'Save changes', exact: true }).click()
    await dialog.getByText('Feature settings saved.', { exact: true }).waitFor()
    await dialog.getByRole('button', { name: 'Close group details', exact: true }).filter({ hasText: 'Close group details' }).click()
    expect(await appCenterButton(page).count()).toBe(0)
    await refreshAppCenter(page, true)
    await appCenterButton(page).click()
    await appCenterPanel(page).waitFor()
    expect(await memberCarrier()).toBe(running)
    const settingsPath = '**/account/platform-features'
    await page.route(settingsPath, route => route.fulfill({ status: 503, json: { error: 'Fixture feature settings unavailable' } }))
    const unavailable = page.waitForResponse(response => new URL(response.url()).pathname === '/account/platform-features')
    await page.reload()
    expect((await unavailable).status()).toBe(503)
    await page.getByRole('button', { name: /^Platform account:/u }).waitFor()
    expect(await appCenterButton(page).count()).toBe(0)
    expect(await appCenterPanel(page).count()).toBe(0)
    expect(await memberCarrier()).toBe(running)
    await page.unroute(settingsPath)
    await refreshAppCenter(page, true)
    await terminal(member, true)
    await select('default', ['terminal'])
    await terminal(member, true) // Saving does not change the running instance.
    const home = join(await memberSpacePath(root, 'member'), 'home')
    await writeFile(
      join(dshWebProfilePath(home), DSH_PATCH_CONFIG),
      JSON.stringify([
        { id: 'terminal-controller', disabled: false },
        { id: 'ui-sidebar-terminal', disabled: false },
        { id: 'plugin-market', disabled: false },
        { id: 'ui-plugin-market', disabled: false },
      ]),
    )
    const restart = async (context: BrowserContext) => {
      const response = await context.request.post(origin + '/recovery/restart', { headers: { origin }, data: { confirmed: true }, timeout: 300000 })
      expect(response.status(), await response.text()).toBe(200)
    }
    await restart(member)
    await page.reload()
    await page.getByRole('button', { name: /^Platform account:/u }).waitFor()
    await selectCommunityWorkspace(member, page, origin, CONTAINER_HOME + '/Documents/deepseek-harness/default-workspace', true)
    await terminal(member, false)
    const memberRpc = createBrowserDshRpc(member)
    const nativePreference = async () => {
      const state = await memberRpc.remoteRpc<{ namespaces: { ns: string; value: { preference?: string } }[] }>(
        origin,
        await cookieHeader(member, origin),
        'settings/describe',
        {},
      )
      return state.namespaces.find(row => row.ns === 'locale')?.value.preference
    }
    await openNativeSettings(page)
    await page.getByRole('button', { name: 'English', exact: true }).click()
    await page.getByRole('menuitem', { name: '中文', exact: true }).click()
    await page.keyboard.press('Escape')
    await expect.poll(nativePreference).toBe('zh')
    await terminal(member, false, 'zh')
    await openNativeSettings(page, 'zh')
    await page.getByRole('button', { name: '中文', exact: true }).click()
    await page.getByRole('menuitem', { name: 'English', exact: true }).click()
    await page.keyboard.press('Escape')
    await expect.poll(nativePreference).toBe('en')
    await terminal(member, false)
    const expand = page.locator('[data-sidebar-right-expand]')
    if (await expand.isVisible()) await expand.click()
    await page.locator('[data-dockkit-add-tab]:visible').first().click()
    await page.locator('[data-sidebar-right-guide-entry="files"]').waitFor()
    expect(await page.locator('[data-sidebar-right-guide-entry="terminal"]').count()).toBe(0)
    const bundles = await createBrowserDshRpc(member).remoteRpc<{ name: string }[]>(origin, await cookieHeader(member, origin), 'pluginManager/listBundles', {})
    expect(bundles.some(bundle => bundle.name === '@deepseek-ai/dsh-experimental-plugin-market-bundle')).toBe(false)
    const { sessionId } = await observe(member, { operation: 'create' })
    const bash = async (command: string) =>
      (
        await observe(member, {
          operation: 'tool',
          sessionId,
          name: 'bash',
          args: { command, description: 'Verify execution while manual terminal is disabled', timeoutMs: 30000 },
        })
      ).value
    const upload = await admin.request.post(origin + '/admin/api/skills/upload', {
      headers: { origin, 'content-type': 'application/zip' },
      data: skillZip([
        { path: 'SKILL.md', content: '---\nname: native-execution\ndescription: Native feature execution fixture\n---\nRun the probe.' },
        {
          path: 'scripts/probe.py',
          content: 'import os\nassert os.environ.get("NATIVE_FEATURE_EXECUTION") == "platform-fixture"\nprint("NATIVE_PLATFORM_EXECUTION_OK")\n',
        },
      ]),
    })
    expect(upload.status(), await upload.text()).toBe(200)
    const preview = await upload.json()
    await api('skills/change', { action: 'confirm', token: preview.token, revision: preview.revision })
    const grants = await api('groups/default/skills')
    await api('groups/default/skills', { action: 'save', names: ['native-execution'], revision: grants.revision, confirmed: true })
    await api('skills/execution?name=native-execution', {
      enabled: true,
      commands: [{ command: 'scripts/probe.py', blocked: [] }],
      runtimeDependencies: [],
      variables: [{ name: 'NATIVE_FEATURE_EXECUTION', value: 'platform-fixture', secret: false }],
    })
    await expect.poll(async () => (await api('skills/execution?name=native-execution')).preparation?.stage).toBe('ready')
    await setAppCenterVisibility(admin.request, origin, 'default', false)
    await refreshAppCenter(page, false)
    expect(await bash('test -z "${NATIVE_FEATURE_EXECUTION-}" && printf \'NATIVE_AGENT_SHELL_OK\\n\'')).toMatchObject({
      exitCode: 0,
      stdout: { text: 'NATIVE_AGENT_SHELL_OK\n' },
    })
    expect(await bash('python3 /dsh-phalanx/member-skills/live/native-execution/scripts/probe.py')).toMatchObject({
      exitCode: 0,
      stdout: { text: 'NATIVE_PLATFORM_EXECUTION_OK\n' },
    })
    await setAppCenterVisibility(admin.request, origin)
    await refreshAppCenter(page, true)
    await signInCommunity(peerPage, origin, 'peer', 'password')
    await refreshAppCenter(peerPage, false)
    await terminal(peer, true)
    await selectCommunityWorkspace(peer, peerPage, origin, CONTAINER_HOME + '/Documents/deepseek-harness/default-workspace', true)
    await runCommunityTerminal(peerPage, "printf 'PEER_TERMINAL_%s\\n' OK", 'PEER_TERMINAL_OK')
    await select('admin', ['terminal'])
    const [adminDsh] = await Promise.all([admin.waitForEvent('page'), adminPage.getByRole('link', { name: 'Open admin’s DSH', exact: true }).click()])
    await adminDsh.waitForURL(url => /^\/app\/[^/]+\/$/u.test(url.pathname))
    await adminDsh.getByRole('button', { name: /^Platform account:/u }).waitFor()
    await refreshAppCenter(adminDsh, false)
    await adminDsh.close()
    await terminal(admin, false)
    const memberAccount = (await api('accounts')).items.find((account: { username: string }) => account.username === 'member')
    const beforeMove = await memberCarrier()
    await appCenterButton(page).click()
    await appCenterPanel(page).waitFor()
    await api('accounts/member/actions', { action: 'set-email', email: memberAccount.email, groupId: other.id })
    await appCenterPanel(page).waitFor()
    await refreshAppCenter(page, false)
    expect(await memberCarrier()).toBe(beforeMove)
    await setAppCenterVisibility(admin.request, origin, other.id)
    await refreshAppCenter(page, true)
    expect(await memberCarrier()).toBe(beforeMove)
    await terminal(member, false)
    await restart(member)
    await terminal(member, true)
    console.log('Native feature business assertions completed')
  } catch (error) {
    console.error('Native feature acceptance body failed:', error)
    throw error
  } finally {
    let stopped = false,
      rebuilt = false
    await cleanupOwned(
      async () => previous?.database.close(),
      async () => browser?.close(),
      async () => {
        await app.stop()
        stopped = true
      },
      async () => {
        await new CommunityRuntimeDriver(runtime).rebuild()
        rebuilt = true
      },
      async () => {
        if (stopped && rebuilt) {
          await cleanupOwned(
            () => new FileSkillArtifacts(join(root, 'skills/artifacts'), []).collect([]),
            () => new FileExecutionArtifacts(join(root, 'execution/artifacts')).collect([]),
            () => removeCommunityFixture(root),
          )
        }
      },
    )
  }
}, 600000)
