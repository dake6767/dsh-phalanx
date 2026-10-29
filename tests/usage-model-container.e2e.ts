// Validation: T2; real credentials: none; installed platform and real rootless DSH. Missing inputs must fail the T2 report gate.
import { removeCommunityFixture } from './fixtures/owned-cleanup.js'
import { effectiveUserDataRoot } from '../src/domain/storage-layout.js'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, mkdir, copyFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser } from 'playwright'
import { expect, it } from 'vitest'
import { candidateApplication } from './support/candidate-application.js'
import { injectedCandidateApplication } from './support/injected-candidate-application.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { assertPinnedDshRevision, runtimeSection, defaultWorkspacePath, instanceWorkspacePath } from './support/real-dsh-runtime.js'
import { cookieHeader, createBrowserDshRpc } from './support/real-dsh-rpc.js'
import { latestHumanText } from './support/real-dsh-model.js'
import { signInCommunity } from './fixtures/community-native-browser.js'
import { communityEntryUrl } from './support/community-space.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import type { CommunityApplication } from '../src/ports/community-application.js'
import type { CommunityModelUsage } from '../src/domain/admin-contract.js'

it('shows native shared-model totals and ends an installed local 402 refusal without retrying the main turn', async () => {
  assertPinnedDshRevision(runtimeSettings)
  const root = await mkdtemp(join(tmpdir(), 'usage-model-')),
    calls = { main: 0, title: 0 }
  const model = createServer((request, response) => {
    void (async () => {
      let raw = ''
      for await (const chunk of request) raw += chunk
      const body = JSON.parse(raw),
        title = body.max_tokens === 64 || latestHumanText(body).startsWith('Generate the session title from this JSON array of human messages:')
      calls[title ? 'title' : 'main']++
      response.setHeader('content-type', 'text/event-stream')
      const event = (value: Record<string, unknown>) => `event: ${String(value.type)}\ndata: ${JSON.stringify(value)}\n\n`
      response.write(
        event({
          type: 'message_start',
          message: { usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 2, cache_creation_input_tokens: 3 } },
        }),
      )
      response.write(event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
      response.write(event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: title ? 'USAGE_TITLE' : 'MODEL_USAGE_READY' } }))
      response.write(event({ type: 'content_block_stop', index: 0 }))
      response.write(event({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 12 } }))
      response.end(event({ type: 'message_stop' }))
    })().catch(() => response.destroy())
  })
  model.listen(0, '127.0.0.1')
  await once(model, 'listening')
  const modelOrigin = `http://127.0.0.1:${(model.address() as { port: number }).port}`
  const runtime = runtimeSection(join(root, 'platform'), modelOrigin, runtimeSettings)
  const home = join(effectiveUserDataRoot(runtime), 'member/home'),
    overlay = join(root, 'observer.json')
  await writeFile(
    overlay,
    JSON.stringify([
      { insert: [{ id: 'model-usage-observer', name: 'container' in runtime ? '/dsh-phalanx/home/observer.mjs' : join(home, 'observer.mjs') }] },
    ]),
  )
  runtime.patches.push(overlay)
  const config = { listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'model-usage-installed-acceptance-secret', runtime }
  let app: CommunityApplication | undefined, browser: Browser | undefined, failure: unknown
  const cleanup = async () => {
    const errors: unknown[] = []
    for (const action of [
      () => browser?.close(),
      () => app?.stop(),
      () => new CommunityRuntimeDriver(runtime).rebuild(),
      async () => {
        model.closeAllConnections()
        await new Promise<void>(resolve => model.close(() => resolve()))
      },
      () => removeCommunityFixture(root),
    ]) {
      try {
        await action()
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length) throw new AggregateError(failure === undefined ? errors : [failure, ...errors], 'Model usage fixture cleanup failed')
  }
  try {
    app = candidateApplication(config)
    browser = await chromium.launch({ headless: true })
    let origin = await app.start()
    const admin = await browser.newPage({ locale: 'en' })
    admin.setDefaultTimeout(30000)
    if (process.env.DSH_PHALANX_E2E_CPU_THROTTLE) await (await admin.context().newCDPSession(admin)).send('Emulation.setCPUThrottlingRate', { rate: 4 })
    expect(
      (
        await admin.request.post(origin + '/bootstrap', {
          headers: { origin },
          form: { credential: readBootstrapCredential(runtime.dataRoot)!.credential, username: 'admin', password: 'password' },
          maxRedirects: 0,
        })
      ).status(),
    ).toBe(303)
    const api = async (path: string, data?: object) => {
      const response = data
        ? await admin.request.post(origin + '/admin/api/' + path, { headers: { origin }, data })
        : await admin.request.get(origin + '/admin/api/' + path)
      expect(response.ok(), await response.text()).toBe(true)
      return response.json()
    }
    let models = await api('models')
    models = await api('models', {
      revision: models.revision,
      action: 'save-provider',
      provider: {
        name: 'Usage fixture',
        baseUrl: modelOrigin + '/anthropic',
        apiFormat: 'anthropic-messages',
        apiKey: 'fictional-model-key',
        enabled: true,
        models: [{ name: 'usage-model', enabled: true }],
      },
    })
    const modelId = models.defaultModelId
    await api('accounts', { username: 'member', password: 'password', email: '' })
    await mkdir(home, { recursive: true })
    await copyFile('tests/fixtures/skill-observer.mjs', join(home, 'observer.mjs'))
    let member = await browser.newPage({ locale: 'en' })
    member.setDefaultTimeout(30000)
    await signInCommunity(member, origin, 'member', 'password')
    const prompt = async (text: string) => {
      const rpc = createBrowserDshRpc(member.context()),
        cookie = await cookieHeader(member.context(), origin)
      const session = await rpc.remoteRpc<{ sessionId: string }>(origin, cookie, 'session/create', {
        request: { cwd: instanceWorkspacePath(defaultWorkspacePath(runtime.dataRoot, 'member'), 'container' in runtime) },
      })
      await rpc.remoteRpc(origin, cookie, 'session/prompt', {
        request: { requestId: randomUUID(), sessionId: session.sessionId, mode: 'queue', content: [{ type: 'text', text }] },
      })
      const events = async () => {
        const response = await member.request.post(communityEntryUrl(origin, cookie) + 'skills-fixture', {
          headers: { origin },
          data: { operation: 'events', sessionId: session.sessionId },
        })
        expect(response.ok(), await response.text()).toBe(true)
        return (await response.json()) as { type: string; data: { reason?: { kind: string; error?: { code?: string; message?: string } } } }[]
      }
      await expect.poll(async () => (await events()).some(event => event.type === 'turn/end'), { timeout: 90000 }).toBe(true)
      return events()
    }
    const positive = await prompt('COUNT_MODEL_USAGE_PRIVATE')
    expect(
      positive.findLast(event => event.type === 'turn/end')?.data.reason?.kind,
      JSON.stringify({ reason: positive.findLast(event => event.type === 'turn/end')?.data.reason, calls, modelId }),
    ).toBe('completed')
    await expect.poll(() => calls.title, { timeout: 30000 }).toBe(1)
    expect(calls.main).toBe(1)
    await expect.poll(async () => ((await api('usage-models')) as CommunityModelUsage).items[0]?.requests).toBe(2)
    const totals = (await api('usage-models')) as CommunityModelUsage
    expect(totals.items).toEqual([
      { username: 'member', modelId, requests: 2, unknownRequests: 0, deniedRequests: 0, tokens: { input: 20, output: 24, cacheRead: 4, cacheWrite: 6 } },
    ])
    expect((await api('usage-records')).total).toBe(0)
    expect(JSON.stringify(totals)).not.toMatch(/COUNT_MODEL_USAGE_PRIVATE|fictional-|MODEL_USAGE_READY/)
    await admin.goto(origin + '/admin/usage-records')
    await admin.getByRole('tab', { name: 'Model usage', exact: true }).click()
    const grid = admin.getByRole('grid', { name: 'Model token totals', exact: true })
    await grid.getByText('Usage fixture / usage-model', { exact: true }).waitFor()
    for (const label of ['Input tokens', 'Output tokens', 'Cache read tokens', 'Cache write tokens', 'Unknown requests'])
      await grid.getByRole('columnheader', { name: label, exact: true }).waitFor()
    await admin.getByRole('button', { name: 'Last 7 days (UTC)', exact: true }).click()
    await grid.getByText('Usage fixture / usage-model', { exact: true }).waitFor()
    await app.stop()
    await member.close()
    app = injectedCandidateApplication(config, { testOnlyDenyUsage: true })
    origin = await app.start()
    member = await browser.newPage({ locale: 'en' })
    member.setDefaultTimeout(30000)
    await signInCommunity(member, origin, 'member', 'password')
    const refused = await prompt('REJECT_USAGE_PRIVATE')
    const end = refused.findLast(event => event.type === 'turn/end')
    expect(end?.data.reason).toMatchObject({ kind: 'error', error: { code: 'PI_AI_ERROR' } })
    expect(end?.data.reason?.error?.message).toContain('402')
    expect(end?.data.reason?.error?.message).toContain('usage-not-allowed')
    expect(refused.filter(event => event.type.startsWith('llm/retry'))).toEqual([])
    expect(calls).toEqual({ main: 1, title: 1 })
    await expect.poll(async () => ((await api('usage-models')) as CommunityModelUsage).items[0]?.deniedRequests).toBeGreaterThanOrEqual(1)
    const after = (await api('usage-models')) as CommunityModelUsage
    expect(after.items[0]).toMatchObject({ unknownRequests: 0, tokens: { input: 20, output: 24, cacheRead: 4, cacheWrite: 6 } })
    expect((await api('usage-records')).total).toBe(0)
  } catch (error) {
    failure = error
    throw error
  } finally {
    await cleanup()
  }
}, 300000)
