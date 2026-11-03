// Validation: T2; real credentials: none; exact installed modules, actual rootless DSH and checked archives.
import { effectiveUserDataRoot } from '../src/domain/storage-layout.js'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { copyFile, readdir, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium, type Page } from 'playwright'
import { expect, it } from 'vitest'
import { withTestDatabase } from './support/community-application.js'
import { execFileText } from '../src/adapters/runtime-command.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import { runtimeSection, assertPinnedDshRevision } from './support/real-dsh-runtime.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { validationDownloadSelection } from './support/validation-downloads.js'
import { communityEntryUrl } from './support/community-space.js'
import { cookieHeader, createRealDshRpc, rpcBody } from './support/real-dsh-rpc.js'
import { latestHumanText, streamText } from './support/real-dsh-model.js'
import { signInCommunity } from './fixtures/community-native-browser.js'
import type { CommunityRuntimeConfig } from '../src/domain/community-config.js'
import { removeCommunityFixture } from './fixtures/owned-cleanup.js'

async function fixture(holdFirstInstall: boolean) {
  assertPinnedDshRevision(runtimeSettings)
  if (!runtimeSettings.containerImage || !process.env.DSH_PHALANX_INSTALL_ROOT) throw Error('Actual installed rootless DSH is required')
  const installed = process.env.DSH_PHALANX_INSTALL_ROOT
  const build = JSON.parse(await readFile(join(installed, 'build-info.json'), 'utf8'))
  expect(build.commit).toBe(process.env.DSH_PHALANX_CANDIDATE_SHA)
  expect(build.platform).toBe(`linux/${process.arch === 'arm64' ? 'arm64' : 'amd64'}`)
  const load = (path: string) => import(pathToFileURL(join(installed, 'dist', path + '.js')).href)
  const { createCommunityApplication } = (await load('composition/community-application')) as typeof import('./support/community-application.js')
  const root = await mkdtemp(join(tmpdir(), 'plugin-preinstall-')),
    captured = new Map<string, string[]>()
  const model = createServer(async (req, res) => {
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
  const app = createCommunityApplication(
    withTestDatabase({
      listen: { host: '127.0.0.1', port: 0 },
      runtime,
      downloadSources: validationDownloadSelection(),
      network: { hostPublicAddresses: (process.env.DSH_PHALANX_E2E_HOST_PUBLIC_ADDRESSES ?? '').split(',').filter(Boolean) },
    }),
    {
      pluginManager: manager => ({
        list: manager.list.bind(manager),
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
  const pack = async (suffix: string) => {
    const name = '@example/preinstall-' + suffix,
      directory = join(root, 'package-' + suffix)
    await mkdir(join(directory, 'patches'), { recursive: true })
    await writeFile(
      join(directory, 'package.json'),
      JSON.stringify({ name, version: '1.0.0', type: 'module', main: './plugin.mjs', dsh: { bundle: { patch: './patches/main.yml' } } }),
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
      headers: { origin, 'content-type': 'application/gzip', 'x-plugin-filename': 'preinstall.tgz' },
      data: await readFile(join(root, packed[0]!.filename)),
    })
    expect(response.status(), await response.text()).toBe(202)
    await expect
      .poll(async () => (await api('plugins')).find((row: { packageName: string }) => row.packageName === name)?.stage, { timeout: 180000 })
      .toMatch(/^(available|failed)$/u)
    expect((await api('plugins')).find((row: { packageName: string }) => row.packageName === name)).toMatchObject({ stage: 'available' })
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

async function withFixture(holdFirstInstall: boolean, check: (environment: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const environment = await fixture(holdFirstInstall)
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

it(
  'coexists native selections and preinstalls with shared and controlled read-only plugins, preserves shelf and uninstall decisions, and restores only preinstalls through both reset entries',
  async () =>
    withFixture(true, async f => {
      const assertPluginDirectories = async () => {
        const entries = await readdir(join(f.runtime.dataRoot, 'plugins'), { withFileTypes: true })
        expect(
          entries.filter(entry => !entry.isDirectory() || !['artifacts', 'uploads', 'staging', 'instances'].includes(entry.name)).map(entry => entry.name),
        ).toEqual([])
      }
      const pre = await f.pack('pre'),
        kept = await f.pack('kept'),
        selected = await f.pack('selected'),
        other = await f.pack('other')
      const shared = await f.pack('shared'),
        managed = await f.pack('managed')
      await f.api('plugins/upstreams?packageName=' + encodeURIComponent(shared), {
        action: 'save',
        upstream: { name: 'shared', baseUrl: 'https://example.test', credential: 'fictional-shared-key', headers: [] },
      })
      for (const packageName of [pre, selected, shared])
        await f.api('plugins/publication', { action: 'publish', packageName, published: true, confirmed: true })
      const account = await f.api('accounts', { username: 'alice', password: 'password', email: '' })
      await f.configure(account.groupId, [pre, kept], [managed])
      const alice = await f.signIn('alice')
      await f.started
      // The real entry is usable while the installed native-manager port is held.
      await alice.getByRole('button', { name: /^Platform account:/u }).waitFor()
      expect(await f.present(alice, pre)).toBe(false)
      f.unblock()
      await f.waitInstalled(alice, pre)
      await f.waitInstalled(alice, kept)
      await expect
        .poll(
          async () => (await f.plugins(alice)).filter(row => row.moduleName.includes('/preinstall-pre/') && row.enabled && row.fiberPhase === 'active').length,
          { timeout: 30000 },
        )
        .toBe(1)
      expect(
        (
          await alice.request.post(f.origin + '/market/api/plugins', {
            headers: { origin: f.origin },
            data: { action: 'install', packageName: selected, requestId: 'selected-copy' },
          })
        ).status(),
      ).toBe(202)
      await f.waitInstalled(alice, selected)
      expect(
        (
          await alice.request.post(f.origin + '/market/api/plugins', { headers: { origin: f.origin }, data: { action: 'install', packageName: shared } })
        ).status(),
      ).toBe(200)
      await f.restart(alice, 'alice')
      const tools = ['preinstall_pre', 'preinstall_selected', 'preinstall_shared', 'preinstall_managed']
      const coexist = async () => {
        await f.prompt(alice, 'standard', tools)
        for (const name of [pre, selected]) expect(await f.present(alice, name)).toBe(true)
        const rows = await f.plugins(alice)
        for (const name of [shared, managed])
          expect(rows.find(row => row.moduleName.includes(`/node_modules/${name}/`))).toMatchObject({ fiberPhase: 'active', readOnlyReason: 'unaddressable' })
        for (const suffix of ['pre', 'selected'])
          expect(await readFile(join(effectiveUserDataRoot(f.runtime), `alice/home/preinstall-${suffix}.log`), 'utf8')).toContain('/.dsh/profiles/web/')
        for (const suffix of ['shared', 'managed']) {
          const runs = await readFile(join(effectiveUserDataRoot(f.runtime), `alice/home/preinstall-${suffix}.log`), 'utf8')
          expect(runs).toContain('/dsh-phalanx/artifacts/')
          expect(runs).not.toContain('/.dsh/profiles/web/')
        }
      }
      await coexist()
      await assertPluginDirectories()
      const market = await (await alice.request.get(f.origin + '/market/api/plugins')).json()
      for (const name of [pre, selected]) {
        const row = market.plugins.find((row: { packageName: string }) => row.packageName === name)
        expect(row).toMatchObject({ status: 'installed' })
        expect(row).not.toHaveProperty('sharedCredential')
      }
      expect(market.plugins.find((row: { packageName: string }) => row.packageName === shared)).toMatchObject({ status: 'selected', sharedCredential: true })
      expect(market.plugins.find((row: { packageName: string }) => row.packageName === managed)).toMatchObject({ status: 'managed' })
      await alice.getByRole('button', { name: 'Platform App Center', exact: true }).click()
      const panel = alice.getByRole('region', { name: 'Platform App Center', exact: true })
      const card = (name: string) => panel.locator('.phalanx-market-row').filter({ has: alice.getByRole('heading', { name, exact: true }) })
      await card(managed).getByText('Platform controlled, cannot uninstall', { exact: true }).waitFor()
      expect(await card(managed).getByRole('button', { name: 'Installed', exact: true }).isDisabled()).toBe(true)
      await card(shared).getByText('Platform shared KEY', { exact: true }).waitFor()
      expect(await card(shared).getByRole('button', { name: 'Uninstall', exact: true }).isEnabled()).toBe(true)
      for (const name of [pre, selected]) {
        expect(await card(name).getByRole('button', { name: 'Uninstall', exact: true }).isEnabled()).toBe(true)
        expect(await card(name).getByText('Platform shared KEY', { exact: true }).count()).toBe(0)
        expect(await card(name).getByText('Platform controlled, cannot uninstall', { exact: true }).count()).toBe(0)
      }
      expect(
        (
          await alice.request.post(f.origin + '/market/api/plugins', { headers: { origin: f.origin }, data: { action: 'uninstall', packageName: managed } })
        ).status(),
      ).toBe(409)
      const managedModule = (await f.plugins(alice)).find(row => row.moduleName.includes(`/node_modules/${managed}/`))!.moduleName
      expect(await f.call(alice, 'pluginManager/removeBundle', { name: managedModule })).toMatchObject({ application: 'failed' })
      await coexist()
      await assertPluginDirectories()
      for (const packageName of [pre, selected])
        await f.api('plugins/publication', { action: 'publish', packageName, published: false, confirmed: true, selectedMembers: 0 })
      const afterShelf = await (await alice.request.get(f.origin + '/market/api/plugins')).json()
      expect(afterShelf.plugins.filter((row: { packageName: string }) => [pre, selected].includes(row.packageName))).toEqual([])
      await f.restart(alice, 'alice')
      await coexist()
      await assertPluginDirectories()
      await f.call(alice, 'pluginManager/removeBundle', { name: pre })
      expect(await f.present(alice, pre)).toBe(false)
      await f.restart(alice, 'alice')
      expect(await f.present(alice, pre)).toBe(false)
      expect(await f.present(alice, selected)).toBe(true)
      await f.configure(account.groupId, [])
      await f.restart(alice, 'alice')
      expect(await f.present(alice, kept)).toBe(true)
      await f.configure(account.groupId, [pre, kept])
      await f.restart(alice, 'alice')
      expect(await f.present(alice, pre)).toBe(false)
      await f.api('groups', { action: 'create', name: 'Next group' })
      const next = (await f.api('groups')).find((row: { name: string }) => row.name === 'Next group')
      await f.configure(next.id, [other])
      await f.api('accounts/alice/actions', { action: 'set-email', email: '', groupId: next.id })
      await f.restart(alice, 'alice')
      await f.waitInstalled(alice, other)
      expect(await f.present(alice, selected)).toBe(true)
      expect(await f.present(alice, kept)).toBe(true)
      expect(
        (
          await f.admin.request.post(f.origin + '/admin/api/accounts/alice/reset-environment', {
            headers: { origin: f.origin },
            data: { confirmed: true },
            timeout: 120000,
          })
        ).status(),
      ).toBe(200)
      await signInCommunity(alice, f.origin, 'alice', 'password')
      await f.waitInstalled(alice, other)
      expect(await f.present(alice, selected)).toBe(false)
      expect(await f.present(alice, pre)).toBe(false)
      await f.call(alice, 'pluginManager/removeBundle', { name: other })
      expect(await f.present(alice, other)).toBe(false)
      const reset = await alice.request.post(f.origin + '/recovery/reset', { headers: { origin: f.origin }, data: { confirmed: true }, timeout: 120000 })
      expect(reset.status(), await reset.text()).toBe(200)
      await signInCommunity(alice, f.origin, 'alice', 'password')
      await f.waitInstalled(alice, other)
      expect(await f.present(alice, selected)).toBe(false)
      await f.configure(next.id, [other, selected])
      await f.restart(alice, 'alice')
      expect(await f.present(alice, selected)).toBe(false)
      await assertPluginDirectories()
    }),
  600000,
)

it(
  'installs once beneath shared selections and scoped experts, then releases native copies without overwriting member enablement',
  async () =>
    withFixture(false, async f => {
      const shared = await f.pack('shared'),
        expertPackage = await f.pack('expert')
      await f.api('plugins/upstreams?packageName=' + encodeURIComponent(shared), {
        action: 'save',
        upstream: { name: 'shared', baseUrl: 'https://example.test', credential: 'fictional-shared-key', headers: [] },
      })
      await f.api('plugins/publication', { action: 'publish', packageName: shared, published: true, confirmed: true })
      const account = await f.api('accounts', { username: 'alice', password: 'password', email: '' }),
        alice = await f.signIn('alice')
      expect(
        (
          await alice.request.post(f.origin + '/market/api/plugins', { headers: { origin: f.origin }, data: { action: 'install', packageName: shared } })
        ).status(),
      ).toBe(200)
      await f.configure(account.groupId, [shared])
      await f.restart(alice, 'alice')
      await f.waitInstalled(alice, shared)
      expect((await f.api(`groups/${account.groupId}/plugins`)).preinstallIncompleteMembers).toBe(0)
      const market = await (await alice.request.get(f.origin + '/market/api/plugins')).json()
      expect(market.plugins.find((row: { packageName: string }) => row.packageName === shared)).toMatchObject({ status: 'selected', sharedCredential: true })
      await f.prompt(alice, 'standard', 'preinstall_shared')
      const sharedRuns = await readFile(join(effectiveUserDataRoot(f.runtime), 'alice/home/preinstall-shared.log'), 'utf8')
      expect(sharedRuns).toContain('/dsh-phalanx/artifacts/')
      expect(sharedRuns).not.toContain('/.dsh/profiles/web/')
      expect(
        (
          await alice.request.post(f.origin + '/market/api/plugins', { headers: { origin: f.origin }, data: { action: 'uninstall', packageName: shared } })
        ).status(),
      ).toBe(200)
      expect(await f.present(alice, shared)).toBe(true)
      await f.restart(alice, 'alice')
      await f.prompt(alice, 'standard', 'preinstall_shared')
      expect(await readFile(join(effectiveUserDataRoot(f.runtime), 'alice/home/preinstall-shared.log'), 'utf8')).toContain('/.dsh/profiles/web/')
      await f.call(alice, 'pluginManager/removeBundle', { name: shared })
      await f.restart(alice, 'alice')
      expect(await f.present(alice, shared)).toBe(false)
      await f.api('groups', { action: 'create', name: 'Experts' })
      const group = (await f.api('groups')).find((row: { name: string }) => row.name === 'Experts')
      await f.api('accounts', { username: 'bob', password: 'password', email: '', groupId: group.id })
      let experts = await f.api('experts')
      await f.api('experts', {
        revision: experts.revision,
        expert: {
          name: 'Preinstall expert',
          description: 'Scoped fixture',
          icon: '',
          persona: 'Use the fixture.',
          plugins: [expertPackage],
          skills: [],
          skillPacks: [],
          mcp: [],
        },
      })
      experts = await f.api('experts')
      const expert = experts.experts.find((row: { name: string }) => row.name === 'Preinstall expert')
      const path = `groups/${group.id}/experts`,
        grant = await f.api(path)
      await f.api(path, { names: [expert.id], revision: grant.revision, confirmed: true })
      await f.configure(group.id, [expertPackage])
      const bob = await f.signIn('bob')
      await f.waitInstalled(bob, expertPackage)
      expect((await f.api(`groups/${group.id}/plugins`)).preinstallIncompleteMembers).toBe(0)
      await f.prompt(bob, 'phalanx-expert-' + expert.id, 'preinstall_expert')
      const expertRuns = await readFile(join(effectiveUserDataRoot(f.runtime), 'bob/home/preinstall-expert.log'), 'utf8')
      expect(expertRuns).toContain('/dsh-phalanx/artifacts/')
      expect(expertRuns).not.toContain('/.dsh/profiles/web/')
      // An explicit native bundle disable must survive release of the readonly qualification.
      await f.call(bob, 'pluginManager/setBundleEnabled', { name: expertPackage, enabled: false })
      await f.api(path, { names: [], revision: (await f.api(path)).revision, confirmed: true })
      await f.restart(bob, 'bob')
      expect(await f.present(bob, expertPackage)).toBe(true)
      expect((await f.plugins(bob)).filter(row => row.moduleName.includes('/preinstall-expert/') && row.enabled && row.fiberPhase === 'active')).toEqual([])
      await f.call(bob, 'pluginManager/setBundleEnabled', { name: expertPackage, enabled: true })
      await f.prompt(bob, 'standard', 'preinstall_expert')
    }),
  600000,
)

it(
  'keeps platform native installation available in both group states while refusing member installation and preserving optional-bundle history',
  async () =>
    withFixture(false, async f => {
      const pre = await f.pack('feature-pre'),
        selected = await f.pack('feature-selected'),
        native = await f.pack('feature-native'),
        controlled = await f.pack('feature-controlled')
      await f.api('plugins/publication', { action: 'publish', packageName: selected, published: true, confirmed: true })
      const feature = async (groupId: string, enabled: boolean) => {
        const path = `groups/${groupId}/native-features`,
          current = await f.api(path)
        await f.api(path, { revision: current.revision, disabledIds: enabled ? [] : ['plugin-install'] })
      }
      const language = async (page: Page, preference: string) => {
        const { namespaces } = await f.call<{ namespaces: { ns: string; revision: number }[] }>(page, 'settings/describe', {})
        const locale = namespaces.find(row => row.ns === 'locale')!
        return f.call(page, 'settings/update', { ns: 'locale', patch: { preference }, expectedRevision: locale.revision })
      }
      const result = async (page: Page, method: string, args: object) =>
        createRealDshRpc().remoteRpcResult(f.origin, await cookieHeader(page.context(), f.origin), method, args)
      for (const enabled of [false, true]) {
        const username = enabled ? 'allowed' : 'restricted'
        await f.api('groups', { action: 'create', name: username })
        const group = (await f.api('groups')).find((row: { name: string }) => row.name === username)
        await f.api('accounts', { username, password: 'password', email: '', groupId: group.id })
        const page = await f.signIn(username)
        const optional = await f.call<{ name: string; enabled: boolean; installed: boolean; official: boolean; optional: boolean }[]>(
          page,
          'pluginManager/listBundles',
          {},
        )
        const terminal = optional.find(row => row.name === '@deepseek-ai/dsh-experimental-terminal-bundle')!
        expect(terminal).toBeDefined()
        expect(await f.call(page, 'pluginManager/setBundleEnabled', { name: terminal.name, enabled: true })).toMatchObject({ application: 'applied' })
        expect(await f.call(page, 'pluginManager/setBundleEnabled', { name: terminal.name, enabled: false })).toMatchObject({ application: 'applied' })
        const never = optional.find(row => row.official && row.optional && !row.enabled && !row.installed && row.name !== terminal.name)
        expect(never, 'The pinned DSH must offer a never-enabled optional bundle').toBeDefined()
        await feature(group.id, enabled)
        await f.configure(group.id, [pre], [controlled])
        await f.restart(page, username)
        await f.waitInstalled(page, pre)
        expect(
          (await f.plugins(page)).some(
            row => row.moduleName.includes('/preinstall-feature-controlled/') && row.fiberPhase === 'active' && row.readOnlyReason === 'unaddressable',
          ),
        ).toBe(true)
        const selfSelect = await page.request.post(f.origin + '/market/api/plugins', {
          headers: { origin: f.origin },
          data: { action: 'install', packageName: selected, requestId: username + '-selected' },
        })
        expect(selfSelect.status(), await selfSelect.text()).toBe(202)
        await f.waitInstalled(page, selected)
        for (const name of [pre, selected]) {
          expect(await f.call(page, 'pluginManager/setBundleEnabled', { name, enabled: false })).toMatchObject({ application: 'applied' })
          expect(await f.call(page, 'pluginManager/setBundleEnabled', { name, enabled: true })).toMatchObject({ application: 'applied' })
        }
        expect(await f.call(page, 'pluginManager/setBundleEnabled', { name: terminal.name, enabled: true })).toMatchObject({ application: 'applied' })
        await f.call(page, 'pluginManager/setBundleEnabled', { name: terminal.name, enabled: false })
        if (!enabled) {
          expect(await result(page, 'pluginManager/setBundleEnabled', { name: never!.name, enabled: true })).toMatchObject({
            ok: false,
            error: { code: 'remote-access/denied' },
          })
          for (const spec of ['fixture-package', 'git+https://example.test/plugin.git', '/dsh-phalanx/home/package.tgz'])
            expect(await result(page, 'pluginManager/installBundle', { spec })).toMatchObject({
              ok: false,
              error: { code: 'remote-access/denied', message: 'The platform has disabled adding plugins. Contact your administrator.' },
            })
          await language(page, 'zh')
          expect(await result(page, 'pluginManager/installBundle', { spec: native })).toMatchObject({
            ok: false,
            error: { message: '平台已禁用自行添加插件，请联系管理员' },
          })
          await language(page, 'en')
          const cookie = await cookieHeader(page.context(), f.origin)
          const response = await page.request.post(communityEntryUrl(f.origin, cookie) + 'api/phalanx/native-plugins/install', {
            headers: { origin: f.origin, cookie, 'content-type': 'application/json' },
            data: rpcBody('pluginManager/installBundle', { spec: native }),
          })
          expect(response.status()).toBe(200)
          expect(await response.json()).toMatchObject({ result: { ok: false, error: { code: 'remote-access/denied' } } })
        } else {
          const home = join(effectiveUserDataRoot(f.runtime), username, 'home')
          await copyFile(join(f.root, 'example-preinstall-feature-native-1.0.0.tgz'), join(home, 'native-fixture.tgz'))
          expect(
            await f.call(page, 'pluginManager/installBundle', { spec: '/dsh-phalanx/home/native-fixture.tgz', options: { requestId: 'native-allowed' } }),
          ).toMatchObject({ application: 'applied' })
          expect(await f.present(page, native)).toBe(true)
          await f.call(page, 'pluginManager/removeBundle', { name: native })
        }
        const creatorTools = await f.prompt(page, 'cordis', [])
        expect(creatorTools.includes('plugin_manager')).toBe(enabled)
        // Custom-market supply is independently unavailable in both states.
        expect(creatorTools.includes('plugin_market')).toBe(false)
        await f.call(page, 'pluginManager/removeBundle', { name: selected })
        expect(await f.present(page, selected)).toBe(false)
        await f.restart(page, username)
        expect(await f.call(page, 'pluginManager/setBundleEnabled', { name: terminal.name, enabled: true })).toMatchObject({ application: 'applied' })
        await page.close()
      }
      console.log('native-plugin-feature-acceptance: business assertions completed')
    }),
  600000,
)
