import { inspectDataRoot } from '../../src/adapters/data-root-layout.js'
import { populateInstalledRoot } from './installed-root-population.js'
import { contributeInstalledSkill } from './installed-root-contribution.js'
import { installedProjectionControl } from './installed-projection-control.js'
import { installedPluginInventory } from './installed-plugin-inventory.js'
// Explicit installed milestone probe; excluded from the regular test inventories.
import { createServer, request } from 'node:http'
import { once } from 'node:events'
import { randomUUID, createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { expect } from 'vitest'
import { createRealDshRpc } from './real-dsh-rpc.js'
import { communityEntryUrl } from './community-space.js'
import { latestHumanText, hasToolResult, streamText, streamToolCall } from './real-dsh-model.js'
import { skillZip } from '../fixtures/skills/archive.js'
import { execFileText } from '../../src/adapters/runtime-command.js'

type Context = {
  origin: string
  address: string
  adminCookie: string
  dataRoot: string
  userDataRoot: string
  workRoot: string
  member: string
  password: string
  gatewayAddress?: string
}

/** Preserve the configured public origin while connecting to its local installed listener. */
function installedRequest(context: Context, url: URL, init: RequestInit = {}): Promise<Response> {
  const target = new URL(url.pathname + url.search, context.address)
  const headers = new Headers(init.headers)
  headers.set('host', new URL(context.origin).host)
  headers.set('origin', context.origin)
  return new Promise((resolve, reject) => {
    const req = request(
      target,
      { method: init.method ?? 'GET', headers: Object.fromEntries(headers), signal: init.signal ?? AbortSignal.timeout(30_000) },
      async res => {
        try {
          const chunks: Buffer[] = []
          for await (const chunk of res) chunks.push(Buffer.from(chunk))
          const responseHeaders = new Headers()
          for (let index = 0; index < res.rawHeaders.length; index += 2) responseHeaders.append(res.rawHeaders[index]!, res.rawHeaders[index + 1]!)
          resolve(new Response(Buffer.concat(chunks), { status: res.statusCode!, headers: responseHeaders }))
        } catch (error) {
          reject(error)
        }
      },
    )
    req.on('error', reject)
    if (init.body instanceof Uint8Array) req.end(init.body)
    else req.end(init.body === undefined ? undefined : String(init.body))
  })
}

/** Run against one actual installation; extended mode verifies all rebuildable producers and projection recovery. */
export async function runInstalledBusiness(rebuildProjections = false) {
  const contextFile = process.env.DSH_PHALANX_MILESTONE_CONTEXT_FILE
  if (!contextFile) throw Error('An owned installed milestone context is required')
  const context = JSON.parse(await readFile(contextFile, 'utf8')) as Context
  for (const key of ['origin', 'address', 'adminCookie', 'dataRoot', 'userDataRoot', 'workRoot', 'member', 'password'] as const) {
    if (typeof context[key] !== 'string' || !context[key]) throw Error('Incomplete installed milestone context')
  }
  expect((await stat(context.workRoot)).uid).toBe(process.getuid!())
  const secrets = {
    model: randomUUID(),
    upstream: randomUUID(),
    mcp: randomUUID(),
    execution: randomUUID(),
    access: randomUUID(),
    upstreamHeader: randomUUID(),
    testBody: randomUUID(),
    mcpHeader: randomUUID(),
    mcpQuery: randomUUID(),
  }
  const observations: { marker: string; authorized: boolean; result: boolean; redacted: boolean; tools: string[]; expert: boolean }[] = []
  let pluginAuthorized = false,
    pluginCalls = 0,
    testBodyUsed = false,
    mcpFieldsUsed = false,
    stage = 'setup'
  const model = createServer(async (req, res) => {
    let text = ''
    for await (const chunk of req) text += chunk
    const body = JSON.parse(text),
      marker = latestHumanText(body),
      result = hasToolResult(body, 'milestone-mcp', false)
    if (text.includes('Generate a concise') && text.includes('title')) {
      res.setHeader('content-type', 'text/event-stream')
      streamText(res, 'Installed session')
      return
    }
    observations.push({
      marker,
      expert: text.includes('INSTALLED_EXPERT_PERSONA'),
      authorized: req.headers['x-api-key'] === secrets.model || req.headers.authorization === 'Bearer ' + secrets.model,
      result,
      redacted: text.includes('[redacted]') && !text.includes(secrets.mcp),
      tools: (body.tools ?? []).map((tool: { name: string }) => tool.name),
    })
    res.setHeader('content-type', 'text/event-stream')
    if (marker === 'MILESTONE_MCP' && !result && !hasToolResult(body, 'milestone-mcp', true))
      streamToolCall(res, 'milestone-mcp', 'mcp__p-milestone__search', {})
    else streamText(res, 'MILESTONE_READY')
  })
  const upstream = createServer(async (req, res) => {
    let text = ''
    for await (const chunk of req) text += chunk
    if (req.url?.startsWith('/mcp-check')) {
      if (req.method !== 'POST') {
        res.writeHead(405)
        res.end()
        return
      }
      const body = JSON.parse(text),
        url = new URL(req.url, 'http://localhost')
      mcpFieldsUsed ||=
        req.headers['x-private'] === secrets.mcpHeader &&
        url.searchParams.get('proof') === secrets.mcpQuery &&
        req.headers.authorization === 'Bearer ' + secrets.mcp
      res.setHeader('content-type', 'application/json')
      if (body.id === undefined) {
        res.writeHead(202)
        res.end()
        return
      }
      const result =
        body.method === 'initialize'
          ? { protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'protected-fields', version: '1' } }
          : { tools: [] }
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }))
      return
    }
    testBodyUsed ||= text.includes(secrets.testBody)
    pluginCalls++
    pluginAuthorized = req.headers.authorization === 'Bearer ' + secrets.upstream && req.headers['x-private'] === secrets.upstreamHeader
    res.setHeader('content-type', 'application/json')
    res.end(
      JSON.stringify({
        code: 0,
        message: 'ok',
        data: {
          metadata: { total_results: 1, search_time_ms: 1 },
          results: [{ title: 'ACCESS_READY', url: 'https://example.test/ready', content: 'ACCESS_READY' }],
        },
      }),
    )
  })
  model.listen(0, '127.0.0.1')
  upstream.listen(0, '127.0.0.1')
  await Promise.all([once(model, 'listening'), once(upstream, 'listening')])
  const port = (server: typeof model) => (server.address() as { port: number }).port
  const call = (path: string, init?: RequestInit) => installedRequest(context, new URL(path, context.origin), init)
  const api = async (path: string, input?: unknown) => {
    const response = await call('/admin/api/' + path, {
      method: input === undefined ? 'GET' : 'POST',
      headers: { cookie: context.adminCookie, 'content-type': 'application/json' },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    })
    if (!response.ok) throw Error('Installed management request failed: ' + path + ' HTTP ' + response.status)
    const result = await response.json()
    if (Object.values(secrets).some(value => JSON.stringify(result).includes(value))) throw Error('Management response disclosed a known credential')
    return result
  }
  const rpc = createRealDshRpc('', (url, init) => installedRequest(context, url, init))
  try {
    const status = await api('system-status')
    expect(status.database.kind).toBe('builtin')
    const group = (await api('groups')).find((row: { isDefault: boolean }) => row.isDefault)
    expect(group).toBeDefined()
    const account = await api('accounts', { username: context.member, password: context.password, email: '', groupId: group.id })
    const home = join(context.userDataRoot, context.member, 'home')
    await mkdir(home, { recursive: true, mode: 0o700 })
    for (const [fixture, target] of [
      ['plugin-access-probe.mjs', 'access-probe.mjs'],
      ['skill-observer.mjs', 'observer.mjs'],
    ]) {
      await writeFile(join(home, target!), await readFile(new URL('../fixtures/' + fixture!, import.meta.url)))
    }
    stage = 'model-configuration'
    const settings = await api('models')
    await api('models', {
      revision: settings.revision,
      action: 'save-provider',
      provider: {
        name: 'Milestone',
        baseUrl: `http://127.0.0.1:${port(model)}/anthropic`,
        apiFormat: 'anthropic-messages',
        apiKey: secrets.model,
        enabled: true,
        models: [{ name: 'milestone-model', enabled: true }],
      },
    })
    stage = 'plugin-configuration'
    const packageName = '@anysearch/anysearch-dsh',
      query = '?packageName=' + encodeURIComponent(packageName)
    await api('plugins', { action: 'add', packageName, version: '0.1.8' })
    await expect
      .poll(async () => (await api('plugins')).find((row: { packageName: string }) => row.packageName === packageName)?.stage, { timeout: 180_000 })
      .toBe('available')
    await api('plugins/upstreams' + query, {
      action: 'save',
      upstream: {
        name: 'search',
        baseUrl: `http://127.0.0.1:${port(upstream)}/anysearch`,
        credential: secrets.upstream,
        headers: [
          { name: 'Authorization', value: 'Bearer {credential}' },
          { name: 'X-Private', value: secrets.upstreamHeader },
        ],
        testRequest: { method: 'POST', path: '/fixture-check', body: { nonce: secrets.testBody } },
      },
    })
    expect(await api('plugins/upstreams/test' + query, { name: 'search' })).toMatchObject({ passed: true })
    expect(testBodyUsed).toBe(true)
    const access = await api('plugins/access' + query),
      entry = access.entryIds.find((id: string) => /anysearch/iu.test(id))
    expect(entry).toBeDefined()
    await api('plugins/access' + query, {
      environment: [
        { name: 'ANYSEARCH_API_KEY', value: '{access-token}' },
        { name: 'MILESTONE_ACCESS_KEY', value: secrets.access },
      ],
      entriesYaml: JSON.stringify({ [entry]: { baseURL: '{upstream:search}', apiKeyEnv: 'ANYSEARCH_API_KEY' } }),
    })
    const pluginGrant = 'groups/' + group.id + '/plugins'
    await api(pluginGrant, { action: 'save', packages: [packageName], preinstalls: [], revision: (await api(pluginGrant)).revision })
    stage = 'mcp-configuration'
    // The source contains no literal credential. The platform injects it only at runtime.
    const server = `import{createInterface}from'node:readline';for await(const line of createInterface({input:process.stdin})){const m=JSON.parse(line);if(m.id===undefined)continue;const result=m.method==='initialize'?{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'milestone',version:'1'}}:m.method==='tools/list'?{tools:[{name:'search',inputSchema:{type:'object',properties:{}}}]}:{content:[{type:'text',text:JSON.stringify({key:process.env.API_KEY})}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n')}`
    await api('mcp', {
      action: 'save',
      service: {
        name: 'p-milestone',
        description: 'Installed milestone',
        url: '',
        credential: secrets.mcp,
        run: {
          location: 'shared',
          command: 'node',
          args: ['server.mjs'],
          env: [{ name: 'API_KEY', value: '{credential}' }],
          prepareCommand: `node -e 'if(process.env.API_KEY!==undefined)throw Error("Preparation received credential");require("fs").writeFileSync("server.mjs",Buffer.from("${Buffer.from(server).toString('base64')}","base64"))'`,
        },
      },
    })
    await expect
      .poll(async () => (await api('mcp')).find((row: { name: string }) => row.name === 'p-milestone')?.preparation?.stage, { timeout: 180_000 })
      .toBe('ready')
    await api('groups/' + group.id + '/mcp', { names: ['p-milestone'] })
    await api('mcp', {
      action: 'save',
      service: {
        name: 'p-protected-fields',
        description: 'Protected header and query',
        url: `http://127.0.0.1:${port(upstream)}/mcp-check`,
        credential: secrets.mcp,
        headers: [
          { name: 'Authorization', value: 'Bearer {credential}' },
          { name: 'X-Private', value: secrets.mcpHeader },
        ],
        query: [{ name: 'proof', value: secrets.mcpQuery }],
      },
    })
    expect(await api('mcp/test', { name: 'p-protected-fields' })).toMatchObject({ testStatus: 'passed' })
    expect(mcpFieldsUsed).toBe(true)
    stage = 'execution-configuration'
    const script = `#!/usr/bin/env node\nconst fs=require('node:fs');const chunks=[];process.stdin.on('data',c=>chunks.push(c));process.stdin.on('end',()=>{fs.writeFileSync('owned-result.txt','created');process.stdout.write(JSON.stringify({credential:!!process.env.NEWS_KEY,memberEnvironment:process.env.MEMBER_PRIVATE??null,argv:process.argv.slice(2)})+'\\n');process.stdout.write(Buffer.concat(chunks));process.stderr.write('fixture-stderr');process.exitCode=7});\n`
    const upload = await call('/admin/api/skills/upload', {
      method: 'POST',
      headers: { cookie: context.adminCookie, 'content-type': 'application/zip' },
      body: new Uint8Array(
        skillZip([
          { path: 'SKILL.md', content: '---\nname: news\ndescription: Installed milestone CLI\n---\nRun news-cli.' },
          { path: 'bin/news-cli', content: script },
        ]),
      ),
    })
    expect(upload.status).toBe(200)
    const preview = await upload.json()
    await api('skills/change', { action: 'confirm', token: preview.token, revision: preview.revision })
    const skillGrant = 'groups/' + group.id + '/skills'
    await api(skillGrant, { action: 'save', names: ['news'], revision: (await api(skillGrant)).revision, confirmed: true })
    await api('skills/execution?name=news', {
      enabled: true,
      commands: [{ command: 'news-cli', blocked: [] }],
      variables: [{ name: 'NEWS_KEY', value: secrets.execution, secret: true }],
    })
    await expect.poll(async () => (await api('skills/execution?name=news')).preparation?.stage, { timeout: 120_000 }).toBe('ready')
    const populated = rebuildProjections
      ? await populateInstalledRoot({
          workRoot: context.workRoot,
          adminCookie: context.adminCookie,
          groupId: group.id,
          api,
          call,
          progress: value => {
            stage = value
          },
        })
      : undefined
    const usedTokens: string[] = []
    let contributionReady = false
    const verifyMember = async () => {
      observations.length = 0
      const priorPluginCalls = pluginCalls
      pluginAuthorized = false
      stage = 'member-login'
      const login = await call('/login', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ username: context.member, password: context.password }),
      })
      expect(login.status).toBe(303)
      let cookie = login.headers
        .getSetCookie()
        .map(row => row.split(';')[0])
        .join('; ')
      if (populated) {
        stage = 'expert-summon'
        const summon = await call('/market/api/experts', {
          method: 'POST',
          headers: { cookie, 'content-type': 'application/json' },
          body: JSON.stringify({ name: populated.expertId, action: 'summon' }),
        })
        expect(summon.status).toBe(200)
      }
      stage = 'member-entry'
      const url = communityEntryUrl(context.origin, cookie)
      let page: Response | undefined
      await expect
        .poll(
          async () => {
            page = await installedRequest(context, new URL(url), { headers: { cookie, accept: 'text/html' } })
            expect(page.status).toBe(200)
            if ((await page.clone().text()).includes('data-platform-startup')) return false
            return true
          },
          { timeout: 300_000 },
        )
        .toBe(true)
      cookie +=
        '; ' +
        page!.headers
          .getSetCookie()
          .map(row => row.split(';')[0])
          .join('; ')
      expect(await page!.text()).not.toContain('data-platform-startup')
      const { sessionId } = await rpc.remoteRpc<{ sessionId: string }>(context.origin, cookie, 'session/create', { request: { cwd: '/dsh-phalanx/workspace' } })
      const prompt = async (marker: string, targetSession = sessionId) => {
        await rpc.remoteRpc(context.origin, cookie, 'session/prompt', {
          request: { requestId: randomUUID(), sessionId: targetSession, mode: 'queue', content: [{ type: 'text', text: marker }] },
        })
        await expect.poll(() => observations.some(row => row.marker === marker && (marker !== 'MILESTONE_MCP' || row.result)), { timeout: 180_000 }).toBe(true)
        await expect
          .poll(
            async () =>
              (await rpc.remoteRpc<{ items: { sessionId: string; running: boolean }[] }>(context.origin, cookie, 'session/list', { _request: {} })).items.find(
                row => row.sessionId === targetSession,
              )?.running,
            { timeout: 180_000 },
          )
          .toBe(false)
      }
      stage = 'shared-model-call'
      await prompt('MILESTONE_MODEL')
      expect(observations.some(row => row.marker === 'MILESTONE_MODEL' && row.authorized)).toBe(true)
      stage = 'real-plugin-upstream'
      await expect
        .poll(
          async () =>
            (await rpc.remoteRpc<{ moduleName: string; fiberPhase: string }[]>(context.origin, cookie, 'pluginManager/listPlugins', {})).find(row =>
              row.moduleName.endsWith('/access-probe.mjs'),
            )?.fiberPhase,
          { timeout: 30_000 },
        )
        .toBe('active')
      const search = await installedRequest(context, new URL('access-probe', url), { headers: { cookie } })
      expect(search.status).toBe(200)
      expect(await search.text()).toContain('ACCESS_READY')
      expect(pluginCalls).toBeGreaterThan(priorPluginCalls)
      expect(pluginAuthorized).toBe(true)
      stage = 'real-mcp-tool'
      await prompt('MILESTONE_MCP')
      expect(observations.some(row => row.marker === 'MILESTONE_MCP' && row.result && row.redacted && row.authorized)).toBe(true)
      expect(observations.some(row => row.tools.includes('mcp__p-milestone__search'))).toBe(true)
      stage = 'real-execution'
      const observe = async (body: object) => {
        const response = await installedRequest(context, new URL('skills-fixture', url), {
          method: 'POST',
          headers: { cookie, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        expect(response.status).toBe(200)
        return response.json()
      }
      const observedSession = await observe({ operation: 'create' })
      const native = (
        await observe({
          operation: 'tool',
          sessionId: observedSession.sessionId,
          name: 'bash',
          args: { description: 'Installed delegated CLI', command: 'news-cli native', timeoutMs: 10_000 },
        })
      ).value
      expect(native.exitCode).toBe(7)
      expect(JSON.parse(native.stdout.text).credential).toBe(true)
      const owner = createHash('sha256').update(context.dataRoot).digest('hex')
      const container = (
        await execFileText('podman', [
          'ps',
          '--filter',
          'label=dsh-phalanx.community-root=' + owner,
          '--filter',
          'label=dsh-phalanx.user=' + context.member,
          '--format',
          '{{.ID}}',
        ])
      ).trim()
      expect(container.split(/\s+/u)).toHaveLength(1)
      expect(container).not.toBe('')
      if (populated) {
        if (!context.gatewayAddress) throw Error('The actual installed gateway address is required')
        const environment = JSON.parse(await execFileText('podman', ['inspect', container, '--format', '{{json .Config.Env}}'])) as string[]
        expect(environment.includes('MILESTONE_ACCESS_KEY=' + secrets.access)).toBe(true)
        const token = environment.find(row => row.startsWith('DSH_PHALANX_MODEL_GATEWAY_ACCESS_TOKEN='))?.split('=', 2)[1]
        if (!token) throw Error('The admitted member gateway token is required')
        usedTokens.push(token)
        if (!contributionReady) {
          stage = 'member-contribution-adoption'
          await contributeInstalledSkill({
            token,
            groupId: group.id,
            api,
            call: (path, init) => installedRequest({ ...context, address: context.gatewayAddress! }, new URL(path, context.origin), init),
          })
          contributionReady = true
        }
        stage = 'expert-member-call'
        stage = 'expert-preset'
        const roster = await rpc.remoteRpc<{ presets: { id: string }[] }>(context.origin, cookie, 'agentPresets/list', {})
        const preset = 'phalanx-expert-' + populated.expertId
        expect(roster.presets.some(row => row.id === preset)).toBe(true)
        const expert = await rpc.remoteRpc<{ sessionId: string }>(context.origin, cookie, 'session/create', {
          request: { cwd: '/dsh-phalanx/workspace', agentPreset: preset },
        })
        stage = 'expert-member-call'
        await prompt('MILESTONE_EXPERT', expert.sessionId)
        stage = 'expert-persona'
        expect(observations.some(row => row.marker === 'MILESTONE_EXPERT' && row.expert && row.authorized)).toBe(true)
      }

      stage = 'delegated-binary-stream'
      const input = Buffer.from([0, 255, 1, 10, 128])
      const child = spawn('podman', [
        'exec',
        '--interactive',
        '--workdir',
        '/dsh-phalanx/workspace',
        '--env',
        'MEMBER_PRIVATE=must-not-forward',
        container,
        'sh',
        '-c',
        'news-cli hot "two words"',
      ])
      const stdout: Buffer[] = [],
        stderr: Buffer[] = []
      child.stdout.on('data', chunk => stdout.push(chunk))
      child.stderr.on('data', chunk => stderr.push(chunk))
      child.stdin.end(input)
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject)
        child.once('close', resolve)
      })
      const output = Buffer.concat(stdout),
        split = output.indexOf(10)
      expect(code).toBe(7)
      expect(Buffer.concat(stderr).toString()).toBe('fixture-stderr')
      expect(JSON.parse(output.subarray(0, split).toString())).toEqual({ credential: true, memberEnvironment: null, argv: ['hot', 'two words'] })
      expect(output.subarray(split + 1)).toEqual(input)
      stage = 'workspace-result'
      const ownedFile = join(context.userDataRoot, context.member, 'workspace/owned-result.txt')
      expect(await readFile(ownedFile, 'utf8')).toBe('created')
      expect((await stat(ownedFile)).uid).toBe(process.getuid!())
      stage = 'plugin-inventory'
      const managedPlugins = installedPluginInventory(
        (await rpc.remoteRpc<{ moduleName: string; fiberPhase: string }[]>(context.origin, cookie, 'pluginManager/listPlugins', {}))
          .filter(row => row.fiberPhase === 'active')
          .map(row => row.moduleName),
      )
      const skillNames = populated ? ['news', 'installed-git-skill', 'installed-contributed'] : ['news']
      stage = 'skill-observation'
      for (const name of skillNames)
        await expect
          .poll(async () => JSON.stringify(await observe({ operation: 'get', sessionId: observedSession.sessionId, name })), { timeout: 30000 })
          .toContain(name)
      stage = 'model-inventory'
      const inventory = {
        plugins: managedPlugins,
        skills: skillNames,
        mcp: [...new Set(observations.flatMap(row => row.tools).filter(name => name.startsWith('mcp__')))].sort(),
        expert: populated?.expertId ?? null,
        models: JSON.parse(await readFile(join(context.dataRoot, 'managed-models/catalog.json'), 'utf8')),
      }
      return { cookie, inventory }
    }
    const before = await verifyMember()
    stage = 'data-root-layout'
    const layoutBefore = rebuildProjections ? await inspectDataRoot(context.dataRoot) : undefined
    if (layoutBefore)
      expect(layoutBefore.projections.sort()).toEqual([
        'experts/members',
        'managed-models',
        'mcp/members',
        'platform-plugin',
        'plugins/instances',
        'skills/members',
      ])
    let after = before
    if (rebuildProjections) {
      await installedProjectionControl(context.workRoot, { action: 'rebuild-projections' })
      after = await verifyMember()
      stage = 'capability-inventory-comparison'
      await writeFile(
        join(context.workRoot, 'inventory-comparison.json'),
        JSON.stringify({
          fields: (Object.keys(before.inventory) as (keyof typeof before.inventory)[]).map(field => ({
            field,
            beforeHash: createHash('sha256').update(JSON.stringify(before.inventory[field])).digest('hex'),
            afterHash: createHash('sha256').update(JSON.stringify(after.inventory[field])).digest('hex'),
          })),
          pluginCounts: { before: before.inventory.plugins.length, after: after.inventory.plugins.length },
        }) + '\n',
        { mode: 0o600 },
      )
      expect(after.inventory).toEqual(before.inventory)
      stage = 'rebuilt-data-root-layout'
      const rebuiltLayout = await inspectDataRoot(context.dataRoot)
      expect(rebuiltLayout.projections).toEqual(layoutBefore!.projections)
    }
    const cookie = after.cookie
    const known = [
      ...Object.entries(secrets).map(([scope, value]) => ({ scope, value })),
      ...[...new Set(usedTokens)].map((value, index) => ({ scope: 'used-member-gateway-token-' + index, value })),
    ]
    // Protected handoff to the installation owner, outside every platform scan scope.
    await writeFile(
      join(context.workRoot, 'scan-input.json'),
      JSON.stringify({
        knownSecrets: known.map(row => row.value),
        scopes: known.map(row => row.scope),
        member: context.member,
        spaceId: account.spaceId,
        cookie,
        origin: context.origin,
        address: context.address,
      }),
      { mode: 0o600 },
    )
    await writeFile(
      join(context.workRoot, 'business-result.json'),
      JSON.stringify({
        status: 'passed',
        singleInstalledContext: true,
        projectionRebuild: rebuildProjections,
        layout: layoutBefore,
        capabilityDigest: createHash('sha256').update(JSON.stringify(after.inventory)).digest('hex'),
        cases: ['shared-model', 'plugin-upstream', 'shared-mcp', 'delegated-binary-execution', 'member-native-entry'],
        pluginCalls,
        knownSecretCount: known.length,
      }) + '\n',
      { mode: 0o600 },
    )
  } catch (error) {
    const frame =
      error instanceof Error
        ? error.stack
            ?.split('\n')
            .filter(line => /^\s+at /u.test(line))
            .map(line => /\/tests\/support\/(installed-[a-z-]+\.ts):(\d+):(\d+)/u.exec(line))
            .find(Boolean)
        : undefined
    await writeFile(
      join(context.workRoot, 'business-result.json'),
      JSON.stringify({
        status: 'failed',
        stage,
        errorType: error instanceof Error ? error.name : 'unknown',
        ...(frame ? { assertion: { file: 'tests/support/' + frame[1], line: Number(frame[2]), column: Number(frame[3]) } } : {}),
        ...(error && typeof error === 'object' && 'actual' in error && typeof error.actual === 'number' ? { actualStatus: error.actual } : {}),
        ...(error && typeof error === 'object' && 'expected' in error && typeof error.expected === 'number' ? { expectedStatus: error.expected } : {}),
      }) + '\n',
      { mode: 0o600 },
    )
    // Avoid embedding a response or known secret in Vitest's assertion diagnostics.
    throw Error('Installed milestone failed at ' + stage)
  } finally {
    for (const server of [model, upstream]) {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  }
}
