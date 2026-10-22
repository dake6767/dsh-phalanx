// Validation: T2; real credentials: none; actual installed modules, private gateway and rootless member DSH.
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import type { CommunityRuntimeConfig } from '../src/domain/community-config.js'
import type { CommunityUserInstance } from '../src/ports/community-runtime.js'
import type { CommunityPluginView } from '../src/domain/admin-contract.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { execFileText } from '../src/adapters/runtime-command.js'
import { DSH_CONTAINER_PROFILE } from '../src/dsh/profile-layout.js'
import { declaredRuntimeRevision } from '../src/adapters/runtime-revision.js'
import { runtimeSection, assertPinnedDshRevision } from './support/real-dsh-runtime.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { validationDownloadSelection } from './support/validation-downloads.js'
import { signInCommunity } from './fixtures/community-native-browser.js'
import { cookieHeader, createRealDshRpc } from './support/real-dsh-rpc.js'

it.skipIf(!runtimeSettings.containerImage)('installs retained private bytes into a native profile and removes the real dependency and native page entry', async () => {
  assertPinnedDshRevision(runtimeSettings)
  const installed = process.env.DSH_PHALANX_INSTALL_ROOT
  if (!installed) throw Error('Installed platform modules are required')
  const build = JSON.parse(await readFile(join(installed, 'build-info.json'), 'utf8'))
  expect(build.commit).toBe(process.env.DSH_PHALANX_CANDIDATE_SHA)
  expect(build.platform).toBe(`linux/${process.arch === 'arm64' ? 'arm64' : 'amd64'}`)
  const module = (path: string) => import(pathToFileURL(join(installed, 'dist', path + '.js')).href)
  const { createCommunityApplication } = await module('composition/community-application') as typeof import('../src/composition/community-application.js')
  const { NativeMemberPluginManager } = await module('adapters/member-plugin-manager') as typeof import('../src/adapters/member-plugin-manager.js')
  const { MemberNativePlugins } = await module('use-cases/member-native-plugins') as typeof import('../src/use-cases/member-native-plugins.js')
  const { NativePluginDownloads } = await module('use-cases/native-plugin-downloads') as typeof import('../src/use-cases/native-plugin-downloads.js')
  const { SignedPluginDownloadTokens } = await module('adapters/plugin-download-tokens') as typeof import('../src/adapters/plugin-download-tokens.js')
  const { FilePluginLibraryStore } = await module('adapters/plugin-library-store') as typeof import('../src/adapters/plugin-library-store.js')
  const { CommunityAccountStore } = await module('adapters/community-account-store') as typeof import('../src/adapters/community-account-store.js')
  const { CommunityRuntimeDriver } = await module('adapters/community-runtime-driver') as typeof import('../src/adapters/community-runtime-driver.js')
  const { resolveDownloadSources } = await module('domain/download-source') as typeof import('../src/domain/download-source.js')
  const root = await mkdtemp(join(tmpdir(), 'native-plugin-install-')), runtime: CommunityRuntimeConfig = runtimeSection(join(root, 'data'), 'https://example.test', runtimeSettings)
  const selection = validationDownloadSelection(), secret = 'native-install-acceptance-fictional-secret', manager = new NativeMemberPluginManager(runtime)
  const instances = new Map<string, CommunityUserInstance>()
  const app = createCommunityApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: secret, runtime, downloadSources: selection,
    network: { hostPublicAddresses: (process.env.DSH_PHALANX_E2E_HOST_PUBLIC_ADDRESSES ?? '').split(',').filter(Boolean) } }, {
    pluginManager: { list: async (instance, origin, signal) => { instances.set(instance.userId, instance); return manager.list(instance, origin, signal) } },
  })
  const browser = await chromium.launch({ headless: true }), page = await browser.newPage({ locale: 'en' }); page.setDefaultTimeout(30000)
  const packageName = '@example/native-seam', directory = join(root, 'package'), rpc = createRealDshRpc()
  let accounts: InstanceType<typeof CommunityAccountStore> | undefined, primaryFailure: unknown
  const cleanupErrors: unknown[] = []
  try {
    const origin = await app.start(), publicOrigin = new URL(origin)
    const bootstrap = await page.request.post(origin + '/bootstrap', { headers: { origin }, form: { credential: readBootstrapCredential(runtime.dataRoot)!.credential, username: 'admin', password: 'password' }, maxRedirects: 0 })
    expect(bootstrap.status()).toBe(303)
    const api = async (path: string, data?: object) => {
      const response = data ? await page.request.post(origin + '/admin/api/' + path, { headers: { origin }, data }) : await page.request.get(origin + '/admin/api/' + path)
      expect(response.ok(), await response.text()).toBe(true); return response.json()
    }
    for (const username of ['alice', 'bob']) await api('accounts', { username, password: 'password', email: '' })
    await mkdir(directory)
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name: packageName, version: '1.0.0', type: 'module', main: './index.js', dsh: { bundle: { patch: './patch.yml' } } }))
    await writeFile(join(directory, 'index.js'), "import {writeFileSync} from 'node:fs';import {join} from 'node:path';export const name='native-seam';export function apply(){writeFileSync(join(process.env.HOME,'NATIVE_SEAM_READY'),'ready')}\n")
    await writeFile(join(directory, 'patch.yml'), JSON.stringify([{ insert: [{ id: 'native-seam', name: packageName }] }]))
    const packed = JSON.parse(await execFileText('npm', ['pack', directory, '--ignore-scripts', '--json', '--pack-destination', root])) as { filename: string }[]
    const bytes = await readFile(join(root, packed[0]!.filename))
    const upload = await page.request.post(origin + '/admin/api/plugins/upload', { headers: { origin, 'content-type': 'application/gzip', 'x-plugin-filename': 'native.tgz' }, data: bytes })
    expect(upload.status(), await upload.text()).toBe(202)
    await expect.poll(async () => ((await api('plugins')) as CommunityPluginView[])[0]?.stage, { timeout: 180000 }).toBe('available')
    // The package remains unpublished: preinstall and market installation share checked-byte transport.
    const alice = await browser.newPage({ locale: 'en' }), bob = await browser.newPage({ locale: 'en' })
    for (const [username, member] of [['alice', alice], ['bob', bob]] as const) {
      await signInCommunity(member, origin, username, 'password')
      expect((await member.request.get(origin + '/market/api/plugins')).status()).toBe(200)
      expect(instances.has(username)).toBe(true)
    }
    accounts = new CommunityAccountStore(join(runtime.dataRoot, 'community-accounts.db'))
    const account = accounts.get('alice')!, actor = { username: account.username, spaceId: account.spaceId, sessionEpoch: account.sessionEpoch }
    const library = new FilePluginLibraryStore(join(runtime.dataRoot, 'plugins/library.json')), tokens = new SignedPluginDownloadTokens(secret)
    const downloads = new NativePluginDownloads(accounts, library, tokens, { now: Date.now }, declaredRuntimeRevision())
    const issued = downloads.issue(actor, packageName), aliceInstance = instances.get('alice')!, bobInstance = instances.get('bob')!
    const download = (instance: CommunityUserInstance, url: string) => execFileText(runtimeSettings.containerRuntimeCli, ['exec', instance.containerName!, 'node', '-e', "fetch(process.argv[1]).then(r=>process.stdout.write(String(r.status)))", url])
    expect(await download(bobInstance, issued.url)).toBe('403')
    const expired = new NativePluginDownloads(accounts, library, tokens, { now: () => Date.now() - 120000 }, declaredRuntimeRevision()).issue(actor, packageName)
    expect(await download(aliceInstance, expired.url)).toBe('403')
    const native = new MemberNativePlugins(accounts, downloads, manager, { current: () => resolveDownloadSources(selection) }), signal = new AbortController().signal
    const result = await native.install(actor, packageName, aliceInstance, publicOrigin, signal, 'native-seam-install')
    expect(['applied', 'restart-required']).toContain(result.application)
    if (result.application === 'restart-required') expect((await alice.request.post(origin + '/recovery/restart', { headers: { origin }, data: { confirmed: true } })).status()).toBe(200)
    const cookie = await cookieHeader(alice.context(), origin)
    const bundles = () => rpc.remoteRpc<{ name: string, installed: boolean }[]>(origin, cookie, 'pluginManager/listBundles', {})
    expect((await bundles()).find(row => row.name === packageName)?.installed).toBe(true)
    const plugins = await rpc.remoteRpc<{ moduleName: string, enabled: boolean, fiberPhase: string }[]>(origin, cookie, 'pluginManager/listPlugins', {})
    expect(plugins.find(row => row.moduleName === packageName)).toMatchObject({ enabled: true, fiberPhase: 'active' })
    expect(await readFile(join(runtime.dataRoot, 'users/alice/home/NATIVE_SEAM_READY'), 'utf8')).toBe('ready')
    const profile = join(runtime.dataRoot, 'users/alice/home/.dsh/profiles/web'), manifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
    expect(manifest.dependencies[packageName]).toMatch(/^file:/u)
    expect(manifest.dependencies[packageName]).not.toContain('plugins.dsh-phalanx.invalid')
    expect((await alice.request.get(origin + '/market/api/plugins')).status()).toBe(200)
    const installedInstance = instances.get('alice')!
    const inspectCache = "const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');const [profile,spec]=process.argv.slice(1),target=path.resolve(profile,spec.slice(5)),relative=path.relative(profile,target);process.stdout.write(JSON.stringify({insideProfile:relative!==''&&!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith('../'),sha512:crypto.createHash('sha512').update(fs.readFileSync(target)).digest('hex')}))"
    const cached = JSON.parse(await execFileText(runtimeSettings.containerRuntimeCli, ['exec', installedInstance.containerName!, 'node', '-e', inspectCache, DSH_CONTAINER_PROFILE, manifest.dependencies[packageName]]))
    expect(cached).toEqual({ insideProfile: true, sha512: createHash('sha512').update(bytes).digest('hex') })
    await alice.reload(); await alice.getByRole('button', { name: 'Plugins', exact: true }).click()
    const card = alice.locator(`[data-plugin-package="${packageName}"]`)
    await card.waitFor()
    expect((await alice.request.get(origin + '/market/api/plugins')).status()).toBe(200)
    const current = instances.get('alice')!
    const application = await native.remove(actor, packageName, current, publicOrigin, signal)
    if (application === 'restart-required') expect((await alice.request.post(origin + '/recovery/restart', { headers: { origin }, data: { confirmed: true } })).status()).toBe(200)
    expect(JSON.parse(await readFile(join(profile, 'package.json'), 'utf8')).dependencies?.[packageName]).toBeUndefined()
    expect((await bundles()).some(row => row.name === packageName && row.installed)).toBe(false)
    await alice.reload(); await alice.getByRole('button', { name: 'Plugins', exact: true }).click()
    await alice.locator('[data-plugin-panel][aria-busy="false"]').waitFor()
    await alice.locator('[data-plugin-loading]').waitFor({ state: 'detached' })
    await alice.locator('[data-plugin-group="extensions"] h3').waitFor()
    expect(await card.count()).toBe(0)
  } catch (error) { primaryFailure = error }
  finally {
    const attempt = async (action: () => unknown | Promise<unknown>) => { try { await action(); return true } catch (error) { cleanupErrors.push(error); return false } }
    await attempt(() => browser.close()); await attempt(() => accounts?.close())
    const stopped = await attempt(() => app.stop()), rebuilt = await attempt(() => new CommunityRuntimeDriver(runtime).rebuild())
    if (stopped && rebuilt) await attempt(() => rm(root, { recursive: true, force: true }))
  }
  if (cleanupErrors.length) throw new AggregateError(primaryFailure === undefined ? cleanupErrors : [primaryFailure, ...cleanupErrors], 'Native plugin acceptance cleanup failed')
  if (primaryFailure !== undefined) throw primaryFailure
}, 360000)
