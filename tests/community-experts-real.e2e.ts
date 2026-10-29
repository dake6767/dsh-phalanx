// Validation: T4 only; real credentials: required (DeepSeek, AnySearch, MiniMax and Amap). Never selected by T2.
import { createHash, randomUUID } from 'node:crypto'
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { expect, it } from 'vitest'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import { execFileText } from '../src/adapters/runtime-command.js'
import { effectiveUserDataRoot } from '../src/domain/storage-layout.js'
import type { UsageRecord } from '../src/domain/usage-record.js'
import { sendCommunityPrompt, signInCommunity } from './fixtures/community-native-browser.js'
import { packRealExpertSearch, realExpertSearchPackage, realExpertSearchTool } from './fixtures/expert-real-search.js'
import { removeCommunityFixture } from './fixtures/owned-cleanup.js'
import { candidateApplication } from './support/candidate-application.js'
import { communityEntryUrl } from './support/community-space.js'
import { startContributionModel } from './support/real-contribution-model.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { cookieHeader, createBrowserDshRpc } from './support/real-dsh-rpc.js'
import { assertPinnedDshRevision, defaultWorkspacePath, runtimeSection } from './support/real-dsh-runtime.js'
import { memberExposesMcpCredentials, readPrivateMcpCredential } from './support/real-mcp-credentials.js'

interface ModelBlock {
  type: string
  id?: string
  name?: string
  tool_use_id?: string
  input?: { command?: string }
  content?: unknown
  text?: string
  is_error?: boolean
}
interface ModelRequest {
  model?: string
  messages?: { role: string; content: string | ModelBlock[] }[]
  tools?: { name: string }[]
}

