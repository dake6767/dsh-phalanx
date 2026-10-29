// Validation: T2; real credentials: none; actual installed modules, private gateway and rootless member DSH.
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { execFileText } from '../src/adapters/runtime-command.js'
import { declaredRuntimeRevision } from '../src/adapters/runtime-revision.js'
import type { CommunityMarketPageData, CommunityPluginView } from '../src/domain/admin-contract.js'
import type { CommunityRuntimeConfig } from '../src/domain/community-config.js'
import { effectiveUserDataRoot } from '../src/domain/storage-layout.js'
import { DSH_CONTAINER_PROFILE } from '../src/dsh/profile-layout.js'
import type { CommunityUserInstance } from '../src/ports/community-runtime.js'
import { signInCommunity } from './fixtures/community-native-browser.js'
import { testDatabaseConfigFile, withTestDatabase } from './support/community-application.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { cookieHeader, createRealDshRpc } from './support/real-dsh-rpc.js'
import { assertPinnedDshRevision, runtimeSection } from './support/real-dsh-runtime.js'
import { validationDownloadSelection } from './support/validation-downloads.js'
import { removeCommunityFixture } from './fixtures/owned-cleanup.js'

it.skipIf(!runtimeSettings.containerImage)(
  'installs retained private bytes into a native profile and removes the real dependency and native page entry',
  async () => {
    assertPinnedDshRevision(runtimeSettings)
    const installed = process.env.DSH_PHALANX_INSTALL_ROOT
    if (!installed) throw Error('Installed platform modules are required')
    const build = JSON.parse(await readFile(join(installed, 'build-info.json'), 'utf8'))
    expect(build.commit).toBe(process.env.DSH_PHALANX_CANDIDATE_SHA)
    expect(build.platform).toBe(`linux/${process.arch === 'arm64' ? 'arm64' : 'amd64'}`)
    const module = (path: string) => import(pathToFileURL(join(installed, 'dist', path + '.js')).href)
    const { createCommunityApplication } = (await module('composition/community-application')) as typeof import('./support/community-application.js')
    const { runtimeDependencyMount } = (await module('adapters/runtime-dependency-preparer')) as typeof import('../src/adapters/runtime-dependency-preparer.js')
    const { NativeMemberPluginManager } = (await module('adapters/member-plugin-manager')) as typeof import('../src/adapters/member-plugin-manager.js')
    const { MemberNativePlugins } = (await module('use-cases/member-native-plugins')) as typeof import('../src/use-cases/member-native-plugins.js')
    const { NativePluginDownloads } = (await module('use-cases/native-plugin-downloads')) as typeof import('../src/use-cases/native-plugin-downloads.js')
    const { PostgresSessionKey } = (await module('adapters/postgres-session-key')) as typeof import('../src/adapters/postgres-session-key.js')
    const { SignedPluginDownloadTokens } = (await module('adapters/plugin-download-tokens')) as typeof import('../src/adapters/plugin-download-tokens.js')
    const { FileExecutionArtifacts } = (await module('adapters/execution-artifacts')) as typeof import('../src/adapters/execution-artifacts.js')
    const { PostgresPluginLibraryStore } = (await module('adapters/postgres-plugin-library')) as typeof import('../src/adapters/postgres-plugin-library.js')
    const { PostgresCommunityAccountStore } = (await module(
      'adapters/postgres-community-accounts',
    )) as typeof import('../src/adapters/postgres-community-accounts.js')
    const { PlatformDatabase } = (await module('adapters/platform-database')) as typeof import('../src/adapters/platform-database.js')
    const { FilePlatformDatabaseConfig } = (await module('adapters/platform-database-config')) as typeof import('../src/adapters/platform-database-config.js')
    const { CommunityRuntimeDriver } = (await module('adapters/community-runtime-driver')) as typeof import('../src/adapters/community-runtime-driver.js')
    const { resolveDownloadSources } = (await module('domain/download-source')) as typeof import('../src/domain/download-source.js')
    const root = await mkdtemp(join(tmpdir(), 'native-plugin-install-')),
      runtime: CommunityRuntimeConfig = runtimeSection(join(root, 'data'), 'https://example.test', runtimeSettings)
    const selection = validationDownloadSelection(),
      manager = new NativeMemberPluginManager(runtime)
    const instances = new Map<string, CommunityUserInstance>()
    const app = createCommunityApplication(
      withTestDatabase({
        listen: { host: '127.0.0.1', port: 0 },
        runtime,
        downloadSources: selection,
        network: { hostPublicAddresses: (process.env.DSH_PHALANX_E2E_HOST_PUBLIC_ADDRESSES ?? '').split(',').filter(Boolean) },
      }),
      {
        pluginManager: {
          list: async (instance, origin, signal) => {
            instances.set(instance.userId, instance)
            return manager.list(instance, origin, signal)
          },
          install: manager.install.bind(manager),
          remove: manager.remove.bind(manager),
        },
      },
    )
    const browser = await chromium.launch({ headless: true }),
      page = await browser.newPage({ locale: 'en' })
    page.setDefaultTimeout(30000)
    const packageName = '@example/native-seam',
      directory = join(root, 'package'),
      rpc = createRealDshRpc()
    let accountDatabase: InstanceType<typeof PlatformDatabase> | undefined,
      signingKey: InstanceType<typeof PostgresSessionKey> | undefined,
      primaryFailure: unknown
    const cleanupErrors: unknown[] = []
    try {
      const origin = await app.start(),
        publicOrigin = new URL(origin)
      const bootstrap = await page.request.post(origin + '/bootstrap', {
        headers: { origin },
        form: { credential: readBootstrapCredential(runtime.dataRoot)!.credential, username: 'admin', password: 'password' },
        maxRedirects: 0,
      })
      expect(bootstrap.status()).toBe(303)
      const api = async (path: string, data?: object) => {
        const response = data
          ? await page.request.post(origin + '/admin/api/' + path, { headers: { origin }, data })
          : await page.request.get(origin + '/admin/api/' + path)
        expect(response.ok(), await response.text()).toBe(true)
        return response.json()
      }
      for (const username of ['alice', 'bob']) await api('accounts', { username, password: 'password', email: '' })
      await mkdir(directory)
      await writeFile(
        join(directory, 'package.json'),
        JSON.stringify({ name: packageName, version: '1.0.0', type: 'module', main: './index.js', dsh: { bundle: { patch: './patch.yml' } } }),
      )
      await writeFile(
        join(directory, 'index.js'),
        `import {readFileSync,writeFileSync} from 'node:fs';import {join} from 'node:path';export const name='native-seam';export function apply(_ctx,config){const root=process.env.NATIVE_SEAM_SDK;let resource=null,readOnly=null;if(root){resource=readFileSync(join(root,'sdk.txt'),'utf8');try{writeFileSync(join(root,'write-probe'),'forbidden');readOnly=false}catch(error){readOnly=['EROFS','EACCES','EPERM'].includes(error.code)}}writeFileSync(join(process.env.HOME,'NATIVE_SEAM_READY'),JSON.stringify({literal:process.env.NATIVE_SEAM_LITERAL??null,template:process.env.NATIVE_SEAM_TEMPLATE??null,entry:config?.flag??null,root:root??null,resource,readOnly}))}\n`,
      )
      await writeFile(join(directory, 'patch.yml'), JSON.stringify([{ insert: [{ id: 'native-seam', name: packageName }] }]))
      const packed = JSON.parse(await execFileText('npm', ['pack', directory, '--ignore-scripts', '--json', '--pack-destination', root])) as {
        filename: string
      }[]
      const bytes = await readFile(join(root, packed[0]!.filename))
      const upload = await page.request.post(origin + '/admin/api/plugins/upload', {
        headers: { origin, 'content-type': 'application/gzip', 'x-plugin-filename': 'native.tgz' },
        data: bytes,
      })
      expect(upload.status(), await upload.text()).toBe(202)
      await expect.poll(async () => ((await api('plugins')) as CommunityPluginView[])[0]?.stage, { timeout: 180000 }).toBe('available')
      // The package remains unpublished: preinstall and market installation share checked-byte transport.
      const alice = await browser.newPage({ locale: 'en' }),
        bob = await browser.newPage({ locale: 'en' })
      for (const [username, member] of [
        ['alice', alice],
        ['bob', bob],
      ] as const) {
        await signInCommunity(member, origin, username, 'password')
        expect((await member.request.get(origin + '/market/api/plugins')).status()).toBe(200)
        expect(instances.has(username)).toBe(true)
      }
      const saved = FilePlatformDatabaseConfig.open(testDatabaseConfigFile(runtime.dataRoot), runtime.dataRoot)
      accountDatabase = new PlatformDatabase(saved.connection, saved.security)
      await accountDatabase.initialize()
      const accounts = new PostgresCommunityAccountStore(accountDatabase)
      const account = (await accounts.get('alice'))!,
        actor = { username: account.username, spaceId: account.spaceId, sessionEpoch: account.sessionEpoch }
      signingKey = new PostgresSessionKey(accountDatabase)
      await signingKey.initialize()
      const library = new PostgresPluginLibraryStore(accountDatabase),
        tokens = new SignedPluginDownloadTokens(signingKey)
      const downloads = new NativePluginDownloads(accounts, library, tokens, { now: Date.now }, declaredRuntimeRevision())
      const issued = await downloads.issue(actor, packageName),
        aliceInstance = instances.get('alice')!,
        bobInstance = instances.get('bob')!
      const download = (instance: CommunityUserInstance, url: string) =>
        execFileText(runtimeSettings.containerRuntimeCli, [
          'exec',
          instance.containerName!,
          'node',
          '-e',
          'fetch(process.argv[1]).then(r=>process.stdout.write(String(r.status)))',
          url,
        ])
      expect(await download(bobInstance, issued.url)).toBe('403')
      const expired = await new NativePluginDownloads(accounts, library, tokens, { now: () => Date.now() - 120000 }, declaredRuntimeRevision()).issue(
        actor,
        packageName,
      )
      expect(await download(aliceInstance, expired.url)).toBe('403')
      const definition = (value: string) => ({
        name: 'native-sdk',
        type: 'resource',
        prepareCommand: `printf '%s' '${value}' > "$RD_OUT/sdk.txt"`,
        pathDirectories: [],
      })
      await api('runtime-dependencies', { action: 'create', input: definition('SDK_V1') })
      await expect.poll(async () => (await api('runtime-dependencies?name=native-sdk')).stage, { timeout: 30000 }).toBe('ready')
      await api('plugins/change', { action: 'runtime-dependencies', packageName, names: ['native-sdk'] })
      const query = '?packageName=' + encodeURIComponent(packageName)
      const access = (await api('plugins/access' + query)) as { entryIds: string[] }
      expect(access.entryIds).toContain('native-seam')
      await api('plugins/access' + query, {
        environment: [
          { name: 'NATIVE_SEAM_LITERAL', value: 'member-literal' },
          { name: 'NATIVE_SEAM_TEMPLATE', value: '{dependency:native-sdk}/{access-token}' },
          { name: 'NATIVE_SEAM_SDK', value: '{dependency:native-sdk}' },
        ],
        entriesYaml: JSON.stringify({ 'native-seam': { flag: 'platform-entry-must-stay-out' } }),
      })
      await api('plugins/publication', { action: 'publish', packageName, published: true })
      const installedResponse = await alice.request.post(origin + '/market/api/plugins', {
        headers: { origin },
        data: { packageName, action: 'install', requestId: 'native-seam-install' },
      })
      expect(installedResponse.status()).toBe(202)
      await expect
        .poll(async () => ((await (await alice.request.get(origin + '/market/api/plugins')).json()) as CommunityMarketPageData).plugins[0]?.job?.status, {
          timeout: 180000,
        })
        .toMatch(/^(succeeded|failed)$/u)
      expect(((await (await alice.request.get(origin + '/market/api/plugins')).json()) as CommunityMarketPageData).plugins[0]?.job?.status).toBe('succeeded')
      // Startup environment is applied on an explicit restart, without injecting native entry configuration.
      expect((await alice.request.post(origin + '/recovery/restart', { headers: { origin }, data: { confirmed: true } })).status()).toBe(200)
      await signInCommunity(alice, origin, 'alice', 'password')
      const native = new MemberNativePlugins(accounts, downloads, manager, { current: () => resolveDownloadSources(selection) }),
        signal = new AbortController().signal
      const cookie = await cookieHeader(alice.context(), origin)
      const bundles = async () =>
        rpc.remoteRpc<{ name: string; installed: boolean }[]>(origin, await cookieHeader(alice.context(), origin), 'pluginManager/listBundles', {})
      expect((await bundles()).find(row => row.name === packageName)?.installed).toBe(true)
      const plugins = await rpc.remoteRpc<{ moduleName: string; enabled: boolean; fiberPhase: string }[]>(origin, cookie, 'pluginManager/listPlugins', {})
      expect(plugins.find(row => row.moduleName === packageName)).toMatchObject({ enabled: true, fiberPhase: 'active' })
      expect(JSON.parse(await readFile(join(effectiveUserDataRoot(runtime), 'alice/home/NATIVE_SEAM_READY'), 'utf8'))).toMatchObject({
        literal: 'member-literal',
        template: null,
        entry: null,
        resource: 'SDK_V1',
        readOnly: true,
      })
      const observed = async () => JSON.parse(await readFile(join(effectiveUserDataRoot(runtime), 'alice/home/NATIVE_SEAM_READY'), 'utf8'))
      const first = await observed()
      expect(first.root).toBe(runtimeDependencyMount + '/' + (await api('runtime-dependencies?name=native-sdk')).current.id)
      // Refresh the captured identity after restart; the old container has already stopped.
      expect((await alice.request.get(origin + '/market/api/plugins')).status()).toBe(200)
      // No skill was imported or granted; resource environment and the tree travel with this native plugin.
      expect(await api('skills')).toEqual([])
      for (const value of ['SDK_V2', 'SDK_V3']) {
        // Ready exposes a usable version before its projection publication releases the writer.
        let update: { ok: boolean; body: string } | undefined
        await expect
          .poll(
            async () => {
              if (update) return true
              const response = await page.request.post(origin + '/admin/api/runtime-dependencies', {
                headers: { origin },
                data: { action: 'update', name: 'native-sdk', input: definition(value) },
              })
              const body = await response.text()
              if (response.status() === 409 && JSON.parse(body).code === 'runtime-dependency-unavailable') return false
              update = { ok: response.ok(), body }
              return true
            },
            { timeout: 30000 },
          )
          .toBe(true)
        expect(update!.ok, update!.body).toBe(true)
        await expect.poll(async () => (await api('runtime-dependencies?name=native-sdk')).stage, { timeout: 30000 }).toBe('ready')
      }
      const latest = await api('runtime-dependencies?name=native-sdk')
      expect(runtimeDependencyMount + '/' + latest.current.id).not.toBe(first.root)
      const oldResource = await execFileText(runtimeSettings.containerRuntimeCli, [
        'exec',
        instances.get('alice')!.containerName!,
        'node',
        '-e',
        "process.stdout.write(require('node:fs').readFileSync(process.env.NATIVE_SEAM_SDK+'/sdk.txt','utf8'))",
      ])
      expect(oldResource).toBe('SDK_V1')
      expect((await (await alice.request.get(origin + '/market/api/plugins')).json()).pending).toBe(true)
      expect((await alice.request.post(origin + '/recovery/restart', { headers: { origin }, data: { confirmed: true } })).status()).toBe(200)
      await signInCommunity(alice, origin, 'alice', 'password')
      await expect
        .poll(observed, { timeout: 30000 })
        .toMatchObject({ root: runtimeDependencyMount + '/' + latest.current.id, resource: 'SDK_V3', readOnly: true, template: null, entry: null })
      expect((await bob.request.post(origin + '/recovery/restart', { headers: { origin }, data: { confirmed: true } })).status()).toBe(200)
      await signInCommunity(bob, origin, 'bob', 'password')
      await bob.request.get(origin + '/market/api/plugins')
      expect(
        await execFileText(runtimeSettings.containerRuntimeCli, [
          'exec',
          instances.get('bob')!.containerName!,
          'node',
          '-e',
          'process.stdout.write(JSON.stringify(process.env.NATIVE_SEAM_SDK??null))',
        ]),
      ).toBe('null')
      const profile = join(effectiveUserDataRoot(runtime), 'alice/home/.dsh/profiles/web'),
        manifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
      expect(manifest.dependencies[packageName]).toMatch(/^file:/u)
      expect(manifest.dependencies[packageName]).not.toContain('plugins.dsh-phalanx.invalid')
      expect((await alice.request.get(origin + '/market/api/plugins')).status()).toBe(200)
      const installedInstance = instances.get('alice')!
      const inspectCache =
        "const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');const [profile,spec]=process.argv.slice(1),target=path.resolve(profile,spec.slice(5)),relative=path.relative(profile,target);process.stdout.write(JSON.stringify({insideProfile:relative!==''&&!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith('../'),sha512:crypto.createHash('sha512').update(fs.readFileSync(target)).digest('hex')}))"
      const cached = JSON.parse(
        await execFileText(runtimeSettings.containerRuntimeCli, [
          'exec',
          installedInstance.containerName!,
          'node',
          '-e',
          inspectCache,
          DSH_CONTAINER_PROFILE,
          manifest.dependencies[packageName],
        ]),
      )
      expect(cached).toEqual({ insideProfile: true, sha512: createHash('sha512').update(bytes).digest('hex') })
      await alice.reload()
      await alice.getByRole('button', { name: 'Plugins', exact: true }).click()
      const card = alice.locator(`[data-plugin-package="${packageName}"]`)
      await card.waitFor()
      expect((await alice.request.get(origin + '/market/api/plugins')).status()).toBe(200)
      const current = instances.get('alice')!
      const application = await native.remove(actor, packageName, current, publicOrigin, signal)
      expect(['applied', 'restart-required']).toContain(application)
      expect((await alice.request.post(origin + '/recovery/restart', { headers: { origin }, data: { confirmed: true } })).status()).toBe(200)
      await signInCommunity(alice, origin, 'alice', 'password')
      expect((await alice.request.get(origin + '/market/api/plugins')).status()).toBe(200)
      const afterRemoval = instances.get('alice')!
      const remainingEnvironment = await execFileText(runtimeSettings.containerRuntimeCli, [
        'exec',
        afterRemoval.containerName!,
        'node',
        '-e',
        'process.stdout.write(JSON.stringify({literal:process.env.NATIVE_SEAM_LITERAL??null,template:process.env.NATIVE_SEAM_TEMPLATE??null,root:process.env.NATIVE_SEAM_SDK??null}))',
      ])
      expect(JSON.parse(remainingEnvironment)).toEqual({ literal: null, template: null, root: null })
      expect(JSON.parse(await readFile(join(profile, 'package.json'), 'utf8')).dependencies?.[packageName]).toBeUndefined()
      expect((await bundles()).some(row => row.name === packageName && row.installed)).toBe(false)
      await alice.reload()
      await alice.getByRole('button', { name: 'Plugins', exact: true }).click()
      await alice.locator('[data-plugin-panel][aria-busy="false"]').waitFor()
      await alice.locator('[data-plugin-loading]').waitFor({ state: 'detached' })
      await alice.locator('[data-plugin-group="extensions"] h3').waitFor()
      expect(await card.count()).toBe(0)
    } catch (error) {
      primaryFailure = error
    } finally {
      const attempt = async (action: () => unknown | Promise<unknown>) => {
        try {
          await action()
          return true
        } catch (error) {
          cleanupErrors.push(error)
          return false
        }
      }
      await attempt(() => browser.close())
      await attempt(() => signingKey?.close())
      await attempt(() => accountDatabase?.close())
      const stopped = await attempt(() => app.stop()),
        rebuilt = await attempt(() => new CommunityRuntimeDriver(runtime).rebuild())
      if (stopped && rebuilt) {
        await attempt(() => new FileExecutionArtifacts(join(runtime.dataRoot, 'runtime-dependencies/.trees')).collect([]))
        await attempt(() => removeCommunityFixture(root))
      }
    }
    if (cleanupErrors.length)
      throw new AggregateError(primaryFailure === undefined ? cleanupErrors : [primaryFailure, ...cleanupErrors], 'Native plugin acceptance cleanup failed')
    if (primaryFailure !== undefined) throw primaryFailure
  },
  360000,
)
