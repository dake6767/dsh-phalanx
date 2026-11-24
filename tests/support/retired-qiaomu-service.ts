import { copyFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, type Page } from 'playwright'
import { expect, onTestFinished } from 'vitest'
import type { PostgresPluginAccessStore } from '../../src/adapters/postgres-plugin-access-store.js'
import type { PluginInstallationsPort } from '../../src/ports/plugin-installations.js'
import { openCommunitySidebar, signInCommunity } from '../fixtures/community-native-browser.js'
import { openCommunityHttpEntry } from './community-http-entry.js'
import { assertLegacyNativeServiceCopy } from './legacy-native-service-copy.js'
import { createRealDshRpc } from './real-dsh-rpc.js'
import { memberSpacePath } from './real-dsh-runtime.js'

export async function assertRetiredQiaomuService({
  origin,
  packageName,
  packageVersion,
  integrity,
  records,
  entry,
  nextAccount,
  groupSession,
  parallel,
  home,
  dataRoot,
  features,
  preinstall,
  api,
  form,
  installation,
  savedServices,
  serviceOrigin,
  nextIntegrity,
}: {
  origin: string
  packageName: string
  packageVersion: string
  integrity: string
  records: PluginInstallationsPort
  entry: { cookie: string }
  nextAccount: { spaceId: string }
  groupSession: string
  parallel: { cookie: string }
  home: string
  dataRoot: string
  features: string
  preinstall: (names: string[]) => Promise<unknown>
  api: (path: string, body?: object) => Promise<unknown>
  form: (path: string, fields: Record<string, string>) => Promise<string>
  installation: () => Promise<{ status: string } | undefined>
  savedServices: Pick<PostgresPluginAccessStore, 'installedServices' | 'saveInstalledServices'>
  serviceOrigin: string
  nextIntegrity: string
}) {
  const rpc = createRealDshRpc()
  for (const { cookie } of [entry, parallel]) {
    const state = await rpc.remoteRpc<{ data: { settings: { ai: object } } }>(origin, cookie, 'qiaomuCoverDesign/load', {})
    expect(state.data.settings.ai).toMatchObject({
      chatId: expect.stringMatching(/^platform-/u),
      imageId: expect.stringMatching(/^platform-/u),
      model: 'fixture-chat-openai',
      imageModel: 'fixture-image-seedream',
    })
    const setup = await fetch(origin + '/market/api/plugins/setup', { headers: { cookie } })
    expect(await setup.json()).toMatchObject({
      nativeServices: [
        {
          packageName,
          bindings: [
            { slot: 'chat', status: 'applied' },
            { slot: 'image', status: 'applied' },
          ],
        },
      ],
    })
  }
  await api(features, { revision: ((await api(features)) as { revision: string }).revision, disabledIds: [], showAppCenter: true })
  const affected = (await api('accounts', { username: 'retired-service-member', password: 'password', email: '' })) as { username: string }
  const affectedHome = join(await memberSpacePath(dataRoot, affected.username), 'home')
  await mkdir(affectedHome, { recursive: true, mode: 0o700 })
  for (const name of ['native-service-tls.mjs', 'native-service-key.pem', 'native-service-cert.pem']) await copyFile(join(home, name), join(affectedHome, name))
  const affectedSession = await form('/login', { username: affected.username, password: 'password' })
  const affectedEntry = await openCommunityHttpEntry(origin, affectedSession, 180000)
  await assertLegacyNativeServiceCopy({ origin, nextAccount, packageName, integrity, records, entry, groupSession, preinstall, api })
  const affectedSetup = async (session: string, retry = false) => {
    const response = await fetch(origin + '/market/api/plugins/setup', {
      headers: { cookie: session, origin, 'content-type': 'application/json' },
      ...(retry ? { method: 'POST', body: JSON.stringify({ packageName, action: 'retry-settings' }) } : {}),
    })
    expect(response.status).toBe(200)
    return response.json()
  }
  const ownedServices = (await savedServices.installedServices(packageName))!
  await savedServices.saveInstalledServices(packageName, serviceOrigin, { ...ownedServices.configuration, ownerVersion: nextIntegrity }, ownedServices.revision)
  await affectedSetup(affectedEntry.cookie, true)
  expect(await affectedSetup(affectedEntry.cookie)).toMatchObject({
    nativeServices: [{ packageName, bindings: [{ slot: '', status: 'unsupported' }] }],
  })
  const browser = await chromium.launch({ headless: true })
  onTestFinished(() => browser.close())
  const openMarket = async (page: Page) => {
    await openCommunitySidebar(page)
    await page.getByRole('button', { name: 'Platform App Center', exact: true }).click()
    return page.getByRole('region', { name: 'Platform App Center', exact: true })
  }
  const unsupported = 'This plugin version or configuration does not support platform services.'
  const affectedPage = await browser.newPage({ locale: 'en' })
  await signInCommunity(affectedPage, origin, affected.username, 'password')
  await (await openMarket(affectedPage)).getByText(unsupported, { exact: true }).waitFor()

  const independentEntry = await openCommunityHttpEntry(origin, groupSession, 180000)
  const independentState = () => rpc.remoteRpc<{ data: object }>(origin, independentEntry.cookie, 'qiaomuCoverDesign/load', {})
  const originalCopy = await independentState()
  const path = 'cover-brief.md'
  const text = '# A paper boat on a quiet lake\n'
  await rpc.remoteRpc(origin, independentEntry.cookie, 'qiaomuCoverDesign/fileWrite', { request: { path, text, exclusive: true } })
  const readBrief = () => rpc.remoteRpc<{ text: string }>(origin, independentEntry.cookie, 'qiaomuCoverDesign/fileRead', { request: { path } })
  await api('suites', { action: 'uninstall', id: 'gateway-fixture', input: {} })
  await expect.poll(installation, { timeout: 120000 }).toBeUndefined()
  expect((await affectedSetup(affectedEntry.cookie)).nativeServices).toBeUndefined()
  const expectWithdrawn = async (page: Page) => {
    const market = await openMarket(page)
    await market.getByText('No published plugins', { exact: true }).waitFor()
    expect(await market.getByText(unsupported, { exact: true }).count()).toBe(0)
    expect(await market.getByRole('heading', { name: packageName, exact: true }).count()).toBe(0)
  }
  await affectedPage.reload()
  await expectWithdrawn(affectedPage)
  expect(await independentState()).toEqual(originalCopy)
  expect((await readBrief()).text).toBe(text)
  const relogin = await form('/login', { username: affected.username, password: 'password' })
  const reopened = await openCommunityHttpEntry(origin, relogin, 180000)
  expect((await affectedSetup(reopened.cookie)).nativeServices).toBeUndefined()
  const signedInAgain = await browser.newPage({ locale: 'en' })
  await signInCommunity(signedInAgain, origin, affected.username, 'password')
  await expectWithdrawn(signedInAgain)
  const withdrawnMarket = await fetch(origin + '/market/api/plugins', { headers: { cookie: reopened.cookie } })
  expect(withdrawnMarket.status).toBe(200)
  expect((await withdrawnMarket.json()).plugins).toEqual([])

  await api('suites', { action: 'install', input: { id: 'gateway-fixture', requestId: 'native-gateway-fixture-reinstall', publish: false } })
  await expect.poll(async () => (await installation())?.status, { timeout: 240000 }).toBe('installed')
  await api('plugins/publication', { action: 'publish', packageName, published: true, confirmed: true })
  const republishedMarket = await fetch(origin + '/market/api/plugins', { headers: { cookie: reopened.cookie } })
  expect(republishedMarket.status).toBe(200)
  const republished = await republishedMarket.json()
  expect(republished.plugins).toEqual([expect.objectContaining({ packageName, version: packageVersion })])
  expect(republished.nativeServices).toBeUndefined()
  expect(await independentState()).toEqual(originalCopy)
  expect((await readBrief()).text).toBe(text)
}