it('uses one summoned expert with a real shared model, plugin upstream, delegated skill and catalog MCP, then withdraws access', async () => {
  const required = (name: string) => {
    const value = process.env[name]
    if (!value) throw Error('Missing private expert acceptance input: ' + name)
    return value
  }
  expect(process.platform).toBe('linux')
  expect(runtimeSettings.containerImage).toBeTruthy()
  required('DSH_PHALANX_INSTALL_ROOT')
  required('DSH_PHALANX_CANDIDATE_SHA')
  assertPinnedDshRevision(runtimeSettings)
  const search = JSON.parse(await readFile(required('DSH_PHALANX_ACCEPTANCE_INPUT'), 'utf8')) as { modelApiKey: string; searchApiKey: string }
  const suite = JSON.parse(await readFile(required('DSH_PHALANX_SUITE_INPUT'), 'utf8')) as { minimaxApiKey: string }
  const amap = await readPrivateMcpCredential(required('DSH_PHALANX_AMAP_API_KEY_FILE'))
  const secrets = [search.modelApiKey, search.searchApiKey, suite.minimaxApiKey, amap]
  expect(secrets.every(value => typeof value === 'string' && value.length > 0)).toBe(true)
  const safe = (value: string) => secrets.reduce((text, key) => text.replaceAll(key, '[redacted]').replaceAll(encodeURIComponent(key), '[redacted]'), value)
  const evidence = required('DSH_PHALANX_E2E_EVIDENCE_DIR')
  await mkdir(evidence, { recursive: true, mode: 0o700 })
  const receipt = async (name: string, value: object) =>
    writeFile(join(evidence, 'expert-' + name + '.json'), safe(JSON.stringify(value, null, 2)) + '\n', { mode: 0o600 })
  const root = await mkdtemp(join(tmpdir(), 'real-expert-combination-')),
    home = join(effectiveUserDataRoot({ dataRoot: root }), 'member/home')
  let phase = 'prepare',
    exposed = false,
    passed = false,
    pluginCalled = false,
    mcpCalled = false,
    imageCommand = false,
    expertContext = false
  let expectedMode = 'standard'
  const standardTools = new Set<string>(),
    expertTools = new Set<string>(),
    observed = new Set<string>(),
    models = new Set<string>()
  const observeModel = (value: unknown, bytes: Buffer) => {
    const raw = bytes.toString('utf8'),
      body = value as ModelRequest
    exposed ||= secrets.some(key => raw.includes(key))
    const names = (body.tools ?? []).map(tool => tool.name)
    if (expectedMode === 'standard') names.forEach(name => standardTools.add(name))
    else if (names.length) {
      names.forEach(name => expertTools.add(name))
      if (body.model) models.add(body.model)
      expertContext ||= raw.includes('REAL_COMMERCE_EXPERT_PERSONA')
    }
    const calls = new Map<string, ModelBlock>()
    for (const message of body.messages ?? [])
      if (message.role === 'assistant' && Array.isArray(message.content))
        for (const block of message.content) if (block.type === 'tool_use' && block.id) calls.set(block.id, block)
    for (const message of body.messages ?? [])
      if (message.role === 'user' && Array.isArray(message.content))
        for (const block of message.content) {
          if (block.type !== 'tool_result' || !block.tool_use_id || observed.has(block.tool_use_id)) continue
          const call = calls.get(block.tool_use_id)
          if (!call) continue
          observed.add(block.tool_use_id)
          const result = JSON.stringify(block.content)
          if (!block.is_error && call.name === realExpertSearchTool)
            pluginCalled ||= result.includes('ANYSEARCH_DOMAINS_READY') && result.includes('upstreamStatus') && result.includes('200')
          if (!block.is_error && call.name === 'mcp__p-amap__maps_weather') mcpCalled ||= /北京/u.test(result) && /weather|天气|temperature|温度/u.test(result)
          if (!block.is_error && call.name === 'bash')
            imageCommand ||=
              /\bmmx\b/u.test(call.input?.command ?? '') && /image/u.test(call.input?.command ?? '') && !/\[exit code:|\[timed out|\[killed by/u.test(result)
        }
  }
  let model: Awaited<ReturnType<typeof startContributionModel>> | undefined, runtime: ReturnType<typeof runtimeSection> | undefined
  let app: ReturnType<typeof candidateApplication> | undefined, browser: Browser | undefined, admin: Page, member: Page
  let origin = '',
    primaryFailure: unknown,
    imageHash = '',
    expertId = ''
  const cleanupErrors: unknown[] = []
  const stage = async (name: string) => {
    phase = name
    await receipt('stage', { phase })
    console.info('Expert acceptance:', phase)
  }
  const api = async (path: string, input?: object) => {
    const response = input
      ? await admin.request.post(origin + '/admin/api/' + path, { headers: { origin }, data: input, timeout: 180000 })
      : await admin.request.get(origin + '/admin/api/' + path)
    expect(response.status(), 'Admin operation ' + path).toBeLessThan(300)
    return response.json()
  }
  const owner = createHash('sha256').update(root).digest('hex')
  const carrier = async () => {
    const rows = (
      await execFileText(runtimeSettings.containerRuntimeCli, [
        'ps',
        '--filter',
        'label=dsh-phalanx.community-root=' + owner,
        '--filter',
        'label=dsh-phalanx.user=member',
        '--format',
        '{{.Names}}',
      ])
    )
      .trim()
      .split('\n')
      .filter(Boolean)
    expect(rows).toHaveLength(1)
    return rows[0]!
  }
  const command = async (code: string) =>
    execFileText(runtimeSettings.containerRuntimeCli, ['exec', await carrier(), 'node', '-e', code], { maxBuffer: 16 * 1024 * 1024 }).catch(async () => {
      throw Error('Member inspection failed; private output suppressed')
    })
  try {
    model = await startContributionModel(search.modelApiKey, observeModel)
    const overlay = join(root, 'observer.json')
    await writeFile(overlay, JSON.stringify([{ insert: [{ id: 'real-expert-observer', name: '/dsh-phalanx/home/observer.mjs' }] }]))
    runtime = runtimeSection(root, model.origin, runtimeSettings)
    runtime.patches.push(overlay)
    app = candidateApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'real-expert-combination-session-secret', runtime }, 120000)
    browser = await chromium.launch({ headless: true })
    admin = await browser.newPage({ locale: 'en' })
    member = await browser.newPage({ locale: 'en' })
    for (const page of [admin, member]) page.setDefaultTimeout(60000)
    origin = await app.start()
    expect(
      (
        await admin.request.post(origin + '/bootstrap', {
          headers: { origin },
          form: { credential: readBootstrapCredential(root)!.credential, username: 'admin', password: 'password' },
          maxRedirects: 0,
        })
      ).status(),
    ).toBe(303)
    const settings = await api('models')
    const configured = await api('models', {
      action: 'save-provider',
      revision: settings.revision,
      provider: {
        name: 'Expert DeepSeek',
        baseUrl: model.origin + '/anthropic',
        apiFormat: 'anthropic-messages',
        apiKey: search.modelApiKey,
        enabled: true,
        models: [{ name: 'deepseek-chat', enabled: true }],
      },
    })
    const provider = configured.providers.find((row: { name: string }) => row.name === 'Expert DeepSeek')
    const account = await api('accounts', { username: 'member', password: 'password', email: '' })
    await mkdir(home, { recursive: true, mode: 0o700 })
    await copyFile('tests/fixtures/skill-observer.mjs', join(home, 'observer.mjs'))
    await stage('libraries')
    const archive = await packRealExpertSearch(root)
    expect(
      (
        await admin.request.post(origin + '/admin/api/plugins/upload', {
          headers: { origin, 'content-type': 'application/gzip', 'x-plugin-filename': 'expert-search.tgz' },
          data: await readFile(archive),
        })
      ).status(),
    ).toBe(202)
    await expect
      .poll(async () => (await api('plugins')).find((row: { packageName: string }) => row.packageName === realExpertSearchPackage)?.stage, {
        timeout: 300000,
        interval: 2000,
      })
      .toMatch(/^(available|failed)$/u)
    expect((await api('plugins')).find((row: { packageName: string }) => row.packageName === realExpertSearchPackage)?.stage).toBe('available')
    const query = '?packageName=' + encodeURIComponent(realExpertSearchPackage)
    await api('plugins/upstreams' + query, {
      action: 'save',
      upstream: {
        name: 'search',
        baseUrl: 'https://api.anysearch.com',
        credential: search.searchApiKey,
        headers: [{ name: 'Authorization', value: 'Bearer {credential}' }],
      },
    })
    await api('plugins/access' + query, {
      environment: [],
      entriesYaml: JSON.stringify({ search: { endpoint: '{upstream:search}', apiKey: '{access-token}' } }),
    })
    await api('suites')
    await api('suites', {
      action: 'install',
      input: { id: 'minimax', requestId: randomUUID(), groups: [], publish: false, credentials: { MINIMAX_API_KEY: suite.minimaxApiKey } },
    })
    await expect
      .poll(async () => (await api('suites')).installations.find((row: { id: string }) => row.id === 'minimax')?.status, { timeout: 1800000, interval: 2000 })
      .toMatch(/^(installed|failed)$/u)
    const suites = await api('suites')
    await receipt('suite-installation', {
      source: suites.source,
      entry: suites.entries.find((row: { id: string }) => row.id === 'minimax'),
      installation: suites.installations.find((row: { id: string }) => row.id === 'minimax'),
    })
    expect(suites.installations.find((row: { id: string }) => row.id === 'minimax')).toMatchObject({ status: 'installed', version: '2.0.0' })
    await api('mcp/catalog', { action: 'import', input: { presetId: 'amap', name: 'p-amap', credential: amap, requestId: randomUUID() } })
    await expect
      .poll(async () => (await api('mcp')).find((row: { name: string }) => row.name === 'p-amap')?.catalog?.status, { timeout: 660000, interval: 2000 })
      .toMatch(/^(ready|failed)$/u)
    expect((await api('mcp')).find((row: { name: string }) => row.name === 'p-amap')?.catalog).toMatchObject({ id: 'amap', version: '1', status: 'ready' })
    expect((await api('mcp/test', { name: 'p-amap' })).testStatus).toBe('passed')
    await signInCommunity(member, origin, 'member', 'password')
    const cookie = await cookieHeader(member.context(), origin),
      rpc = createBrowserDshRpc(member.context())
    const workspace = await rpc.remoteRpc<{ workspace: { workspaceId: string } }>(origin, cookie, 'workspace/initializeDefault', {})
    const standard = await rpc.remoteRpc<{ sessionId: string }>(origin, cookie, 'session/create', {
      request: { workspaceId: workspace.workspace.workspaceId, agentPreset: 'standard' },
    })
    await rpc.remoteRpc(origin, cookie, 'session/prompt', {
      request: { requestId: randomUUID(), sessionId: standard.sessionId, mode: 'queue', content: [{ type: 'text', text: 'Reply READY. Do not use tools.' }] },
    })
    await expect.poll(() => standardTools.size, { timeout: 120000 }).toBeGreaterThan(0)
    await expect
      .poll(
        async () =>
          (await rpc.remoteRpc<{ items: { sessionId: string; running: boolean }[] }>(origin, cookie, 'session/list', { _request: {} })).items.find(
            row => row.sessionId === standard.sessionId,
          )?.running,
        { timeout: 180000 },
      )
      .toBe(false)
    expect(standardTools.has(realExpertSearchTool)).toBe(false)
    expect([...standardTools].some(name => name.startsWith('mcp__p-amap__'))).toBe(false)
    expect((await api('groups/' + account.groupId + '/plugins')).plugins.some((row: { granted: boolean }) => row.granted)).toBe(false)
    expect((await api('groups/' + account.groupId + '/mcp')).services.some((row: { granted: boolean }) => row.granted)).toBe(false)
    const grants = await api('groups/' + account.groupId + '/skills')
    expect(grants.skills.some((row: { granted: boolean }) => row.granted) || (grants.packs ?? []).some((row: { granted: boolean }) => row.granted)).toBe(false)
    await stage('publish-summon')
    await admin.goto(origin + '/admin/experts?locale=en')
    await admin.getByRole('button', { name: 'Create expert', exact: true }).click()
    await admin.getByLabel('Expert name', { exact: true }).fill('Commerce marketing expert')
    await admin.getByLabel('Expert description', { exact: true }).fill('Research domains, check weather and create a campaign image.')
    await admin
      .getByLabel('Expert persona', { exact: true })
      .fill(
        'REAL_COMMERCE_EXPERT_PERSONA. You plan a product campaign using the supplied research, weather and image tools. Use the supplied mmx skill and platform execution; credentials are already configured.',
      )
    await admin.getByRole('button', { name: /Expert model/u }).click()
    await admin.getByRole('option', { name: 'Expert DeepSeek / deepseek-chat', exact: true }).click()
    for (const name of [realExpertSearchPackage, 'minimax', 'p-amap']) await admin.getByRole('dialog').getByText(name, { exact: true }).first().click()
    await admin.getByRole('button', { name: 'Save expert', exact: true }).click()
    await admin.getByRole('dialog').waitFor({ state: 'hidden' })
    expertId = (await api('experts')).experts[0].id
    expect((await api('experts')).experts[0]).toMatchObject({
      model: { providerId: provider.id, name: 'deepseek-chat' },
      plugins: [realExpertSearchPackage],
      skillPacks: ['minimax'],
      mcp: ['p-amap'],
    })
    await admin.getByRole('button', { name: 'Publish expert Commerce marketing expert', exact: true }).click()
    await admin.getByRole('button', { name: 'Unpublish expert Commerce marketing expert', exact: true }).waitFor()
    const openMarket = async () => {
      await member.getByRole('button', { name: 'Platform App Center', exact: true }).click()
      await member.getByRole('tab', { name: 'Experts', exact: true }).click()
    }
    await openMarket()
    await member.getByRole('button', { name: 'Reload experts', exact: true }).click()
    await member.getByRole('button', { name: 'Summon expert', exact: true }).click()
    await member.getByRole('button', { name: 'Dismiss expert', exact: true }).waitFor()
    expect((await member.request.post(origin + '/recovery/restart', { headers: { origin }, data: { confirmed: true } })).status()).toBe(200)
    await member.reload()
    await openMarket()
    await member.getByRole('button', { name: 'Start conversation', exact: true }).click()
    await expect.poll(() => member.locator('[data-composer-input]').getAttribute('contenteditable'), { timeout: 120000 }).toBe('true')
    await member.getByRole('button', { name: /Expert DeepSeek \/ deepseek-chat/u }).waitFor()
    const sessionId = await member
      .locator('[data-conversation-content]:visible')
      .filter({ has: member.locator('[data-composer-input]') })
      .getAttribute('data-conversation-session')
    expect(sessionId).toBeTruthy()
    expectedMode = 'expert'
    await stage('real-conversation')
    await sendCommunityPrompt(
      member,
      'Use this expert to prepare a small commerce campaign. First call expert_anysearch_domains and report a real catalog fact. Call mcp__p-amap__maps_weather for city 110000 and use the actual Beijing weather. Read the supplied MiniMax/mmx skill, then use its documented mmx image command through the supplied platform execution to generate one square image of a blue circle on white, saving its actual bytes as expert-campaign.png in this workspace and preserving its native encoding. Do not install, authenticate, ask for keys, print environment or credentials, or create a placeholder image. Use all three capabilities, then summarize the campaign.',
    )
    const image = join(defaultWorkspacePath(root, 'member'), 'expert-campaign.png')
    const validImage = async () => {
      try {
        const bytes = await readFile(image)
        return (
          bytes.length > 100 &&
          (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
            bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ||
            (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP'))
        )
      } catch {
        return false
      }
    }
    await expect.poll(async () => pluginCalled && mcpCalled && imageCommand && (await validImage()), { timeout: 900000, interval: 2000 }).toBe(true)
    await expect.poll(() => member.getByRole('button', { name: 'Stop generating', exact: true }).count(), { timeout: 120000 }).toBe(0)
    const records: UsageRecord[] = (await api('usage-records?username=member&capability=skill:mmx-cli')).items
    expect(records.some(row => row.capability.kind === 'execution' && row.capability.operation === 'mmx' && row.exitCode === 0)).toBe(true)
    expect(expertTools.has(realExpertSearchTool) && expertTools.has('mcp__p-amap__maps_weather') && expertContext).toBe(true)
    expect([...models]).toEqual(['deepseek-chat'])
    expect(model.transfers.every(row => row.status === 200)).toBe(true)
    imageHash = createHash('sha256')
      .update(await readFile(image))
      .digest('hex')
    await stage('credential-boundary')
    const inspection = JSON.parse(await execFileText(runtimeSettings.containerRuntimeCli, ['inspect', await carrier()]))
    expect(inspection[0].Mounts.some((row: { Destination: string; RW: boolean }) => row.Destination === '/dsh-phalanx/experts' && row.RW === false)).toBe(true)
    expect(await memberExposesMcpCredentials(await carrier(), secrets, true)).toBe(false)
    const usageRecords = JSON.stringify(await api('usage-records'))
    expect(secrets.some(key => usageRecords.includes(key))).toBe(false)
    await expect(readFile(join(root, 'execution/audit.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(exposed).toBe(false)
    await stage('dismiss-revoke')
    const tool = async (name: string, args: object = {}) => {
      const response = await member.request.post(communityEntryUrl(origin, cookie) + 'skills-fixture', {
        headers: { origin },
        data: { operation: 'tool', sessionId, name, args },
      })
      expect(response.status()).toBe(200)
      return JSON.stringify(await response.json())
    }
    expect(
      await tool('bash', {
        command: 'cp "$(command -v mmx)" ./retained-expert-mmx && sh ./retained-expert-mmx --version',
        description: 'Retain the authorized execution forwarder',
        timeoutMs: 20000,
      }),
    ).toContain('"exitCode":0')
    await openMarket()
    await member.getByRole('button', { name: 'Dismiss expert', exact: true }).click()
    await member.getByRole('button', { name: 'Summon expert', exact: true }).waitFor()
    expect(await tool(realExpertSearchTool)).toContain('upstream denied 403')
    expect(await tool('bash', { command: 'sh ./retained-expert-mmx --version', description: 'Check immediate access withdrawal', timeoutMs: 20000 })).toContain(
      'DSH_PHALANX_EXECUTION[unauthorized]',
    )
    expect(
      await command(
        "fetch(new URL('/mcp/p-amap',process.env.DSH_PHALANX_MODEL_GATEWAY_URL),{method:'POST',headers:{authorization:'Bearer '+process.env.DSH_PHALANX_MODEL_GATEWAY_ACCESS_TOKEN,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:92,method:'tools/list'})}).then(r=>process.stdout.write(String(r.status)))",
      ),
    ).toBe('403')
    expect(
      (await rpc.remoteRpc<{ presets: { id: string }[] }>(origin, cookie, 'agentPresets/list', {})).presets.some(
        row => row.id === 'phalanx-expert-' + expertId,
      ),
    ).toBe(true)
    expect((await member.request.post(origin + '/recovery/restart', { headers: { origin }, data: { confirmed: true } })).status()).toBe(200)
    expect(
      (await rpc.remoteRpc<{ presets: { id: string }[] }>(origin, cookie, 'agentPresets/list', {})).presets.some(
        row => row.id === 'phalanx-expert-' + expertId,
      ),
    ).toBe(false)
    passed = true
  } catch (error) {
    primaryFailure = Error(safe(error instanceof Error ? error.message : String(error)))
  } finally {
    const attempt = async (action: () => Promise<unknown>) => {
      try {
        await action()
        return true
      } catch {
        cleanupErrors.push(Error('Owned expert acceptance cleanup failed'))
        return false
      }
    }
    await attempt(async () => browser?.close())
    const stopped = await attempt(async () => app?.stop()),
      rebuilt = await attempt(async () => {
        if (runtime) await new CommunityRuntimeDriver(runtime).rebuild()
      })
    await attempt(async () => model?.stop())
    if (stopped && rebuilt)
      await attempt(async () => {
        const writable = async (path: string): Promise<void> => {
          const info = await lstat(path)
          if (!info.isDirectory() || info.isSymbolicLink()) return
          await chmod(path, 0o700)
          for (const name of await readdir(path)) await writable(join(path, name))
        }
        await writable(root)
        await removeCommunityFixture(root)
      })
    await receipt('result', {
      passed: passed && cleanupErrors.length === 0,
      phase,
      candidate: required('DSH_PHALANX_CANDIDATE_SHA'),
      pluginCalled,
      mcpCalled,
      imageCommand,
      expertContext,
      models: [...models],
      imageSha256: imageHash,
      credentialExposed: exposed,
      cleanupPassed: cleanupErrors.length === 0,
    })
  }
  if (cleanupErrors.length)
    throw new AggregateError(primaryFailure ? [primaryFailure, ...cleanupErrors] : cleanupErrors, 'Expert real acceptance cleanup incomplete')
  if (primaryFailure) throw primaryFailure
}, 3600000)
