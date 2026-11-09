// Validation: T2; real credentials: none; actual Linux rootless DSH. Missing inputs must fail the T2 report gate.
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import type { CommunityModelSettings, CommunityProviderProtocol } from '../src/domain/admin-contract.js'
import type { CommunityRuntimeConfig } from '../src/domain/community-config.js'
import type { CommunityApplication } from '../src/ports/community-application.js'
import { selectCommunityWorkspace, sendCommunityPrompt, signInCommunity } from './fixtures/community-native-browser.js'
import { removeCommunityFixture } from './fixtures/owned-cleanup.js'
import { startSharedModelProtocols } from './fixtures/shared-model-protocols.js'
import { candidateApplication } from './support/candidate-application.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { assertPinnedDshRevision, defaultWorkspacePath, instanceWorkspacePath, runtimeSection } from './support/real-dsh-runtime.js'

const apiKey = 'fixture-protocol-key'
const upstreamModel = 'deepseek-flash'
const prefix = '/prefix'
const cases: readonly {
  readonly protocol: CommunityProviderProtocol
  readonly endpoint: string
  readonly bodyKey: 'messages' | 'input'
  readonly perRequest: { input: number | null; output: number; cacheRead: number; cacheWrite: number | null }
  readonly unknownPerRequest: boolean
}[] = [
  {
    protocol: 'anthropic-messages',
    endpoint: '/v1/messages',
    bodyKey: 'messages',
    perRequest: { input: 10, output: 5, cacheRead: 2, cacheWrite: 3 },
    unknownPerRequest: false,
  },
  {
    protocol: 'openai-completions',
    endpoint: '/chat/completions',
    bodyKey: 'messages',
    perRequest: { input: null, output: 4, cacheRead: 2, cacheWrite: null },
    unknownPerRequest: true,
  },
  {
    protocol: 'openai-responses',
    endpoint: '/responses',
    bodyKey: 'input',
    perRequest: { input: null, output: 6, cacheRead: 4, cacheWrite: null },
    unknownPerRequest: true,
  },
]

describe('shared model gateway protocols through native DSH', () => {
  let root: string | undefined
  let app: CommunityApplication | undefined
  let runtime: CommunityRuntimeConfig | undefined
  let browser: Browser | undefined
  let upstream: Awaited<ReturnType<typeof startSharedModelProtocols>> | undefined
  afterEach(async () => {
    await browser?.close()
    await app?.stop()
    if (runtime) await new CommunityRuntimeDriver(runtime).rebuild()
    await upstream?.close()
    if (root) await removeCommunityFixture(root)
    root = undefined
    app = undefined
    runtime = undefined
    browser = undefined
    upstream = undefined
  })
  for (const entry of cases)
    it(`forwards ${entry.protocol} to its upstream endpoint, authentication and usage bucket`, async () => {
      assertPinnedDshRevision(runtimeSettings)
      root = await mkdtemp(join(tmpdir(), 'model-protocol-'))
      upstream = await startSharedModelProtocols()
      runtime = runtimeSection(root, upstream.origin, runtimeSettings)
      app = candidateApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'model-protocol-fixture-32-bytes-ok', runtime })
      const origin = await app.start()
      browser = await chromium.launch({ headless: true })
      const admin = await browser.newContext({ locale: 'en' })
      const bootstrap = await admin.request.post(`${origin}/bootstrap`, {
        headers: { origin },
        maxRedirects: 0,
        form: { credential: readBootstrapCredential(root)!.credential, username: 'admin', password: 'password' },
      })
      expect(bootstrap.status()).toBe(303)
      const saved = await admin.request.post(`${origin}/admin/api/models`, {
        headers: { origin },
        data: {
          revision: 0,
          action: 'save-provider',
          provider: {
            name: entry.protocol,
            baseUrl: `${upstream.origin}${prefix}`,
            apiFormat: entry.protocol,
            apiKey,
            enabled: true,
            models: [{ name: upstreamModel, enabled: true, input: 'text' }],
          },
        },
      })
      expect(saved.status(), await saved.text()).toBe(200)
      const settings = (await saved.json()) as CommunityModelSettings
      const platformModelId = settings.providers[0]!.models[0]!.id
      const created = await admin.request.post(`${origin}/admin/api/accounts`, {
        headers: { origin },
        data: { username: 'member', email: 'member@example.test', password: 'password' },
      })
      expect(created.status()).toBe(201)
      const context = await browser.newContext({ locale: 'en' })
      const page = await context.newPage()
      page.setDefaultTimeout(60_000)
      await signInCommunity(page, origin, 'member', 'password')
      await selectCommunityWorkspace(
        context,
        page,
        origin,
        instanceWorkspacePath(defaultWorkspacePath(root, 'member'), runtime.container !== undefined),
        runtime.container !== undefined,
      )
      await sendCommunityPrompt(page, 'Return the deterministic fixture marker.')
      const marker = upstream.marker(entry.protocol)
      await page.locator('p').filter({ hasText: marker }).first().waitFor({ timeout: 120_000 })
      // The forwarded request keeps the supplier base URL prefix, replaces only the model identity and keeps the body shape.
      const request = upstream.requests.find(row => row.protocol === entry.protocol)!
      expect(request.path).toBe(`${prefix}${entry.endpoint}`)
      expect(request.body).toMatchObject({ model: upstreamModel, stream: true })
      expect(Array.isArray(request.body[entry.bodyKey]) || typeof request.body[entry.bodyKey] === 'string').toBe(true)
      if (entry.protocol === 'anthropic-messages') {
        expect(request.apiKey).toBe(apiKey)
        expect(request.authorization).toBeUndefined()
        expect(request.anthropicVersion).toBe('2023-06-01')
      } else {
        expect(request.authorization).toBe(`Bearer ${apiKey}`)
        expect(request.apiKey).toBeUndefined()
        expect(request.anthropicVersion).toBeUndefined()
      }
      expect(await page.content()).not.toContain(apiKey)
      // The gateway records usage after forwarding; poll until that write lands.
      const readBucket = async () => {
        const usageResponse = await admin.request.get(`${origin}/admin/api/usage-models`)
        expect(usageResponse.status()).toBe(200)
        const usage = (await usageResponse.json()) as {
          items: { modelId: string; requests: number; unknownRequests: number; deniedRequests: number; tokens: Record<string, number | null> }[]
        }
        return usage.items.find(row => row.modelId === platformModelId)
      }
      await expect.poll(async () => (await readBucket())?.requests ?? 0, { timeout: 20_000 }).toBeGreaterThan(0)
      const bucket = (await readBucket())!
      expect(bucket.deniedRequests).toBe(0)
      expect(bucket.tokens).toEqual({
        reasoning: null,
        input: entry.perRequest.input === null ? null : entry.perRequest.input * bucket.requests,
        output: entry.perRequest.output * bucket.requests,
        cacheRead: entry.perRequest.cacheRead * bucket.requests,
        cacheWrite: entry.perRequest.cacheWrite === null ? null : entry.perRequest.cacheWrite * bucket.requests,
      })
      expect(bucket.unknownRequests).toBe(entry.unknownPerRequest ? bucket.requests : 0)
    })
})
