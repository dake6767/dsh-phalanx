// Validation: T4 only; real credentials: required (Media Desk image and text providers). Never selected by T2.
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium, type Browser, type BrowserContext } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import { withSuiteCatalogContentHash } from '../src/domain/suite-catalog-document.js'
import { DSH_CONTAINER_HOME, dshHomePath } from '../src/dsh/profile-layout.js'
import { signInCommunity } from './fixtures/community-native-browser.js'
import { removeCommunityFixture } from './fixtures/owned-cleanup.js'
import { documentSuiteCatalogFixture } from './fixtures/suite-catalog-server.js'
import { setAppCenterVisibility } from './support/app-center-visibility.js'
import { cookieHeader } from './support/real-dsh-rpc.js'
import { communityEntryUrl } from './support/community-space.js'
import { seedTestSecrets, withTestDatabase } from './support/community-application.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { assertPinnedDshRevision, memberSpacePath, runtimeSection } from './support/real-dsh-runtime.js'
import { validationDownloadSelection } from './support/validation-downloads.js'

const packageName = 'dsh-media-desk'
const version = '2.7.1'
const label = { en: 'Media Desk', 'zh-CN': '自媒体工作台' }
const settingsPath = 'plugins/services?packageName=' + packageName

export const mediaDeskCatalogEntry = withSuiteCatalogContentHash({
  kind: 'plugin',
  id: 'dsh-media-desk',
  version,
  engines: { platform: '>=0.1.36' },
  adapters: [],
  title: label,
  description: { en: 'Capture ideas and produce articles, covers, and storyboards.', 'zh-CN': '记录灵感，生成文案、封面和分镜。' },
  identity: label,
  source: { en: 'npm', 'zh-CN': 'npm' },
  dependencies: [],
  items: [
    {
      kind: 'plugin',
      packageName,
      version,
      integrity: 'sha512-1OtskslKgbKjV9Pa0lJjs6Em1rDnT2yFjXXNJpnTYaDNsFRXfbK82Or91Bj1k8ueQVsHQtL7hex54OP5Z+rFPQ==',
      runtimeDependencies: [],
      catalogDependencies: [],
      access: { environment: [], entriesYaml: '' },
      serviceSlots: [
        {
          id: 'image',
          label: { en: 'Image generation', 'zh-CN': '生图' },
          binding: {
            kind: 'json-settings',
            file: 'media-desk/settings.json',
            upstream: 'image-provider',
            fields: [
              { path: ['image', 'source'], source: 'literal', value: 'http' },
              { path: ['image', 'protocol'], source: 'literal', value: 'openai' },
              { path: ['image', 'baseUrl'], source: 'gateway-url' },
              { path: ['image', 'model'], source: 'model' },
              { path: ['image', 'apiKey'], source: 'service-token' },
            ],
          },
          backends: [
            {
              id: 'openai',
              label: { en: 'OpenAI-compatible', 'zh-CN': 'OpenAI 兼容' },
              protocol: 'openai-image',
              mode: 'api',
              upstream: { model: 'MODEL' },
              fields: [{ name: 'MODEL', type: 'text', required: true }],
            },
          ],
        },
      ],
    },
  ],
})

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error('Missing Media Desk acceptance input ' + name)
  return value
}

async function credential(name: string): Promise<string> {
  const path = required(name)
  const identity = await lstat(path)
  if (!identity.isFile() || (identity.mode & 0o777) !== 0o600) throw new Error('Invalid Media Desk credential file mode')
  const value = (await readFile(path, 'utf8')).trim()
  if (!value) throw new Error('Empty Media Desk credential')
  return value
}

