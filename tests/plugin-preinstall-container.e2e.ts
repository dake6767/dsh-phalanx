// Validation: T2; real credentials: none; exact installed modules, actual rootless DSH and checked archives.
import { memberSpacePath } from './support/real-dsh-runtime.js'
import { copyFile, readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseDocument, isSeq } from 'yaml'
import type { Page } from 'playwright'
import { expect, it } from 'vitest'
import { communityEntryUrl } from './support/community-space.js'
import { cookieHeader, createRealDshRpc, rpcBody } from './support/real-dsh-rpc.js'
import type { CommunityMarketPageData } from '../src/domain/admin-contract.js'
import { signInCommunity } from './fixtures/community-native-browser.js'
import { withPreinstallFixture } from './support/plugin-preinstall-real.js'
import { refreshAppCenter, setAppCenterVisibility } from './support/app-center-visibility.js'

it(
  'coexists native selections and preinstalls with shared and controlled read-only plugins, preserves shelf and uninstall decisions, and restores only preinstalls through both reset entries',
  async () =>
    withPreinstallFixture(true, async f => {
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
      await setAppCenterVisibility(f.admin.request, f.origin, account.groupId)
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
          expect(await readFile(join(await memberSpacePath(f.runtime.dataRoot, 'alice'), `home/preinstall-${suffix}.log`), 'utf8')).toContain(
            '/.dsh/profiles/web/',
          )
        for (const suffix of ['shared', 'managed']) {
          const runs = await readFile(join(await memberSpacePath(f.runtime.dataRoot, 'alice'), `home/preinstall-${suffix}.log`), 'utf8')
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
    withPreinstallFixture(false, async f => {
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
      const sharedRuns = await readFile(join(await memberSpacePath(f.runtime.dataRoot, 'alice'), 'home/preinstall-shared.log'), 'utf8')
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
      expect(await readFile(join(await memberSpacePath(f.runtime.dataRoot, 'alice'), 'home/preinstall-shared.log'), 'utf8')).toContain('/.dsh/profiles/web/')
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
      const expertRuns = await readFile(join(await memberSpacePath(f.runtime.dataRoot, 'bob'), 'home/preinstall-expert.log'), 'utf8')
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
    withPreinstallFixture(false, async f => {
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
          const home = join(await memberSpacePath(f.runtime.dataRoot, username), 'home')
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

it(
  'updates checked selected and preinstalled copies without taking over native installs, and reports both recovery outcomes',
  async () =>
    withPreinstallFixture(
      false,
      async f => {
        const preinstalled = await f.pack('member-update'),
          selected = '@example/member-update-github',
          repository = 'example/member-update'
        const github = (commit: string, marker: string) =>
          f.github.setRepository(repository, {
            commit: commit.repeat(40),
            files: {
              'package.json': JSON.stringify({
                name: selected,
                version: '1.0.0',
                type: 'module',
                main: './plugin.mjs',
                dsh: { bundle: { patch: './patch.yml' } },
              }),
              'patch.yml': JSON.stringify([{ insert: [{ id: 'member-update-settings', name: './plugin.mjs' }] }]),
              'plugin.mjs': `import {existsSync,readFileSync,writeFileSync} from 'node:fs';import {join} from 'node:path';
export const name='member-update-settings';export function apply(_ctx, config){
  if(existsSync(join(process.env.HOME,'update-${marker}.fail'))){
    if('${marker}'==='bad'){
      const file=join(process.env.HOME,'.dsh/profiles/web/cordis.patch.yml');
      writeFileSync(file,readFileSync(file,'utf8').replace('saved member setting','changed during failed activation'));
    }
    throw Error('Injected member activation failure');
  }
  writeFileSync(join(process.env.HOME,'member-update-state.json'),JSON.stringify({content:'${marker}',value:config?.value??null}));
}`,
            },
          })
        github('a', 'old')
        const preview = await f.api('plugins/previews', { input: 'github:' + repository })
        await expect.poll(async () => (await f.api('plugins/previews?token=' + preview.token)).stage, { timeout: 180000 }).toBe('ready')
        await f.api('plugins/previews/confirm', { token: preview.token })
        await f.api('plugins/publication', { action: 'publish', packageName: selected, published: true })
        await f.api('groups', { action: 'create', name: 'Update group' })
        const group = (await f.api('groups')).find((row: { name: string }) => row.name === 'Update group')
        await f.configure(group.id, [preinstalled])
        await setAppCenterVisibility(f.admin.request, f.origin, group.id)
        await f.api('accounts', { username: 'alice', password: 'password', email: '', groupId: group.id })
        await f.api('accounts', { username: 'bob', password: 'password', email: '' })
        const alice = await f.signIn('alice'),
          bob = await f.signIn('bob')
        await f.waitInstalled(alice, preinstalled)
        const post = (page: Page, input: object) => page.request.post(f.origin + '/market/api/plugins', { headers: { origin: f.origin }, data: input })
        const market = async (page: Page) => {
          const response = await page.request.get(f.origin + '/market/api/plugins')
          expect(response.ok(), await response.text()).toBe(true)
          return ((await response.json()) as CommunityMarketPageData).plugins
        }
        const row = async (page: Page, name: string) => (await market(page)).find(plugin => plugin.packageName === name)!
        expect((await market(alice)).some(plugin => plugin.packageName === preinstalled)).toBe(false)
        await f.api('plugins/publication', { action: 'publish', packageName: preinstalled, published: true })
        const observe = async (name: string, id: string) => {
          await expect
            .poll(
              async () => {
                const job = (await row(alice, name)).job
                return job?.requestId === id && job.status !== 'running'
              },
              { timeout: 180000 },
            )
            .toBe(true)
          return (await row(alice, name)).job!
        }
        const bundle = async (page: Page, name: string) =>
          (
            await f.call<
              {
                name: string
                version?: string
                enabled: boolean
                source?: string
                rows: { rowId: string; moduleName: string }[]
              }[]
            >(page, 'pluginManager/listBundles', {})
          ).find(item => item.name === name)
        const install = await post(alice, { packageName: selected, action: 'install', requestId: 'selected-old' })
        expect(install.status(), await install.text()).toBe(202)
        expect(await observe(selected, 'selected-old')).toMatchObject({ status: 'succeeded' })
        const bobHome = join(await memberSpacePath(f.runtime.dataRoot, 'bob'), 'home')
        await copyFile(join(f.root, 'example-preinstall-member-update-1.0.0.tgz'), join(bobHome, 'native-copy.tgz'))
        expect(await f.call(bob, 'pluginManager/installBundle', { spec: '/dsh-phalanx/home/native-copy.tgz' })).toMatchObject({ application: 'applied' })

        const aliceHome = join(await memberSpacePath(f.runtime.dataRoot, 'alice'), 'home')
        const settingsFile = join(aliceHome, '.dsh/profiles/web/cordis.patch.yml')
        const stateFile = join(aliceHome, 'member-update-state.json')
        const state = async () => JSON.parse(await readFile(stateFile, 'utf8'))
        const settings = parseDocument(
          await readFile(settingsFile, 'utf8').catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error
            return '[]'
          }),
          { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] },
        )
        expect(isSeq(settings.contents)).toBe(true)
        const original = (await bundle(alice, selected))!
        const currentRow = original.rows.find(item => item.rowId === 'member-update-settings')!
        settings.add({ id: currentRow.rowId, name: currentRow.moduleName, config: { value: 'saved member setting' } })
        await writeFile(settingsFile, String(settings))
        await f.restart(alice, 'alice')
        await expect.poll(state, { timeout: 30000 }).toEqual({ content: 'old', value: 'saved member setting' })
        const savedSettings = await readFile(settingsFile)
        expect(await f.call(alice, 'pluginManager/setBundleEnabled', { name: preinstalled, enabled: false })).toMatchObject({ application: 'applied' })

        const adopt = async (packageName: string) => {
          await expect
            .poll(async () => (await f.api('plugins')).find((plugin: { packageName: string }) => plugin.packageName === packageName)?.replacement?.stage, {
              timeout: 180000,
            })
            .toBe('available')
          const impact = await f.api('plugins/impact?packageName=' + encodeURIComponent(packageName))
          await f.api('plugins/change', { action: 'select', packageName, revision: impact.revision, confirmed: true })
        }
        const advanceGithub = async (commit: string, marker: string) => {
          github(commit, marker)
          await f.api('plugins/change', { action: 'update', packageName: selected })
          await adopt(selected)
        }
        const update = async (name: string, id: string) => {
          const choice = (await row(alice, name)).update!
          expect(choice).toBeDefined()
          const response = await post(alice, { packageName: name, action: 'update', requestId: id, target: choice.target })
          expect(response.status(), await response.text()).toBe(202)
          return observe(name, id)
        }

        await f.pack('member-update', '2.0.0', true)
        await adopt(preinstalled)
        expect(await row(bob, preinstalled)).toMatchObject({ status: 'native', installedVersion: '1.0.0' })
        expect((await row(bob, preinstalled)).update).toBeUndefined()
        const pre = await row(alice, preinstalled)
        expect(pre).toMatchObject({ status: 'installed', installedVersion: '1.0.0', update: { kind: 'version', version: '2.0.0' } })
        expect(await bundle(alice, preinstalled)).toMatchObject({ version: '1.0.0', enabled: false })
        const request = { packageName: preinstalled, action: 'update', requestId: 'preinstall-stale', target: pre.update!.target }
        let entered!: () => void, release!: () => void
        const blocked = new Promise<void>(resolve => {
          entered = resolve
        })
        const gate = new Promise<void>(resolve => {
          release = resolve
        })
        f.updates.beforeReplace = async () => {
          entered()
          await gate
        }
        try {
          expect((await post(alice, request)).status()).toBe(202)
          await blocked
          expect((await post(alice, { ...request, requestId: 'preinstall-conflict' })).status()).toBe(409)
          await f.api('plugins/publication', { action: 'publish', packageName: preinstalled, published: false, confirmed: true, selectedMembers: 0 })
        } finally {
          release()
          f.updates.beforeReplace = undefined
        }
        await expect
          .poll(async () => (await (await post(alice, request)).json()).job, { timeout: 30000 })
          .toMatchObject({ status: 'failed', failure: { code: 'plugin-update-changed' } })
        expect(await bundle(alice, preinstalled)).toMatchObject({ version: '1.0.0', enabled: false })
        expect((await market(alice)).some(plugin => plugin.packageName === preinstalled)).toBe(false)
        await f.api('plugins/publication', { action: 'publish', packageName: preinstalled, published: true })
        expect(await update(preinstalled, 'preinstall-good')).toMatchObject({ status: 'succeeded' })
        expect(await bundle(alice, preinstalled)).toMatchObject({ version: '2.0.0', enabled: false })
        await f.pack('member-update', '1.0.0', true)
        await adopt(preinstalled)
        expect((await row(alice, preinstalled)).update).toBeUndefined()

        await advanceGithub('b', 'good')
        await setAppCenterVisibility(f.admin.request, f.origin, group.id, false)
        await refreshAppCenter(alice, false)
        const selectedRow = await row(alice, selected)
        expect(selectedRow.update).toMatchObject({ kind: 'content', version: '1.0.0' })
        expect(await state()).toEqual({ content: 'old', value: 'saved member setting' })
        expect(await bundle(alice, selected)).toMatchObject({ version: '1.0.0', enabled: true })
        await setAppCenterVisibility(f.admin.request, f.origin, group.id)
        await refreshAppCenter(alice, true)
        await alice.getByRole('button', { name: 'Platform App Center', exact: true }).click()
        const panel = alice.getByRole('region', { name: 'Platform App Center', exact: true })
        const card = panel.getByRole('listitem').filter({ has: alice.getByRole('heading', { name: selectedRow.title, exact: true }) })
        await card.getByText('Content update available · 1.0.0').waitFor()
        const accepted = alice.waitForResponse(response => response.url().endsWith('/market/api/plugins') && response.request().method() === 'POST')
        await card.getByRole('button', { name: 'Update plugin', exact: true }).click()
        const response = await accepted
        expect(response.status(), await response.text()).toBe(202)
        expect(await observe(selected, (await response.json()).job.requestId)).toMatchObject({ status: 'succeeded' })
        await card.getByText(/Update complete\. Restart/).waitFor()
        await expect.poll(state, { timeout: 30000 }).toEqual({ content: 'good', value: 'saved member setting' })
        expect(await readFile(settingsFile)).toEqual(savedSettings)
        await card.getByRole('button', { name: 'Restart instance', exact: true }).click()
        const confirmation = alice.getByRole('checkbox', { name: 'I understand that my running tasks will be interrupted' })
        await confirmation.waitFor()
        expect(await confirmation.isChecked()).toBe(false)
        await alice.getByRole('link', { name: 'Return to DSH', exact: true }).click()
        await alice.getByRole('button', { name: 'Platform App Center', exact: true }).click()
        await card.getByRole('button', { name: 'Later', exact: true }).click()
        expect(await card.getByRole('button', { name: 'Restart instance', exact: true }).count()).toBe(0)

        await advanceGithub('c', 'bad')
        const goodSource = (await bundle(alice, selected))?.source
        expect(goodSource).toMatch(/^file:/u)
        await writeFile(join(aliceHome, 'update-bad.fail'), '')
        await unlink(stateFile)
        const restored = await update(selected, 'restore-old')
        expect(restored, JSON.stringify(restored.failure)).toMatchObject({ status: 'failed', failure: { code: 'plugin-update-restored' } })
        expect(await state()).toEqual({ content: 'good', value: 'saved member setting' })
        expect(await bundle(alice, selected)).toMatchObject({ version: '1.0.0', source: goodSource, enabled: true })
        expect(await readFile(settingsFile)).toEqual(savedSettings)

        await writeFile(join(aliceHome, 'update-good.fail'), '')
        const failed = await update(selected, 'restore-failed')
        expect(failed).toMatchObject({ status: 'failed', failure: { code: 'plugin-update-restore-failed' } })
        const recovery = join(aliceHome, '.dsh/profiles/web/.phalanx-market', String(failed.failure?.params?.recovery))
        expect(JSON.parse(await readFile(join(recovery, 'result.json'), 'utf8'))).toMatchObject({ result: 'restore-failed' })
        expect((await readdir(recovery)).sort()).toEqual(['cordis.patch.yml', 'package.json', 'pnpm-lock.yaml', 'previous.tgz', 'result.json', 'update.json'])
        expect(await readFile(join(recovery, 'cordis.patch.yml'))).toEqual(savedSettings)
        expect((await f.plugins(alice)).some(item => item.moduleName.includes('/member-update-github/') && item.fiberPhase === 'active')).toBe(false)
        expect(await bundle(bob, preinstalled)).toMatchObject({ version: '1.0.0', enabled: true })
        // Reinstall the previous archive from the native page after a later same-version platform delivery.
        expect(original.source).toMatch(/^file:/u)
        expect(await f.call(alice, 'pluginManager/removeBundle', { name: selected })).toMatchObject({ application: 'applied' })
        expect(await f.call(alice, 'pluginManager/installBundle', { spec: original.source!.slice(5) })).toMatchObject({ application: 'applied' })
        expect(await bundle(alice, selected)).toMatchObject({ source: original.source, version: '1.0.0', enabled: true })
        expect((await row(alice, selected)).update).toBeUndefined()
      },
      true,
    ),
  720000,
)
