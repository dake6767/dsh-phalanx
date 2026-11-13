import { createHash, randomUUID } from 'node:crypto'
import type { Page } from 'playwright'
import { expect } from 'vitest'
import type { CommunityMarketPageData, CommunityPluginView } from '../../src/domain/admin-contract.js'
import { installedMemberHome, installedShellArgument } from './installed-storage-layout.js'
import { cookieHeader, createRealDshRpc } from './real-dsh-rpc.js'

const packageName = 'qiaomu-cover-design-dsh'
const version = '0.1.3'
const filename = `${packageName}-${version}.tgz`
const asset = `https://github.com/joeseesun/${packageName}/releases/download/v${version}/${filename}`
const integrity = 'Lq31kbA5Dv3HijBh9jgTxvXYL7nwb0/vVHh7kSdC9mL6dP1FL8iwcPG0UQqUHIzUUzh+8sRHko+kbCXVQ51Yxw=='
const personal = { protocol: 'openai', preset: 'custom', baseUrl: 'https://personal.example.test/v1', model: 'retained-personal-model' }

interface LegacyPluginFixture {
  readonly admin: Page
  readonly member: Page
  readonly origin: string
  readonly memberStorageKey: string
  readonly remote: (command: string) => Promise<string>
}

type PluginState = { revision: number; data: { settings?: { ai?: Record<string, unknown> }; workspace?: unknown } }

async function readMarket({ member, origin }: LegacyPluginFixture): Promise<CommunityMarketPageData> {
  const response = await member.request.get(origin + '/market/api/plugins')
  expect(response.status()).toBe(200)
  return response.json()
}

async function settingsRpc({ member, origin }: LegacyPluginFixture) {
  const cookie = await cookieHeader(member.context(), origin)
  const { remoteRpc } = createRealDshRpc()
  return {
    info: () => remoteRpc<{ platform: string; workspaceRoot: string }>(origin, cookie, 'qiaomuCoverDesign/info', {}),
    load: () => remoteRpc<PluginState>(origin, cookie, 'qiaomuCoverDesign/load', {}),
    plugins: () => remoteRpc<{ moduleName: string; enabled: boolean; fiberPhase: string }[]>(origin, cookie, 'pluginManager/listPlugins', {}),
  }
}

export async function seedLegacyUpgradePlugin(fixture: LegacyPluginFixture) {
  const { admin, member, origin } = fixture
  const headers = { origin }
  const library = async (): Promise<CommunityPluginView[]> => (await admin.request.get(origin + '/admin/api/plugins')).json()
  if (!(await library()).some(row => row.packageName === packageName)) {
    const response = await fetch(asset, { signal: AbortSignal.timeout(30000) })
    expect(response.status).toBe(200)
    const archive = Buffer.from(await response.arrayBuffer())
    expect(createHash('sha512').update(archive).digest('base64')).toBe(integrity)
    const uploaded = await admin.request.post(origin + '/admin/api/plugins/upload', {
      headers: { ...headers, 'content-type': 'application/gzip', 'x-plugin-filename': filename },
      data: archive,
    })
    expect(uploaded.status()).toBe(202)
  }
  await expect.poll(async () => (await library()).find(row => row.packageName === packageName)?.stage, { timeout: 660000 }).toBe('available')
  const entry = (await library()).find(row => row.packageName === packageName)
  expect(entry).toMatchObject({ version, integrity: 'sha512-' + integrity })
  if (!entry?.published) {
    const published = await admin.request.post(origin + '/admin/api/plugins/publication', {
      headers,
      data: { action: 'publish', packageName, published: true, confirmed: true },
    })
    expect(published.status()).toBe(200)
  }
  if (!(await readMarket(fixture)).plugins.some(row => row.packageName === packageName && row.status === 'installed')) {
    const selected = await member.request.post(origin + '/market/api/plugins', {
      headers,
      data: { action: 'install', packageName, requestId: randomUUID() },
    })
    expect(selected.status()).toBe(202)
    await expect
      .poll(async () => (await readMarket(fixture)).plugins.find(row => row.packageName === packageName)?.status, { timeout: 660000 })
      .toBe('installed')
    const restart = await member.request.post(origin + '/recovery/restart', { headers, data: { confirmed: true } })
    expect(restart.status()).toBe(200)
    await member.reload()
    await member.locator('#root').waitFor({ state: 'attached', timeout: 300000 })
  }
  const plugin = (await (await settingsRpc(fixture)).plugins()).find(row => row.moduleName.includes(packageName))
  expect(plugin).toMatchObject({ enabled: true, fiberPhase: 'active' })
  // The formal predecessor has no Secret Service. Write the plugin's native
  // state format with personal endpoint/model settings and no credential.
  const directory = (await installedMemberHome(fixture.remote, fixture.memberStorageKey)) + '/.dsh/qiaomu/' + packageName
  const state = { revision: 1, data: { settings: { ai: personal }, workspace: { openFiles: [], activeFile: '' } } }
  const path = installedShellArgument(directory + '/state.json')
  await fixture.remote(
    'sudo -u dsh-phalanx sh -c ' +
      installedShellArgument(
        'umask 077; mkdir -p ' +
          installedShellArgument(directory) +
          '; test -f ' +
          path +
          ' || printf %s ' +
          installedShellArgument(JSON.stringify(state)) +
          ' > ' +
          path,
      ),
  )
  expect(JSON.parse(await fixture.remote('sudo cat ' + path))).toEqual(state)
  expect(await (await settingsRpc(fixture)).info()).toMatchObject({ platform: 'linux', workspaceRoot: expect.any(String) })
  return state
}

export async function assertLegacyUpgradePlugin(fixture: LegacyPluginFixture, previous: PluginState) {
  const { plugins, nativeServices } = await readMarket(fixture)
  expect(plugins.find(row => row.packageName === packageName)).toMatchObject({ status: 'installed', installedVersion: version })
  expect(nativeServices?.find(row => row.packageName === packageName)).toBeUndefined()
  const loaded = await (await settingsRpc(fixture)).load()
  expect(loaded.data.settings?.ai).toMatchObject(personal)
  expect(loaded.data.settings?.ai?.apiKey ?? '').toBe('')
  expect({ revision: loaded.revision, data: loaded.data }).toEqual(previous)
  return { personalSettingsRetained: true, platformBindingAbsent: true }
}