it('configures both native Media Desk deliveries and produces a real exported draft', async () => {
  const installed = required('DSH_PHALANX_INSTALL_ROOT')
  const candidate = required('DSH_PHALANX_CANDIDATE_SHA')
  if (process.platform !== 'linux' || !runtimeSettings.containerImage) throw new Error('Use an installed Linux image')
  expect(JSON.parse(await readFile(join(installed, 'build-info.json'), 'utf8')).commit).toBe(candidate)
  assertPinnedDshRevision(runtimeSettings)
  const imageKey = await credential('DSH_PHALANX_MEDIA_IMAGE_KEY_FILE')
  const textKey = await credential('DSH_PHALANX_MEDIA_TEXT_KEY_FILE')
  const imageModel = required('DSH_PHALANX_MEDIA_IMAGE_MODEL')
  const textModel = required('DSH_PHALANX_MEDIA_TEXT_MODEL')
  const textUrl = required('DSH_PHALANX_MEDIA_TEXT_URL')
  const root = await mkdtemp(join(tmpdir(), 'community-media-desk-'))
  const runtime = runtimeSection(root, 'http://127.0.0.1:1', runtimeSettings)
  const owned: {
    fixture?: Awaited<ReturnType<typeof documentSuiteCatalogFixture>>
    app?: ReturnType<typeof import('../src/composition/community-application.js').createCommunityApplication>
    browser?: Browser
  } = {}
  onTestFinished(async () => {
    const cleanup = await Promise.allSettled([owned.browser?.close(), owned.app?.stop(), owned.fixture?.close()])
    const failures = cleanup.flatMap(result => (result.status === 'rejected' ? [result.reason] : []))
    for (const step of [() => new CommunityRuntimeDriver(runtime).rebuild(), () => removeCommunityFixture(root)]) {
      try {
        await step()
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length) throw new AggregateError(failures, 'Media Desk acceptance cleanup failed')
  })
  const config = withTestDatabase({ listen: { host: '127.0.0.1', port: 0 }, runtime, downloadSources: validationDownloadSelection() })
  const fixture = (owned.fixture = await documentSuiteCatalogFixture([mediaDeskCatalogEntry], new Map()))
  const { createCommunityApplication } = (await import(
    pathToFileURL(join(installed, 'dist/composition/community-application.js')).href
  )) as typeof import('../src/composition/community-application.js')
  await seedTestSecrets(config, installed)
  const app = (owned.app = createCommunityApplication(config, { suiteCatalog: { address: fixture.address, trustedKeys: fixture.trustedKeys } }))
  {
    const origin = (await app.start()).toString()
    const browser = (owned.browser = await chromium.launch({ headless: true }))
    const admin = await browser.newContext({ locale: 'en' })
    expect(
      (
        await admin.request.post(origin + '/bootstrap', {
          headers: { origin },
          form: { credential: readBootstrapCredential(root)!.credential, username: 'admin', password: 'password' },
          maxRedirects: 0,
        })
      ).status(),
    ).toBe(303)
    async function api<T = Record<string, unknown>>(path: string, data?: object): Promise<T> {
      const response = data
        ? await admin.request.post(origin + '/admin/api/' + path, { headers: { origin }, data })
        : await admin.request.get(origin + '/admin/api/' + path)
      if (!response.ok()) {
        const { code } = (await response.json().catch(() => ({}))) as { code?: string }
        throw Error(`Admin API ${path} returned ${response.status()}${code ? ' (' + code + ')' : ''}`)
      }
      return (await response.json()) as T
    }
    const models = await api<{ revision: number }>('models')
    await api('models', {
      revision: models.revision,
      action: 'save-provider',
      provider: {
        name: 'Media Desk text acceptance',
        baseUrl: textUrl,
        apiFormat: required('DSH_PHALANX_MEDIA_TEXT_FORMAT'),
        apiKey: textKey,
        enabled: true,
        models: [{ name: textModel, enabled: true }],
      },
    })
    const catalog = await api('suites')
    expect(catalog.source).toMatchObject({ status: 'ok' })
    expect(catalog.entries).toContainEqual(expect.objectContaining({ id: packageName, available: true }))
    await api('suites', { action: 'install', input: { id: packageName, requestId: 'media-desk-suite-install', publish: false } })
    const installation = async () =>
      (await api<{ installations: { id: string; status: string; failureCode: string | null }[] }>('suites')).installations.find(row => row.id === packageName)
    await expect.poll(async () => (await installation())?.status, { timeout: 240_000 }).toMatch(/^(installed|failed)$/u)
    const installedSuite = await installation()
    expect(installedSuite?.status, installedSuite?.failureCode ?? 'Media Desk suite installation').toBe('installed')
    await api('plugins/upstreams?packageName=' + packageName, {
      action: 'save',
      upstream: { name: 'image-provider', baseUrl: required('DSH_PHALANX_MEDIA_IMAGE_URL'), credential: imageKey, headers: [] },
    })
    await api(settingsPath, {
      revision: (await api(settingsPath)).revision,
      change: { action: 'save', slot: 'image', backend: 'openai', values: { MODEL: imageModel } },
    })
    await api(settingsPath, { revision: (await api(settingsPath)).revision, change: { action: 'enable', slot: 'image', backend: 'openai' } })
    await api('plugins/publication', { action: 'publish', packageName, published: true, confirmed: true })

    const selected = await api<{ groupId: string }>('accounts', { username: 'media-selected', password: 'password', email: '' })
    await setAppCenterVisibility(admin.request, origin, selected.groupId)
    const browserSession = async (username: string) => {
      const context = await browser.newContext({ locale: 'en' })
      const page = await context.newPage()
      await signInCommunity(page, origin, username, 'password')
      return { context, page }
    }
    const selectedBrowser = await browserSession('media-selected')
    const install = await selectedBrowser.context.request.post(origin + '/market/api/plugins', {
      headers: { origin },
      data: { action: 'install', packageName, requestId: 'media-desk-member-install' },
    })
    expect(install.status()).toBe(202)
    await expect
      .poll(
        async () => {
          const response = await selectedBrowser.context.request.get(origin + '/market/api/plugins')
          const { plugins } = (await response.json()) as { plugins: { packageName: string; job?: { status: string } }[] }
          return plugins.find(row => row.packageName === packageName)?.job?.status
        },
        { timeout: 180_000 },
      )
      .toBe('succeeded')
    const restart = async (context: BrowserContext) => {
      expect((await context.request.post(origin + '/recovery/restart', { headers: { origin }, data: { confirmed: true }, timeout: 300_000 })).ok()).toBe(true)
    }
    const home = async (username: string) => join(await memberSpacePath(root, username), 'home')
    const settingsDir = async (username: string) => join(dshHomePath(await home(username)), 'media-desk')
    const selectedSettings = await settingsDir('media-selected')
    await mkdir(selectedSettings, { recursive: true, mode: 0o700 })
    await chmod(selectedSettings, 0o500)
    try {
      await restart(selectedBrowser.context)
      await selectedBrowser.page.reload()
      const setup = await selectedBrowser.context.request.get(origin + '/market/api/plugins/setup')
      expect(await setup.json()).toMatchObject({ nativeServices: [{ packageName, bindings: [{ slot: 'image', status: 'failed' }] }] })
    } finally {
      await chmod(selectedSettings, 0o700)
    }
    await restart(selectedBrowser.context)
    await selectedBrowser.page.reload()
    const group = 'groups/' + selected.groupId + '/plugins'
    const preinstall = async (preinstalls: string[]) => await api(group, { action: 'save', revision: (await api(group)).revision, packages: [], preinstalls })
    await preinstall([packageName])
    await api('accounts', { username: 'media-preinstalled', password: 'password', email: '' })
    const preinstalledBrowser = await browserSession('media-preinstalled')

    const endpoint = async (context: BrowserContext, path: string) =>
      new URL('media-desk/' + path, communityEntryUrl(origin, await cookieHeader(context, origin))).href
    const call = async <T>(context: BrowserContext, path: string, data?: object): Promise<T> => {
      const url = await endpoint(context, path)
      const response = data ? await context.request.post(url, { headers: { origin }, data, timeout: 250_000 }) : await context.request.get(url)
      expect(response.ok(), 'Media Desk ' + path).toBe(true)
      return (await response.json()) as T
    }
    const load = (context: BrowserContext) => call<{ imageReady: boolean; image: { model: string; hasKey: boolean; keyHint: string } }>(context, 'settings')
    for (const { context, page } of [selectedBrowser, preinstalledBrowser]) {
      const ready = await load(context)
      expect(ready).toMatchObject({ imageReady: true, image: { model: imageModel, hasKey: true } })
      expect(JSON.stringify(ready).includes(imageKey)).toBe(false)
      await page.getByRole('button', { name: 'Media Desk', exact: true }).click()
    }
    const readProjection = async (username: string) => {
      const data = JSON.parse(await readFile(join(await settingsDir(username), 'settings.json'), 'utf8')) as { image: { apiKey: string; baseUrl: string } }
      expect(/^[A-Za-z0-9_-]{43}$/u.test(data.image.apiKey)).toBe(true)
      expect(data.image.apiKey === imageKey).toBe(false)
      return data.image
    }
    const selectedProjection = await readProjection('media-selected')
    const imageUrl = new URL(selectedProjection.baseUrl + '/images/generations')
    expect(imageUrl.protocol).toBe('http:')
    expect(imageUrl.hostname).toBe('127.0.0.1')
    expect(Boolean(imageUrl.username || imageUrl.password || imageUrl.search || imageUrl.hash)).toBe(false)
    expect(imageUrl.pathname.startsWith('/_dsh-phalanx/plugin-services/')).toBe(true)
    const generate = () =>
      fetch(imageUrl, {
        method: 'POST',
        redirect: 'error',
        headers: { authorization: 'Bearer ' + selectedProjection.apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({ model: imageModel, prompt: 'One paper boat on calm water', n: 1, size: '1536x1024' }),
        signal: AbortSignal.timeout(180_000),
      })
    const image = await generate()
    expect(image.status).toBe(200)
    const response = (await image.json()) as { data: { b64_json?: string }[] }
    expect(typeof response.data[0]?.b64_json).toBe('string')
    expect(Buffer.from(response.data[0]!.b64_json!, 'base64').byteLength).toBeGreaterThan(512)

    const { context, page } = preinstalledBrowser
    await call(context, 'settings', { imageCount: 1, shotCount: 0 })
    const draft = await call<{ modelOk: boolean; answer: { text?: string; content?: string } }>(context, 'chat', {
      message: 'Draft one short original headline and opening about a paper boat. Do not change any saved items.',
    })
    expect(draft.modelOk).toBe(true)
    expect(draft.answer.text?.trim().length).toBeGreaterThan(0)
    const item = await call<{ receipts: { target: string }[] }>(context, 'ops', {
      ops: [{ op: 'add_item', kind: 'note', title: 'Paper boat on a quiet morning', body: 'A paper boat becomes a small way to notice the river.' }],
    })
    const id = item.receipts[0]!.target
    await call(context, 'produce', { id, withImages: true })
    await expect
      .poll(async () => (await call<{ production: { status: string } }>(context, 'production?id=' + encodeURIComponent(id))).production.status, {
        timeout: 480_000,
      })
      .toBe('done')
    const exported = await call<{ path: string; files: string[]; hashes: Record<string, string> }>(context, 'produce/save', { id })
    expect(Boolean(exported.path)).toBe(true)
    expect(Object.keys(exported.hashes).length).toBeGreaterThan(0)
    const imageFile = exported.files.find(file => /\.(png|webp|jpe?g)$/iu.test(file))
    expect(imageFile).toBeDefined()
    const destination = relative(DSH_CONTAINER_HOME, exported.path)
    expect(destination.startsWith('..')).toBe(false)
    const exportHome = await realpath(await home('media-preinstalled'))
    const artifacts = async (name: string) => {
      expect(/^[^/\\]+$/u.test(name) && name !== '..' && name !== '.').toBe(true)
      const file = await realpath(join(exportHome, destination, name))
      expect(file.startsWith(exportHome + '/')).toBe(true)
      return file
    }
    expect((await stat(await artifacts(imageFile!))).size).toBeGreaterThan(512)
    const [textFile, expectedHash] = Object.entries(exported.hashes)[0]!
    const written = await readFile(await artifacts(textFile))
    expect(createHash('sha256').update(written).digest('hex')).toBe(expectedHash)

    const tokenDigest = async () =>
      createHash('sha256')
        .update((await readProjection('media-preinstalled')).apiKey)
        .digest('hex')
    const before = await tokenDigest()
    await restart(context)
    await page.reload()
    expect(await tokenDigest()).toBe(before)
    await call(context, 'settings', { image: { model: 'member-personal-model' } })
    await restart(context)
    await page.reload()
    expect((await load(context)).image.model).toBe('member-personal-model')
    expect(await api(settingsPath)).toMatchObject({ slots: [{ jsonSettings: { upstream: 'image-provider', personal: true } }] })
    await preinstall([])
    await api('plugins/publication', { action: 'publish', packageName, published: false, confirmed: true, selectedMembers: 0 })
    const denied = await generate()
    expect(denied.status).toBe(403)
    expect(await denied.json()).toMatchObject({
      error: { message: 'Platform service is no longer available to this plugin. Choose a service in the plugin settings.' },
    })
  }
}, 1_800_000)
