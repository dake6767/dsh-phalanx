import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium, type Page } from 'playwright'
import { expect } from 'vitest'
import { withTestDatabase } from './community-application.js'
import { execFileText } from '../../src/adapters/runtime-command.js'
import { readBootstrapCredential } from '../../src/adapters/bootstrap-credential.js'
import { CommunityRuntimeDriver } from '../../src/adapters/community-runtime-driver.js'
import { runtimeSection, assertPinnedDshRevision } from './real-dsh-runtime.js'
import { runtimeSettings } from './real-dsh-kit.js'
import { validationDownloadSelection } from './validation-downloads.js'
import { cookieHeader, createRealDshRpc } from './real-dsh-rpc.js'
import { latestHumanText, streamText } from './real-dsh-model.js'
import { signInCommunity } from '../fixtures/community-native-browser.js'
import { removeCommunityFixture } from '../fixtures/owned-cleanup.js'
import { fakeGithub } from './plugin-github.js'
import type { CommunityRuntimeConfig } from '../../src/domain/community-config.js'

async function fixture(holdFirstInstall: boolean, updateFixtures = false) {
  assertPinnedDshRevision(runtimeSettings)
  if (!runtimeSettings.containerImage || !process.env.DSH_PHALANX_INSTALL_ROOT) throw Error('Actual installed rootless DSH is required')
  const installed = process.env.DSH_PHALANX_INSTALL_ROOT
  const build = JSON.parse(await readFile(join(installed, 'build-info.json'), 'utf8'))
  expect(build.commit).toBe(process.env.DSH_PHALANX_CANDIDATE_SHA)
  expect(build.platform).toBe(`linux/${process.arch === 'arm64' ? 'arm64' : 'amd64'}`)
  const load = (path: string) => import(pathToFileURL(join(installed, 'dist', path + '.js')).href)
  const { createCommunityApplication } = (await load('composition/community-application')) as typeof import('./community-application.js')
  const root = await mkdtemp(join(tmpdir(), 'plugin-preinstall-')),
    captured = new Map<string, string[]>()
  const github = fakeGithub()
  const model = createServer(async (req, res) => {
    if (updateFixtures && (await github.handle(req, res))) return
    if (req.method !== 'POST') {
      res.writeHead(404).end()
      return
    }
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    captured.set(
      latestHumanText(body),
      (body.tools ?? []).map((row: { name: string }) => row.name),
    )
    res.setHeader('content-type', 'text/event-stream')
    streamText(res, 'PREINSTALL_READY')
  })
  model.listen(0, '127.0.0.1')
  await once(model, 'listening')
  const modelOrigin = `http://127.0.0.1:${(model.address() as { port: number }).port}`
  const runtime: CommunityRuntimeConfig = runtimeSection(join(root, 'platform'), modelOrigin, runtimeSettings)
  let release!: () => void,
    entered!: () => void,
    released = !holdFirstInstall
  const gate = new Promise<void>(resolve => {
      release = resolve
    }),
    started = new Promise<void>(resolve => {
      entered = resolve
    })
  const operations = new Set<Promise<unknown>>()
  const unblock = () => {
    released = true
    release()
  }
  const downloadSources = validationDownloadSelection()
  const updates = { beforeReplace: undefined as (() => Promise<void>) | undefined }
  const app = createCommunityApplication(
    withTestDatabase({
      listen: { host: '127.0.0.1', port: 0 },
      runtime,
      downloadSources: updateFixtures
        ? {
            ...downloadSources,
            overrides: { ...downloadSources.overrides, githubApi: modelOrigin + '/gh-api/', githubAssets: modelOrigin + '/gh-assets/' },
          }
        : downloadSources,
      network: { hostPublicAddresses: (process.env.DSH_PHALANX_E2E_HOST_PUBLIC_ADDRESSES ?? '').split(',').filter(Boolean) },
    }),
    {
      pluginManager: manager => ({
        list: manager.list.bind(manager),
        ...(manager.verifyArchive ? { verifyArchive: manager.verifyArchive.bind(manager) } : {}),
        ...(manager.replace
          ? {
              replace: async (...args: Parameters<NonNullable<typeof manager.replace>>) => {
                await updates.beforeReplace?.()
                return manager.replace!(...args)
              },
            }
          : {}),
        remove: manager.remove.bind(manager),
        install: async (...args) => {
          entered()
          if (!released) await gate
          const work = manager.install(...args)
          operations.add(work)
          try {
            return await work
          } finally {
            operations.delete(work)
          }
        },
      }),
    },
  )
  const browser = await chromium.launch({ headless: true }),
    admin = await browser.newPage({ locale: 'en' })
  admin.setDefaultTimeout(30000)
  let origin = ''
  const api = async (path: string, data?: object) => {
    const response = data
      ? await admin.request.post(origin + '/admin/api/' + path, { headers: { origin }, data })
      : await admin.request.get(origin + '/admin/api/' + path)
    expect(response.ok(), await response.text()).toBe(true)
    return response.json()
  }
  const rpc = createRealDshRpc('', (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(240000) }))
  const call = async <T>(page: Page, method: string, args: object) => rpc.remoteRpc<T>(origin, await cookieHeader(page.context(), origin), method, args)
  const bundles = (page: Page) => call<{ name: string; installed: boolean }[]>(page, 'pluginManager/listBundles', {})
  const plugins = (page: Page) =>
    call<{ moduleName: string; enabled: boolean; fiberPhase: string; readOnlyReason?: string }[]>(page, 'pluginManager/listPlugins', {})
  const present = async (page: Page, name: string) => (await bundles(page)).some(row => row.name === name && row.installed)
  const waitInstalled = async (page: Page, name: string) => {
    await expect.poll(() => present(page, name), { timeout: 180000 }).toBe(true)
    await Promise.all([...operations])
    await bundles(page)
  }
  const signIn = async (username: string) => {
    const page = await browser.newPage({ locale: 'en' })
    page.setDefaultTimeout(30000)
    await signInCommunity(page, origin, username, 'password')
    return page
  }
  const restart = async (page: Page, username: string) => {
    expect((await page.request.post(origin + '/recovery/restart', { headers: { origin }, data: { confirmed: true }, timeout: 120000 })).status()).toBe(200)
    await signInCommunity(page, origin, username, 'password')
  }
  const configure = async (groupId: string, preinstalls: readonly string[], packages: readonly string[] = []) => {
    const path = `groups/${groupId}/plugins`,
      current = await api(path)
    await api(path, { action: 'save', packages, preinstalls, revision: current.revision })
  }
  const pack = async (suffix: string, version = '1.0.0', replace = false) => {
    const name = '@example/preinstall-' + suffix,
      directory = join(root, 'package-' + suffix)
    await mkdir(join(directory, 'patches'), { recursive: true })
    await writeFile(
      join(directory, 'package.json'),
      JSON.stringify({ name, version, type: 'module', main: './plugin.mjs', dsh: { bundle: { patch: './patches/main.yml' } } }),
    )
    await writeFile(join(directory, 'patches/main.yml'), JSON.stringify([{ insert: [{ id: 'preinstall-worker-' + suffix, name: '../plugin.mjs' }] }]))
    await writeFile(
      join(directory, 'plugin.mjs'),
      `import {appendFileSync} from 'node:fs';import {join} from 'node:path';export const name='preinstall-${suffix}';export const inject=['tools'];export function apply(ctx){appendFileSync(join(process.env.HOME,'preinstall-${suffix}.log'),import.meta.url+'\\n');ctx.tools.register({name:'preinstall_${suffix}',description:'Preinstall fixture',parameters:{type:'object',properties:{}},output:{schema:{type:'object'},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},execute:async()=>({ready:true})})}`,
    )
    const packed = JSON.parse(await execFileText('npm', ['pack', directory, '--ignore-scripts', '--json', '--pack-destination', root])) as {
      filename: string
    }[]
    const response = await admin.request.post(origin + '/admin/api/plugins/upload', {
      headers: { origin, 'content-type': 'application/gzip', 'x-plugin-filename': 'preinstall.tgz', ...(replace ? { 'x-plugin-replace-package': name } : {}) },
      data: await readFile(join(root, packed[0]!.filename)),
    })
    expect(response.status(), await response.text()).toBe(202)
    const stage = async () => {
      const row = (await api('plugins')).find((row: { packageName: string }) => row.packageName === name)
      return replace ? row?.replacement?.stage : row?.stage
    }
    await expect.poll(stage, { timeout: 180000 }).toMatch(/^(available|failed)$/u)
    expect(await stage()).toBe('available')
    return name
  }
  const prompt = async (page: Page, agentPreset: string, tools: string | readonly string[]) => {
    const session = await call<{ sessionId: string }>(page, 'session/create', { request: { cwd: '/dsh-phalanx/workspace', agentPreset } }),
      marker = randomUUID()
    await call(page, 'session/prompt', {
      request: { requestId: randomUUID(), sessionId: session.sessionId, mode: 'queue', content: [{ type: 'text', text: marker }] },
    })
    await expect.poll(() => captured.has(marker), { timeout: 30000 }).toBe(true)
    for (const tool of typeof tools === 'string' ? [tools] : tools) expect(captured.get(marker)!.filter(name => name === tool)).toHaveLength(1)
    await expect
      .poll(
        async () =>
          (await call<{ items: { sessionId: string; running: boolean }[] }>(page, 'session/list', { _request: {} })).items.find(
            row => row.sessionId === session.sessionId,
          )?.running,
        { timeout: 30000 },
      )
      .toBe(false)
    return captured.get(marker)!
  }
  const close = async () => {
    unblock()
    const errors: unknown[] = []
    let stopped = false,
      rebuilt = false
    for (const operation of [
      () => browser.close(),
      async () => {
        await app.stop()
        stopped = true
      },
      async () => {
        await new CommunityRuntimeDriver(runtime).rebuild()
        rebuilt = true
      },
      () =>
        new Promise<void>((resolve, reject) =>
          model.close(error => {
            if (error) reject(error)
            else resolve()
          }),
        ),
      async () => {
        if (stopped && rebuilt) await removeCommunityFixture(root)
      },
    ]) {
      try {
        await operation()
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length) throw new AggregateError(errors, 'Preinstall acceptance cleanup failed')
  }
  try {
    origin = await app.start()
    const response = await admin.request.post(origin + '/bootstrap', {
      headers: { origin },
      form: { credential: readBootstrapCredential(runtime.dataRoot)!.credential, username: 'admin', password: 'password' },
      maxRedirects: 0,
    })
    expect(response.status()).toBe(303)
    const models = await api('models')
    await api('models', {
      revision: models.revision,
      action: 'save-provider',
      provider: {
        name: 'Fixture',
        baseUrl: modelOrigin + '/anthropic',
        apiFormat: 'anthropic-messages',
        apiKey: 'fictional-model-key',
        enabled: true,
        models: [{ name: 'fixture', enabled: true }],
      },
    })
    return {
      root,
      runtime,
      origin,
      api,
      admin,
      signIn,
      call,
      bundles,
      plugins,
      present,
      waitInstalled,
      restart,
      configure,
      pack,
      prompt,
      started,
      unblock,
      close,
      updates,
      github,
    }
  } catch (error) {
    try {
      await close()
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'Preinstall setup and cleanup failed')
    }
    throw error
  }
}

export async function withPreinstallFixture(
  holdFirstInstall: boolean,
  check: (environment: Awaited<ReturnType<typeof fixture>>) => Promise<void>,
  updateFixtures = false,
) {
  const environment = await fixture(holdFirstInstall, updateFixtures)
  let primary: unknown
  try {
    await check(environment)
  } catch (error) {
    primary = error
  }
  try {
    await environment.close()
  } catch (cleanup) {
    if (primary !== undefined) throw new AggregateError([primary, cleanup], 'Preinstall acceptance and cleanup failed')
    throw cleanup
  }
  if (primary !== undefined) throw primary
}
