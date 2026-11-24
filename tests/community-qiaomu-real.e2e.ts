// Validation: T4 only; real credentials: required (Qiaomu conversation and image providers). Two verified Linux artifacts.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { lstat, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import type { CommunityMarketPageData, CommunitySuiteCatalogView } from '../src/domain/admin-contract.js'
import { withSuiteCatalogContentHash, type UnsealedSuiteCatalogDocumentEntry } from '../src/domain/suite-catalog-document.js'
import { openCommunitySidebar, signInCommunity } from './fixtures/community-native-browser.js'
import { removeCommunityFixture } from './fixtures/owned-cleanup.js'
import qiaomuEntry from './fixtures/qiaomu-cover-design-catalog.json' with { type: 'json' }
import { documentSuiteCatalogFixture } from './fixtures/suite-catalog-server.js'
import { seedTestSecrets, withTestDatabase } from './support/community-application.js'
import { communityEntryUrl } from './support/community-space.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { cookieHeader, createRealDshRpc, rpcBody, type RpcResult } from './support/real-dsh-rpc.js'
import { assertPinnedDshRevision, runtimeSection } from './support/real-dsh-runtime.js'
import { validationDownloadSelection } from './support/validation-downloads.js'

const id = qiaomuEntry.id
const packageName = 'qiaomu-cover-design-dsh'
const title = qiaomuEntry.title.en
// Seal the published wire entry verbatim so the archive and service extensions reach the installed reader.
const oldEntry = withSuiteCatalogContentHash(qiaomuEntry as UnsealedSuiteCatalogDocumentEntry)
if (oldEntry.kind !== 'plugin') throw Error('Expected the Qiaomu catalog plugin')
const newEntry = withSuiteCatalogContentHash({
  ...oldEntry,
  version: '1.2.0',
  engines: { platform: '>=0.1.40' },
  items: oldEntry.items.map(item =>
    item.kind === 'plugin'
      ? {
          ...item,
          version: '0.1.7',
          integrity: 'sha512-qMd7QAdYpDFYax0iGGmQ5OxTXF/KaTV+6fH9QhRgkYK/J4lK9j3/OFkXdSZubY+TRLF0JamZRLRCE8gXI8OpoA==',
          archive: { url: 'https://github.com/joeseesun/qiaomu-cover-design-dsh/releases/download/v0.1.7/qiaomu-cover-design-dsh-0.1.7.tgz' },
        }
      : item,
  ),
})

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw Error('Missing Qiaomu acceptance input ' + name)
  return value
}

async function credentials(kind: 'TEXT' | 'IMAGE') {
  const prefix = 'DSH_PHALANX_QIAOMU_' + kind
  const path = required(prefix + '_KEY_FILE')
  const stat = await lstat(path)
  if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) throw Error('Invalid Qiaomu credential file mode')
  const key = (await readFile(path, 'utf8')).trim()
  if (!key) throw Error('Empty Qiaomu credential')
  return { endpoint: required(prefix + '_URL'), model: required(prefix + '_MODEL'), key }
}

type ApplicationModule = typeof import('../src/composition/community-application.js')

async function application(root: string) {
  return (await import(pathToFileURL(join(root, 'dist/composition/community-application.js')).href)) as ApplicationModule
}

async function openDesigner(page: Page) {
  await openCommunitySidebar(page)
  await page.getByRole('button', { name: /^(Qiaomu Cover Design|乔木封面)$/u }).click()
  await page.locator('[data-plugin="qiaomu-cover-design-dsh"] .qcover-dsh-surface').waitFor()
}

