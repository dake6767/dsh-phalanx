// Validation: T2; real credentials: none; actual installed Linux DSH, preset declarations, settings and Client slots.
import { memberSpacePath } from './support/real-dsh-runtime.js'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser } from 'playwright'
import { expect, it } from 'vitest'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import { FileExecutionArtifacts } from '../src/adapters/execution-artifacts.js'
import { FileSkillArtifacts } from '../src/adapters/skill-artifacts.js'
import type { CommunityApplication } from '../src/ports/community-application.js'
import type { CommunityRuntimeConfig } from '../src/domain/community-config.js'
import { openNativeSettings, selectCommunityWorkspace, signInCommunity } from './fixtures/community-native-browser.js'
import { cleanupOwned, removeCommunityFixture } from './fixtures/owned-cleanup.js'
import { candidateApplication } from './support/candidate-application.js'
import { selectBuiltinDatabase } from './support/community-bootstrap-browser.js'
import { communityEntryUrl } from './support/community-space.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { streamText } from './support/real-dsh-model.js'
import { cookieHeader, createBrowserDshRpc } from './support/real-dsh-rpc.js'
import { assertPinnedDshRevision, CONTAINER_HOME, runtimeSection } from './support/real-dsh-runtime.js'

it('restricts builtin presets at restart, repairs only disabled defaults, retains cold history and restores Creator without affecting experts', async () => {
  if (process.platform !== 'linux' || process.getuid?.() === 0 || !runtimeSettings.containerImage || !process.env.DSH_PHALANX_INSTALL_ROOT)
    throw new Error('Actual rootless installed Linux DSH is required')
  assertPinnedDshRevision(runtimeSettings)
  const root = await mkdtemp(join(tmpdir(), 'native-presets-'))
  const modelRequests: Record<string, unknown>[] = []
  let fetchProbeHits = 0,
    mcpProbeCalls = 0
  const model = createServer(async (request, response) => {
    if (request.url === '/fetch-policy-probe') {
      fetchProbeHits++
      response.end('UNEXPECTED_FETCH')
      return
    }
    if (request.url?.startsWith('/mcp-policy-')) {
      if (request.method !== 'POST') {
        response.writeHead(request.method === 'DELETE' ? 204 : 405).end()
        return
      }
      let raw = ''
      for await (const chunk of request) raw += chunk
      let body
      try {
        body = JSON.parse(raw)
      } catch {
        response.writeHead(400).end()
        return
      }
      if (body.id === undefined) {
        response.writeHead(202)
        response.end()
        return
      }
      if (body.method === 'tools/call') mcpProbeCalls++
      const result =
        body.method === 'initialize'
          ? { protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'admission', version: '1' } }
          : body.method === 'tools/list'
            ? { tools: [{ name: 'probe', description: 'Admission probe', inputSchema: { type: 'object', properties: {} } }] }
            : { content: [{ type: 'text', text: 'UNEXPECTED_OLD_MCP_CALL' }] }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }))
      return
    }
    let raw = ''
    for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw) as Record<string, unknown>
    // Native presets can append synthetic skill catalog messages after the
    // human prompt. Select this exact fixture task rather than the last user role.
    const messages = Array.isArray(body.messages) ? body.messages : []
    if (
      messages.some(
        (message: { role?: string; content?: unknown }) =>
          message.role === 'user' &&
          (message.content === 'BUILTIN_HISTORY_REQUEST' ||
            (Array.isArray(message.content) &&
              message.content.some((block: { type?: string; text?: string }) => block.type === 'text' && block.text === 'BUILTIN_HISTORY_REQUEST'))),
      )
    )
      modelRequests.push(body)
    response.setHeader('content-type', 'text/event-stream')
    streamText(response, 'BUILTIN_HISTORY_RESPONSE')
  })
  let browser: Browser | undefined
  let app: CommunityApplication | undefined
  let runtime: CommunityRuntimeConfig | undefined
  try {
    model.listen(0, '127.0.0.1')
    await once(model, 'listening')
    const modelOrigin = `http://127.0.0.1:${(model.address() as { port: number }).port}`
    const overlay = join(root, 'observer.json')
    await writeFile(overlay, JSON.stringify([{ insert: [{ id: 'preset-observer', name: CONTAINER_HOME + '/preset-fixture/index.mjs' }] }]))
    runtime = { ...runtimeSection(root, modelOrigin, runtimeSettings), patches: [overlay] }
    app = candidateApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'native-preset-fixture-secret-at-least-32', runtime })
    const origin = await app.start()
    browser = await chromium.launch({ headless: true })
    const admin = await browser.newPage({ locale: 'en' })
    admin.setDefaultTimeout(30000)
    await admin.goto(`${origin}/bootstrap#credential=${readBootstrapCredential(root)!.credential}`)
    await selectBuiltinDatabase(admin)
    await admin.getByLabel('Username', { exact: true }).fill('admin')
    await admin.getByLabel('Password', { exact: true }).fill('password')
    await admin.getByRole('button', { name: 'Create administrator', exact: true }).click()
    await admin.getByRole('button', { name: /^(Skip for now and finish installation|暂时跳过，完成安装)$/u }).click()
    await admin.waitForURL(origin + '/admin')
    const api = async (path: string, body?: object) => {
      const response = body
        ? await admin.request.post(origin + '/admin/api/' + path, { headers: { origin }, data: body })
        : await admin.request.get(origin + '/admin/api/' + path)
      expect(response.ok(), await response.text()).toBe(true)
      return response.json()
    }
    const models = await api('models', {
      revision: (await api('models')).revision,
      action: 'save-provider',
      provider: {
        name: 'Fixture',
        baseUrl: modelOrigin + '/anthropic',
        apiFormat: 'anthropic-messages',
        apiKey: 'fictional-preset-key',
        enabled: true,
        models: [{ name: 'preset-fixture', enabled: true }],
      },
    })
    await api('models', {
      revision: models.revision,
      action: 'set-default',
      defaultModelId: models.providers.find((row: { name: string }) => row.name === 'Fixture').models[0].id,
    })
    const account = await api('accounts', { username: 'member', password: 'password', email: '' })
    await api('experts', {
      revision: (await api('experts')).revision,
      expert: {
        name: 'Independent expert',
        description: 'Expert remains available',
        icon: 'E',
        persona: 'INDEPENDENT_EXPERT_PERSONA',
        skills: [],
        skillPacks: [],
      },
    })
    const library = await api('experts'),
      expert = library.experts[0],
      expertPreset = 'phalanx-expert-' + expert.id
    await api('experts', { action: 'publish', id: expert.id, published: true, revision: library.revision, confirmed: true })
    const expertPath = `groups/${account.groupId}/experts`
    await api(expertPath, { names: [expert.id], revision: (await api(expertPath)).revision, confirmed: true })
    const home = join(await memberSpacePath(root, 'member'), 'home')
    await mkdir(join(home, 'Documents/deepseek-harness/default-workspace'), { recursive: true, mode: 0o700 })
    const observer = join(home, 'preset-fixture')
    await mkdir(observer, { mode: 0o700 })
    await copyFile('tests/fixtures/native-preset-observer.mjs', join(observer, 'index.mjs'))
    await copyFile('tests/fixtures/native-preset-views.js', join(observer, 'client.js'))
    await writeFile(
      join(observer, 'package.json'),
      JSON.stringify({
        name: '@fixture/native-preset-observer',
        version: '1.0.0',
        type: 'module',
        main: './index.mjs',
        exports: { '.': './index.mjs', './client': './client.js' },
        dsh: { client: { platform: 'web', inject: ['@deepseek-ai/dsh-client-ui-renderer', '@deepseek-ai/dsh-client-ui-conversation'] } },
      }),
    )
    const member = await browser.newContext({ locale: 'en', viewport: { width: 960, height: 900 } })
    const page = await member.newPage()
    page.setDefaultTimeout(30000)
    await signInCommunity(page, origin, 'member', 'password')
    const workspace = CONTAINER_HOME + '/Documents/deepseek-harness/default-workspace'
    await selectCommunityWorkspace(member, page, origin, workspace, true)
    const rpc = createBrowserDshRpc(member)
    const remote = async <T>(method: string, args: object = {}) => rpc.remoteRpc<T>(origin, await cookieHeader(member, origin), method, args)
    const roster = async () => (await remote<{ presets: { id: string; broken?: string; isDefault: boolean }[] }>('agentPresets/list')).presets
    const adopted = await remote<{ workspace: { workspaceId: string } }>('workspace/create', { request: { path: workspace } })
    const workspaceId = adopted.workspace.workspaceId
    const create = (agentPreset?: string) =>
      remote<{ sessionId: string; agentPreset: string }>('session/create', { request: { workspaceId, ...(agentPreset ? { agentPreset } : {}) } })
    const observe = async (operation: string, sessionId: string, ptc = false) => {
      const response = await member.request.post(communityEntryUrl(origin, await cookieHeader(member, origin)) + 'preset-fixture', {
        headers: { origin },
        data: { operation, sessionId, ptc, url: modelOrigin + '/fetch-policy-probe' },
      })
      expect(response.ok(), await response.text()).toBe(true)
      return response.json()
    }
    const describe = async () =>
      (await remote<{ namespaces: { ns: string; value: { selectedDefault?: string }; revision: number }[] }>('settings/describe')).namespaces.find(
        row => row.ns === 'agent-preset-registry',
      )!
    const setDefault = async (selectedDefault: string) =>
      remote('settings/update', { ns: 'agent-preset-registry', patch: { selectedDefault }, expectedRevision: (await describe()).revision })
    const choices = async (disabledIds: string[]) => {
      const path = `groups/${account.groupId}/native-features`,
        state = await api(path)
      await api(path, { revision: state.revision, disabledIds })
    }
    const restart = async () => {
      const response = await member.request.post(origin + '/recovery/restart', { headers: { origin }, data: { confirmed: true }, timeout: 300000 })
      expect(response.status(), await response.text()).toBe(200)
      await page.reload()
      await page.getByRole('button', { name: /^Platform account:/u }).waitFor()
    }
    const showSession = async (sessionId: string) => {
      const sidebar = page.getByRole('button', { name: 'Open sidebar', exact: true })
      if (await sidebar.isVisible()) await sidebar.click()
      const group = page.locator('[role="treeitem"][data-row-key^="workspace:"]').filter({ has: page.getByText('Default workspace', { exact: true }) })
      if ((await group.getAttribute('aria-expanded')) === 'false') await group.click({ timeout: 1000 })
      const row = page.locator(`[data-row-key=${JSON.stringify('session:' + sessionId)}]`)
      // The row's action strip stops propagation; click the title to select this exact history.
      await row.getByText('BUILTIN_HISTORY_RESPONSE', { exact: true }).click()
      const conversation = page.locator(`[data-conversation-content][data-conversation-session=${JSON.stringify(sessionId)}]:visible`)
      await conversation.waitFor()
      // Restoring this session's right panel can collapse the narrow sidebar.
      if (await sidebar.isVisible()) await sidebar.click()
      if ((await group.getAttribute('aria-expanded')) === 'false') await group.click({ timeout: 1000 })
      await expect.poll(() => row.getAttribute('aria-selected')).toBe('true')
      return conversation
    }
    const completeTurn = async (sessionId: string) => {
      const before = modelRequests.length
      await remote('session/prompt', {
        request: { requestId: randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text: 'BUILTIN_HISTORY_REQUEST' }] },
      })
      // The title request uses the same fixture response; only the actual
      // assistant message proves this session's prompted turn has completed.
      await expect
        .poll(
          async () => {
            const snapshot = (await observe('inspect', sessionId)) as { events: { type: string; event: { type: string; data: unknown } }[] }
            return snapshot.events.some(
              record =>
                record.type === 'event' && record.event.type === 'assistant/message' && JSON.stringify(record.event.data).includes('BUILTIN_HISTORY_RESPONSE'),
            )
          },
          { timeout: 60000 },
        )
        .toBe(true)
      expect(modelRequests.length).toBeGreaterThan(before)
      for (const request of modelRequests.slice(before)) {
        expect(request.model).toBe('preset-fixture')
        expect(JSON.stringify(request.system)).toContain('You are a coding agent powered by the preset-fixture model.')
      }
    }
    for (const id of ['standard', 'ptc', 'minimal', 'cordis']) {
      expect((await roster()).find(row => row.id === id)?.broken).toBeUndefined()
      const session = await create(id)
      expect(session.agentPreset).toBe(id)
      const catalog = await observe('catalog', session.sessionId)
      expect(catalog.names).not.toContain('web_fetch')
      if (id !== 'minimal') expect(catalog.names).toContain('web_search')
      const probe = await observe('fetch-guard', session.sessionId, id === 'ptc')
      expect(probe.attempted).toBe(false)
      expect(JSON.stringify(probe.outcome)).toContain('Web fetch is unavailable in this deployment.')
      expect(fetchProbeHits).toBe(0)
      if (id === 'standard' || id === 'cordis') await completeTurn(session.sessionId)
    }
    const admission = await create('standard')
    expect(await observe('writer-lock-resolve', admission.sessionId)).toEqual({ hmrReleasedBeforeWriter: true })
    expect(await observe('cancel-resolve', admission.sessionId)).toEqual({ cancelledWhileBlocked: true, expectedReason: true })
    const service = (endpoint: string) => ({ name: 'p-admission', description: 'Step admission fixture', url: modelOrigin + endpoint })
    await api('mcp', { action: 'save', service: service('/mcp-policy-first') })
    await api(`groups/${account.groupId}/mcp`, { names: ['p-admission'] })
    expect((await observe('capture-tools', admission.sessionId)).names).toContain('mcp__p-admission__probe')
    // A captured step cannot call a newly registered replacement with the same name.
    await api('mcp', { action: 'save', service: service('/mcp-policy-replacement') })
    expect((await observe('refresh-tools', admission.sessionId)).names).toContain('mcp__p-admission__probe')
    expect(await observe('execute-captured', admission.sessionId)).toMatchObject({ isError: true, error: { info: { code: 'UNKNOWN_TOOL' } } })
    expect(mcpProbeCalls).toBe(0)
    expect((await observe('capture-tools', admission.sessionId)).names).toContain('mcp__p-admission__probe')
    await api(`groups/${account.groupId}/mcp`, { names: [] })
    expect((await observe('refresh-tools', admission.sessionId)).names).not.toContain('mcp__p-admission__probe')
    expect(await observe('execute-captured', admission.sessionId)).toMatchObject({ isError: true, error: { info: { code: 'UNKNOWN_TOOL' } } })
    expect(mcpProbeCalls).toBe(0)
    expect((await roster()).some(row => row.id === expertPreset)).toBe(true)
    const history = await create('cordis')
    await completeTurn(history.sessionId)
    await setDefault('standard')
    await choices(['preset-standard', 'preset-cordis'])
    expect((await create('standard')).agentPreset).toBe('standard') // Running configuration remains intact.
    await restart()
    expect((await roster()).map(row => row.id)).not.toContain('standard')
    expect((await roster()).map(row => row.id)).not.toContain('cordis')
    for (const id of ['standard', 'cordis']) await expect(create(id)).rejects.toThrow()
    expect((await describe()).value.selectedDefault).toBe('ptc')
    const active = await create()
    expect(active.agentPreset).toBe('ptc')
    await completeTurn(active.sessionId)
    const cold = await observe('inspect', history.sessionId)
    expect(JSON.stringify(cold)).toContain('BUILTIN_HISTORY_REQUEST')
    expect(JSON.stringify(cold)).toContain('BUILTIN_HISTORY_RESPONSE')
    const unavailable = await observe('resume', history.sessionId)
    expect(unavailable.resumed).toBe(false)
    expect(JSON.stringify(await observe('inspect', history.sessionId))).toContain('BUILTIN_HISTORY_RESPONSE')
    console.log('Disabled builtin history observation:', JSON.stringify({ coldHistoryReadable: true, resume: unavailable }))
    const activeConversation = await showSession(active.sessionId)
    await activeConversation.getByText('BUILTIN_HISTORY_RESPONSE', { exact: true }).waitFor()
    await openNativeSettings(page)
    await page.getByRole('dialog', { name: 'Settings', exact: true }).getByRole('button', { name: 'Agent presets', exact: true }).click()
    await page
      .getByRole('dialog', { name: 'Settings', exact: true })
      .locator(`[data-agent-preset-id=${JSON.stringify(expertPreset)}]`)
      .waitFor()
    expect(await page.getByRole('button', { name: 'Let the agent help me create a preset', exact: true }).count()).toBe(0)
    await page.keyboard.press('Escape')
    const showRightGuide = async (sessionId: string) => {
      const expand = page.locator('[data-sidebar-right-expand]:visible')
      if (await expand.isVisible()) await expand.click()
      const column = page.locator(`[data-sidebar-right-session=${JSON.stringify(sessionId)}][data-sidebar-right-panel][data-sidebar-right-open]`)
      await column.waitFor({ state: 'visible' })
      const files = column.locator('[data-sidebar-right-guide-entry="files"]:visible')
      const start = column.locator('[data-dockkit-tab]:visible').filter({ has: page.getByText('Start', { exact: true }) })
      const add = column.locator('[data-dockkit-add-tab]:visible').first()
      await files.or(start).or(add).first().waitFor()
      if (!(await files.isVisible())) {
        if (await start.isVisible()) await start.click()
        else await add.click()
      }
      await files.waitFor({ state: 'visible' })
    }
    const menus = async (button: string, present: boolean) => {
      await page.getByRole('button', { name: button, exact: true }).click()
      const menu = page.getByRole('menu')
      await menu.getByRole('menuitem', { name: 'Browse other plugins', exact: true }).waitFor()
      expect(await menu.getByRole('menuitem', { name: 'Create your plugin', exact: true }).count()).toBe(present ? 1 : 0)
      await page.keyboard.press('Escape')
      await menu.waitFor({ state: 'detached' })
    }
    await showRightGuide(active.sessionId)
    await menus('More tools', false)
    await menus('More conversation views', false)
    await page.getByRole('button', { name: 'More conversation views', exact: true }).click()
    let menu = page.getByRole('menu')
    await menu.getByRole('menuitem', { name: 'Probe view 7', exact: true }).click()
    await menu.waitFor({ state: 'detached' })
    await page.getByText('PROBE_VIEW_7', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'More conversation views', exact: true }).click()
    menu = page.getByRole('menu')
    expect(await menu.getByRole('menuitem', { name: 'Probe view 7', exact: true }).getAttribute('aria-current')).toBe('page')
    await page.keyboard.press('Escape')
    const globalMore = page.getByRole('navigation', { name: 'Global panels', exact: true }).getByRole('button', { name: 'More', exact: true })
    await globalMore.click()
    menu = page.getByRole('menu')
    expect(await menu.getByRole('menuitem', { name: 'Create your plugin', exact: true }).count()).toBe(0)
    await menu.getByRole('menuitem', { name: 'Browse other plugins', exact: true }).click()
    await menu.waitFor({ state: 'detached' })
    await page.getByRole('heading', { name: 'Plugins', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Choose how to add a plugin', exact: true }).click()
    menu = page.getByRole('menu')
    expect(await menu.getByRole('menuitem', { name: /Let the agent create a plugin/u }).count()).toBe(0)
    await page.keyboard.press('Escape')
    await setDefault(expertPreset)
    await choices(['preset-standard', 'preset-ptc', 'preset-cordis'])
    await restart()
    expect((await describe()).value.selectedDefault).toBe(expertPreset)
    const expertSession = await create()
    expect(expertSession.agentPreset).toBe(expertPreset)
    expect((await observe('catalog', expertSession.sessionId)).names).not.toContain('web_fetch')
    expect((await observe('fetch-guard', expertSession.sessionId)).attempted).toBe(false)
    expect(fetchProbeHits).toBe(0)
    expect(await observe('tool', expertSession.sessionId)).toMatchObject({
      isError: false,
      value: { exitCode: 0, stdout: { text: 'PRESET_EXPERT_TOOL_OK\n' } },
    })
    await setDefault('ptc')
    await restart()
    expect((await create()).agentPreset).toBe('minimal')
    await setDefault('minimal')
    await choices(['preset-standard', 'preset-ptc', 'preset-minimal'])
    await restart()
    expect((await create()).agentPreset).toBe('cordis')
    expect((await roster()).map(row => row.id)).toContain('cordis')
    expect(await observe('resume', history.sessionId)).toMatchObject({ resumed: true })
    expect(JSON.stringify(await observe('inspect', history.sessionId))).toContain('BUILTIN_HISTORY_RESPONSE')
    const historyConversation = await showSession(history.sessionId)
    await historyConversation.getByText('BUILTIN_HISTORY_RESPONSE', { exact: true }).waitFor()
    await menus('More conversation views', true)
    await showRightGuide(history.sessionId)
    await menus('More tools', true)
    await globalMore.click()
    await page.getByRole('menu').getByRole('menuitem', { name: 'Create your plugin', exact: true }).waitFor()
    await page.keyboard.press('Escape')
    await openNativeSettings(page)
    await page.getByRole('dialog', { name: 'Settings', exact: true }).getByRole('button', { name: 'Agent presets', exact: true }).click()
    await page.getByRole('dialog', { name: 'Settings', exact: true }).getByText('Creator mode', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Let the agent help me create a preset', exact: true }).waitFor()
    await page.keyboard.press('Escape')
    await globalMore.click()
    await page.getByRole('menu').getByRole('menuitem', { name: 'Browse other plugins', exact: true }).click()
    await page.getByRole('heading', { name: 'Plugins', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Choose how to add a plugin', exact: true }).click()
    await page
      .getByRole('menu')
      .getByRole('menuitem', { name: /Let the agent create a plugin/u })
      .waitFor()
    await page.keyboard.press('Escape')
    await choices([])
    await setDefault('standard')
    await restart()
    expect((await create()).agentPreset).toBe('standard')
    expect((await roster()).filter(row => ['standard', 'ptc', 'minimal', 'cordis'].includes(row.id))).toHaveLength(4)
    console.log('Native preset business assertions completed')
  } catch (error) {
    console.error('Native preset acceptance body failed:', error)
    for (const context of browser?.contexts() ?? []) {
      for (const current of context.pages()) {
        try {
          console.error(
            'Native preset UI state:',
            JSON.stringify({
              path: new URL(current.url()).pathname,
              treeitems: await current.getByRole('treeitem').allTextContents(),
              tabs: await current.getByRole('tab').allTextContents(),
              conversations: await current
                .locator('[data-conversation-content]:visible')
                .evaluateAll(nodes => nodes.map(node => node.getAttribute('data-conversation-session'))),
            }),
          )
        } catch {
          /* Preserve the original failure if a page has already closed. */
        }
      }
    }
    throw error
  } finally {
    let stopped = false,
      rebuilt = false
    await cleanupOwned(
      async () => browser?.close(),
      async () => {
        await app?.stop()
        stopped = true
      },
      async () => {
        if (runtime) await new CommunityRuntimeDriver(runtime).rebuild()
        rebuilt = true
      },
      async () => {
        if (stopped && rebuilt)
          await cleanupOwned(
            () => new FileSkillArtifacts(join(root, 'skills/artifacts'), []).collect([]),
            () => new FileExecutionArtifacts(join(root, 'execution/artifacts')).collect([]),
            () => removeCommunityFixture(root),
          )
      },
      async () => {
        model.closeAllConnections()
        if (model.listening) await new Promise<void>((resolve, reject) => model.close(error => (error ? reject(error) : resolve())))
      },
    )
  }
}, 600000)