it('updates a configured Qiaomu installation from rc.3 and reinstalls the official 0.1.7 after catalog retirement', async () => {
  const installed = required('DSH_PHALANX_INSTALL_ROOT')
  const predecessor = required('DSH_PHALANX_QIAOMU_LEGACY_ROOT')
  const oldImage = required('DSH_PHALANX_QIAOMU_LEGACY_IMAGE')
  if (process.platform !== 'linux' || process.arch !== 'arm64' || !runtimeSettings.containerImage) throw Error('Use the installed Linux arm64 artifacts')
  const build = async (root: string) => JSON.parse(await readFile(join(root, 'build-info.json'), 'utf8'))
  expect(await build(installed)).toMatchObject({ commit: required('DSH_PHALANX_CANDIDATE_SHA'), platform: 'linux/arm64' })
  expect(await build(predecessor)).toMatchObject({ commit: required('DSH_PHALANX_QIAOMU_LEGACY_SHA'), platform: 'linux/arm64' })
  assertPinnedDshRevision(runtimeSettings)
  const oldRevision = execFileSync(runtimeSettings.containerRuntimeCli, ['image', 'inspect', oldImage, '--format', '{{index .Config.Labels "dsh.revision"}}'], {
    encoding: 'utf8',
  }).trim()
  expect(oldRevision).toBe(required('DSH_PHALANX_QIAOMU_LEGACY_DSH_REVISION'))
  const chat = await credentials('TEXT')
  const image = await credentials('IMAGE')
  const root = await mkdtemp(join(tmpdir(), 'community-qiaomu-'))
  const oldRuntime = runtimeSection(root, 'http://127.0.0.1:1', { ...runtimeSettings, containerImage: oldImage })
  const runtime = runtimeSection(root, 'http://127.0.0.1:1', runtimeSettings)
  const config = withTestDatabase({ listen: { host: '127.0.0.1', port: 0 }, runtime, downloadSources: validationDownloadSelection() })
  const fixture = await documentSuiteCatalogFixture([oldEntry], new Map())
  const options = { suiteCatalog: { address: fixture.address, trustedKeys: fixture.trustedKeys } }
  let active: ReturnType<ApplicationModule['createCommunityApplication']> | undefined
  const owned: { browser?: Browser } = {}
  onTestFinished(async () => {
    const outcomes = await Promise.allSettled([active?.stop(), owned.browser?.close(), fixture.close()])
    const failures = outcomes.flatMap(result => (result.status === 'rejected' ? [result.reason] : []))
    for (const step of [() => new CommunityRuntimeDriver(runtime).rebuild(), () => removeCommunityFixture(root)]) {
      try {
        await step()
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length) throw new AggregateError(failures, 'Qiaomu acceptance cleanup failed')
  })
  await seedTestSecrets(config, installed)
  active = (await application(predecessor)).createCommunityApplication({ ...config, runtime: oldRuntime }, options)
  let origin = (await active.start()).toString()
  const browser = (owned.browser = await chromium.launch({ headless: true }))
  let admin = await browser.newContext({ locale: 'en' })
  expect(
    (
      await admin.request.post(origin + '/bootstrap', {
        headers: { origin },
        form: { credential: readBootstrapCredential(root)!.credential, username: 'admin', password: 'password' },
        maxRedirects: 0,
      })
    ).status(),
  ).toBe(303)

  async function api<T>(path: string, data?: object): Promise<T> {
    const response = data
      ? await admin.request.post(origin + '/admin/api/' + path, { headers: { origin }, data })
      : await admin.request.get(origin + '/admin/api/' + path)
    expect(response.ok(), `Admin API ${path} returned ${response.status()}`).toBe(true)
    return (await response.json()) as T
  }
  const catalog = () => api<CommunitySuiteCatalogView>('suites')
  const installation = async () => (await catalog()).installations.find(row => row.id === id)
  const servicesPath = 'plugins/services?packageName=' + packageName
  const settings = () => api<{ revision: string; slots: readonly unknown[] }>(servicesPath)
  const configure = async (slot: 'chat' | 'image', values: Awaited<ReturnType<typeof credentials>>) => {
    for (const change of [{ action: 'save', values }, { action: 'enable' }])
      await api(servicesPath, { revision: (await settings()).revision, change: { ...change, slot, backend: 'openai' } })
  }
  const waitForInstallation = async (version: string) => {
    await expect.poll(async () => (await installation())?.status, { timeout: 240_000 }).toMatch(/^(installed|failed)$/u)
    const row = await installation()
    expect(row?.status, row?.failureCode ?? 'Qiaomu catalog installation').toBe('installed')
    expect(row?.version).toBe(version)
  }
  const member = await api<{ groupId: string }>('accounts', { username: 'qiaomu-upgrade', password: 'password', email: '' })
  const features = `groups/${member.groupId}/native-features`
  await api(features, { revision: (await api<{ revision: string }>(features)).revision, disabledIds: [], showAppCenter: true })
  const group = `groups/${member.groupId}/plugins`
  const preinstall = async (names: string[]) =>
    await api(group, { action: 'save', revision: (await api<{ revision: string }>(group)).revision, packages: [], preinstalls: names })

  expect((await catalog()).entries.find(row => row.id === id)?.available).toBe(true)
  await api('suites', { action: 'install', input: { id, requestId: 'qiaomu-old-install', publish: false } })
  await waitForInstallation('1.1.0')
  await configure('chat', chat)
  await configure('image', image)
  await api('plugins/publication', { action: 'publish', packageName, published: true, confirmed: true })
  await preinstall([packageName])
  const oldMember = await browser.newContext({ locale: 'en' })
  await signInCommunity(await oldMember.newPage(), origin, 'qiaomu-upgrade', 'password')
  const rpc = createRealDshRpc()
  const call = async <T>(context: BrowserContext, method: string, input: object = {}) =>
    await rpc.remoteRpc<T>(origin, await cookieHeader(context, origin), 'qiaomuCoverDesign/' + method, input)
  const load = (context: BrowserContext) => call<{ data: { settings: { ai: Record<string, string> }; workspace?: object }; revision: number }>(context, 'load')
  await expect.poll(async () => (await load(oldMember)).data.settings.ai.model, { timeout: 120_000 }).toBe(chat.model)
  const legacy = await load(oldMember)
  expect(legacy.data.settings.ai.model).toBe(chat.model)
  expect(legacy.data.settings.ai.imageModel).toBe(image.model)
  console.info('Qiaomu 0.1.5 configured on rc.3')
  await oldMember.close()
  await admin.close()
  await active.stop()
  active = undefined
  await new CommunityRuntimeDriver(oldRuntime).rebuild()

  fixture.publish([newEntry])
  active = (await application(installed)).createCommunityApplication(config, options)
  origin = (await active.start()).toString()
  admin = await browser.newContext({ locale: 'en' })
  const gallery = await admin.newPage()
  await signInCommunity(gallery, origin, 'admin', 'password', true)
  await gallery.goto(origin + '/admin/plugins?tab=catalog')
  const tile = gallery.locator('.plugin-library-card').filter({ has: gallery.getByRole('button', { name: 'View catalog entry ' + title, exact: true }) })
  await tile.getByRole('button', { name: 'Update', exact: true }).click()
  const update = gallery.getByRole('dialog', { name: title })
  await update.getByText(`Plugin ${packageName}: 0.1.5 → 0.1.7`, { exact: true }).waitFor()
  await update.getByRole('button', { name: 'Confirm update', exact: true }).click()
  await expect.poll(async () => (await installation())?.version, { timeout: 240_000 }).toBe('1.2.0')
  await waitForInstallation('1.2.0')
  await tile.getByRole('button', { name: 'View catalog entry ' + title, exact: true }).click()
  const access = gallery.getByRole('dialog', { name: title })
  const conversation = access.getByRole('region', { name: 'Conversation', exact: true })
  const images = access.getByRole('region', { name: 'Image generation', exact: true })
  await conversation.getByLabel('Model name', { exact: true }).waitFor()
  expect(await conversation.getByLabel('Model name', { exact: true }).inputValue()).toBe(chat.model)
  expect(await images.getByLabel('Model name', { exact: true }).inputValue()).toBe(image.model)
  expect(await conversation.getByText('Interface', { exact: true }).count()).toBe(0)
  await images.getByRole('button', { name: /OpenAI.compatible/u }).click()
  await gallery.getByRole('option', { name: 'Volcengine Seedream', exact: true }).click()
  await images.getByRole('button', { name: /Volcengine Seedream/u }).waitFor()

  const memberCatalog = async (context: BrowserContext) => {
    const response = await context.request.get(origin + '/market/api/plugins')
    expect(response.status()).toBe(200)
    return ((await response.json()) as CommunityMarketPageData).plugins.find(row => row.packageName === packageName)
  }
  const updateMember = async () => {
    const context = await browser.newContext({ locale: 'en' })
    const page = await context.newPage()
    await signInCommunity(page, origin, 'qiaomu-upgrade', 'password')
    await openCommunitySidebar(page)
    await page.getByRole('button', { name: 'Platform App Center', exact: true }).click()
    const market = page.getByRole('region', { name: 'Platform App Center', exact: true })
    await market.getByRole('tab', { name: 'Plugins', exact: true }).click()
    await expect
      .poll(() => memberCatalog(context), { timeout: 120_000 })
      .toMatchObject({
        installedVersion: '0.1.5',
        update: { version: '0.1.7' },
      })
    const memberTitle = (await memberCatalog(context))!.title
    const listing = market.getByRole('listitem').filter({ has: page.getByRole('heading', { name: memberTitle, exact: true }) })
    const accepted = page.waitForResponse(response => new URL(response.url()).pathname === '/market/api/plugins' && response.request().method() === 'POST')
    await listing.getByRole('button', { name: 'Update plugin', exact: true }).click()
    expect((await accepted).status()).toBe(202)
    await expect.poll(async () => (await memberCatalog(context))?.job?.status, { timeout: 240_000 }).toBe('succeeded')
    expect((await context.request.post(origin + '/recovery/restart', { headers: { origin }, data: { confirmed: true } })).status()).toBe(200)
    await context.close()
  }

  const exercise = async (username: string) => {
    const context = await browser.newContext({ locale: 'en' })
    const page = await context.newPage()
    await signInCommunity(page, origin, username, 'password')
    await expect.poll(async () => (await memberCatalog(context))?.installedVersion, { timeout: 120_000 }).toBe('0.1.7')
    await openDesigner(page)
    const state = (await load(context)).data.settings.ai
    expect(state.model).toBe(chat.model)
    expect(state.imageModel).toBe(image.model)
    expect(Boolean(state.apiKey && state.apiKey !== chat.key && state.imageKey && state.imageKey !== image.key)).toBe(true)
    const serviceRequest = async (
      operation: 'conversation' | 'image generation' | 'image download',
      request: { url: string; method: 'GET' | 'POST'; contentType?: string; headers?: Record<string, string>; body?: string },
    ) => {
      const started = performance.now()
      let reply: { status: number; base64: string }
      try {
        const cookie = await cookieHeader(context, origin)
        const entry = communityEntryUrl(origin, cookie).replace(/\/$/u, '')
        // Provider requests can outlast a readiness poll and must not be replayed after a client timeout.
        const response = await fetch(new URL('api/qiaomuCoverDesign/request', `${entry}/`), {
          method: 'POST',
          redirect: 'manual',
          headers: { 'content-type': 'application/json', cookie },
          body: rpcBody('qiaomuCoverDesign/request', { request }),
          signal: AbortSignal.timeout(210_000),
        })
        if (!response.ok) throw Error('Native RPC HTTP failure')
        const { result } = (await response.json()) as { result: RpcResult<{ status: number; base64: string }> }
        if (!result.ok) throw Error('Native RPC failure')
        reply = result.value
      } catch {
        throw Error(`Qiaomu ${operation} failed in native RPC`)
      }
      if (!Number.isInteger(reply?.status) || typeof reply.base64 !== 'string') throw Error(`Qiaomu ${operation} returned an invalid native RPC result`)
      if (reply.status !== 200) {
        let reason = 'unclassified response'
        try {
          const message: unknown = JSON.parse(Buffer.from(reply.base64, 'base64').toString())?.error?.message
          if (message === 'The configured provider could not complete this request') reason = 'upstream HTTP failure'
          if (message === 'The configured provider returned an invalid response') reason = 'invalid upstream payload'
          if (message === 'Plugin service is unavailable') reason = 'gateway transport failure'
          if (message === 'Plugin service timed out') reason = 'gateway timeout'
        } catch {
          // Do not include the response body or provider configuration in diagnostics.
        }
        throw Error(`Qiaomu ${operation} failed with HTTP ${reply.status} (${reason}, ${Math.round(performance.now() - started)} ms)`)
      }
      return reply.base64
    }
    const provider = async (operation: 'conversation' | 'image generation', url: string, key: string, body: object) => {
      const encoded = await serviceRequest(operation, {
        url,
        method: 'POST',
        contentType: 'application/json',
        headers: { authorization: 'Bearer ' + key },
        body: JSON.stringify(body),
      })
      try {
        return JSON.parse(Buffer.from(encoded, 'base64').toString())
      } catch {
        throw Error(`Qiaomu ${operation} returned malformed JSON`)
      }
    }
    const conversation = await provider('conversation', state.baseUrl! + '/chat/completions', state.apiKey!, {
      model: state.model,
      messages: [{ role: 'user', content: 'Write a short caption about a paper boat.' }],
    })
    expect(Boolean(conversation.choices?.[0]?.message?.content?.trim())).toBe(true)
    const picture = await provider('image generation', state.imageBaseUrl! + '/images/generations', state.imageKey!, {
      model: state.imageModel,
      prompt: 'An original paper boat on a plain table, no text.',
      n: 1,
      size: '1024x1024',
    })
    const generated = picture.data?.[0]
    let encoded: string = generated?.b64_json ?? ''
    if (!encoded && typeof generated?.url === 'string') {
      encoded = await serviceRequest('image download', { url: generated.url, method: 'GET' })
    }
    const bytes = Buffer.from(encoded, 'base64')
    const png = bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    const jpeg = bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))
    const webp = bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
    expect(bytes.length > 1000 && (png || jpeg || webp), 'Qiaomu generated image bytes').toBe(true)
    const path = 'qiaomu-acceptance.' + (png ? 'png' : jpeg ? 'jpg' : 'webp')
    await call(context, 'fileWrite', { request: { path, base64: encoded, exclusive: true } })
    const saved = await call<{ base64: string }>(context, 'fileRead', { request: { path, binary: true } })
    const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex')
    expect(digest(Buffer.from(saved.base64, 'base64'))).toBe(digest(bytes))
    await context.close()
  }

  await updateMember()
  await exercise('qiaomu-upgrade')
  console.info('Qiaomu 0.1.7 update delivered and both configured services replied')
  await preinstall([])
  await api('suites', { action: 'uninstall', id, input: {} })
  await expect.poll(installation, { timeout: 120_000 }).toBeUndefined()
  await api('suites', { action: 'install', input: { id, requestId: 'qiaomu-new-install', publish: false } })
  await waitForInstallation('1.2.0')
  await configure('chat', chat)
  await configure('image', image)
  await api('plugins/publication', { action: 'publish', packageName, published: true, confirmed: true })
  await api('accounts', { username: 'qiaomu-reinstalled', password: 'password', email: '' })
  await preinstall([packageName])
  await exercise('qiaomu-reinstalled')
  console.info('Qiaomu 0.1.7 reinstalled and both configured services replied')
  const memberSession = await browser.newContext({ locale: 'en' })
  await signInCommunity(await memberSession.newPage(), origin, 'qiaomu-reinstalled', 'password')
  const response = await memberSession.request.get(origin + '/market/api/plugins')
  expect(response.status()).toBe(200)
  expect(((await response.json()) as CommunityMarketPageData).plugins.filter(row => row.packageName === packageName)).toEqual([
    expect.objectContaining({ packageName, version: '0.1.7' }),
  ])
}, 1_800_000)
