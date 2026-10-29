// Validation: T2; real credentials: none; actual Linux rootless DSH. Missing inputs must fail the T2 report gate.
import { removeCommunityFixture } from './fixtures/owned-cleanup.js'
import { effectiveUserDataRoot } from '../src/domain/storage-layout.js'
import { withPluginFacts } from './support/plugin-facts.js'
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import { contributionRecords } from './support/contribution-facts.js'
import { execFileText } from '../src/adapters/runtime-command.js'
import { selectCommunityWorkspace, signInCommunity } from './fixtures/community-native-browser.js'
import { candidateApplication as createCommunityApplication } from './support/candidate-application.js'
import { openTestAccounts } from './support/community-application.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { hasToolResult, latestHumanText, streamText, streamToolCall } from './support/real-dsh-model.js'
import { cookieHeader, createRealDshRpc } from './support/real-dsh-rpc.js'
import { assertPinnedDshRevision, defaultWorkspacePath, instanceWorkspacePath, runtimeSection } from './support/real-dsh-runtime.js'

it.skipIf(!runtimeSettings.containerImage)(
  'rejects a hard-coded upstream then prefills one credential and authorizes a real DSH member without exposing it',
  async () => {
    assertPinnedDshRevision(runtimeSettings)
    const root = await mkdtemp(join(tmpdir(), 'plugin-contribution-access-'))
    const calls: { path: string; authorization: string | undefined }[] = []
    const upstream = createServer((request, response) => {
      calls.push({ path: request.url!, authorization: request.headers.authorization })
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify(
          request.url?.endsWith('/verify')
            ? { marker: 'UPSTREAM_TEST_READY', authorization: request.headers.authorization }
            : { marker: 'PLUGIN_ACCESS_READY' },
        ),
      )
    })
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
    const upstreamURL = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/provider`
    const declaration = (fixed: boolean) => ({
      purpose: 'Share our team search',
      plugin: {
        upstreams: [
          {
            name: 'search',
            baseUrl: upstreamURL,
            headers: [{ name: 'Authorization', value: 'Bearer {credential}' }],
            testRequest: { method: 'GET', path: '/verify' },
          },
        ],
        environment: [{ name: 'CONTRIBUTION_GATEWAY', secret: true, purpose: 'Authenticate forwarding', application: 'Provider dashboard' }],
        entriesYaml: JSON.stringify({ 'team-contribution-fixture': { address: fixed ? '{upstream:search}' : upstreamURL, field: 'CONTRIBUTION_GATEWAY' } }),
      },
    })
    let denied = ''
    const server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array))
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        response.setHeader('content-type', 'text/event-stream')
        if (hasToolResult(body, 'invalid-plugin-call', false)) denied = JSON.stringify(body.messages)
        if (
          JSON.stringify(body.messages).includes('INVALID_PLUGIN') &&
          !JSON.stringify(body.messages).includes('SUBMIT_PLUGIN') &&
          !latestHumanText(body).startsWith('Generate the session title') &&
          !hasToolResult(body, 'invalid-plugin-call', false) &&
          !hasToolResult(body, 'invalid-plugin-call', true)
        )
          streamToolCall(response, 'invalid-plugin-call', 'submit_contribution', {
            action: 'submit',
            kind: 'plugin',
            source: 'local',
            path: 'team-plugin',
            declaration: declaration(false),
          })
        else if (
          JSON.stringify(body.messages).includes('SUBMIT_PLUGIN') &&
          !latestHumanText(body).startsWith('Generate the session title') &&
          !hasToolResult(body, 'plugin-contribution-call', false) &&
          !hasToolResult(body, 'plugin-contribution-call', true)
        )
          streamToolCall(response, 'plugin-contribution-call', 'submit_contribution', {
            action: 'submit',
            kind: 'plugin',
            source: 'local',
            path: 'team-plugin',
            declaration: declaration(true),
          })
        else streamText(response, 'PLUGIN_CONTRIBUTION_COMPLETE')
      })().catch(() => response.destroy())
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const runtime = runtimeSection(root, `http://127.0.0.1:${(server.address() as AddressInfo).port}`, runtimeSettings)
    const app = createCommunityApplication({
      listen: { host: '127.0.0.1', port: 0 },
      sessionSecret: 'plugin-contribution-test-session-secret',
      runtime,
      modelGateway: { upstreamApiKey: 'provider-fixture-key' },
    })
    const accounts = await openTestAccounts(root)
    const browser = await chromium.launch({ headless: true })
    try {
      await accounts.createFirstAdmin({ username: 'admin', password: 'password', email: '' })
      await accounts.create({ username: 'member', password: 'password', email: '' })
      await accounts.create({ username: 'coworker', password: 'password', email: '' })
      const origin = await app.start(),
        admin = await browser.newPage({ locale: 'en' }),
        member = await browser.newPage({ locale: 'en' }),
        coworker = await browser.newPage({ locale: 'en' })
      const errors: string[] = []
      member.on('console', message => {
        if (message.type() === 'warning' || message.type() === 'error') errors.push(message.text())
      })
      await signInCommunity(admin, origin, 'admin', 'password', true)
      await signInCommunity(member, origin, 'member', 'password')
      await signInCommunity(coworker, origin, 'coworker', 'password')
      const workspace = defaultWorkspacePath(root, 'member'),
        directory = join(workspace, 'team-plugin')
      await mkdir(directory, { recursive: true })
      await writeFile(
        join(directory, 'package.json'),
        JSON.stringify({
          name: '@example/team-contribution',
          version: '1.0.0',
          type: 'module',
          main: './index.js',
          displayName: 'Team contribution fixture',
          description: 'Shared team plugin',
          dsh: { bundle: { patch: './cordis.patch.yml' } },
        }),
      )
      const pluginCode = (fixed: boolean) =>
        `export const name='team-contribution-fixture';export const inject=['webServer'];export function apply(ctx,config){ctx.effect(()=>ctx.webServer.register({kind:'exact',path:'/contribution-search',handler:async(_request,response)=>{const result=await fetch(${fixed ? 'config.address' : JSON.stringify(upstreamURL)}+'/search',{headers:{Authorization:'Bearer '+process.env[config.field]}});response.setHeader('content-type','application/json');response.end(await result.text())}}))}`
      await writeFile(join(directory, 'index.js'), pluginCode(false))
      await writeFile(
        join(directory, 'cordis.patch.yml'),
        JSON.stringify([{ insert: [{ id: 'team-contribution-fixture', name: '@example/team-contribution' }] }]),
      )
      const home = join(effectiveUserDataRoot({ dataRoot: root }), 'member/home')
      const packed = JSON.parse(await execFileText('npm', ['pack', directory, '--ignore-scripts', '--json', '--pack-destination', home])) as Array<{
        filename: string
      }>
      const cookie = await cookieHeader(member.context(), origin)
      expect(
        await createRealDshRpc().remoteRpc(origin, cookie, 'pluginManager/installBundle', { spec: '/dsh-phalanx/home/' + packed[0]!.filename }),
      ).toMatchObject({ changed: true })
      await member.reload()
      await member.getByRole('button', { name: 'Plugins', exact: true }).click()
      await member
        .getByRole('button', { name: /@example\/team-contribution/ })
        .first()
        .click()
        .catch(async error => {
          throw new Error(errors.join('\n') + '\n' + (await member.locator('body').innerText()), { cause: error })
        })
      await member.getByRole('button', { name: 'Contribute to platform', exact: true }).waitFor()
      await member.getByRole('button', { name: 'Contribute to platform', exact: true }).click()
      await expect
        .poll(
          () =>
            member
              .locator('[data-composer-input]')
              .evaluate(element => (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement ? element.value : element.textContent)),
          { timeout: 30000 },
        )
        .toContain('@example/team-contribution')
        .catch(async error => {
          throw new Error(errors.join('\n') + '\n' + (await member.locator('body').innerText()), { cause: error })
        })
      // The native action opens an editable draft; it never submits a conversation or contribution itself.
      expect((await (await admin.request.get(origin + '/admin/api/contributions')).json()).contributions).toEqual([])
      await selectCommunityWorkspace(member.context(), member, origin, instanceWorkspacePath(workspace, true), true)
      await member.getByRole('button', { name: 'Standard mode', exact: true }).click()
      await member.getByText('Standard mode', { exact: true }).last().click()
      await writeFile(join(directory, '.env.local'), 'EXAMPLE_TOKEN=excluded-fixture')
      const composer = member.locator('[data-composer-input]')
      await composer.fill('INVALID_PLUGIN: Submit this plugin with its current hard-coded address.')
      await composer.press('Enter')
      await member.getByText('Submit / 提交', { exact: true }).waitFor({ timeout: 60000 })
      await member.getByText('Submit / 提交', { exact: true }).click()
      const firstSubmit = member.getByRole('button', { name: /Submit answers|Submit answer|Submit$/ })
      if (await firstSubmit.count()) await firstSubmit.first().click()
      await expect.poll(() => denied, { timeout: 120000 }).toContain('contribution-plugin-upstream-unused')
      expect((await (await admin.request.get(origin + '/admin/api/contributions')).json()).contributions).toEqual([])
      await member.getByText('PLUGIN_CONTRIBUTION_COMPLETE', { exact: true }).last().waitFor()
      await writeFile(join(directory, 'index.js'), pluginCode(true))
      await composer.fill('SUBMIT_PLUGIN: Submit the corrected team-plugin to the platform.')
      await composer.press('Enter')
      await member.getByText('Submit / 提交', { exact: true }).waitFor({ timeout: 60000 })
      expect(await member.locator('body').innerText()).toContain('Plugin / 插件: @example/team-contribution@1.0.0')
      expect(await member.locator('body').innerText()).toContain('.env.local')
      expect(await (await admin.request.get(origin + '/admin/api/plugins')).json()).toEqual([])
      const evidence = process.env.DSH_PHALANX_E2E_EVIDENCE_DIR
      if (evidence) {
        await mkdir(evidence, { recursive: true })
        await member.screenshot({ path: join(evidence, 'plugin-access-confirm.png'), fullPage: true, animations: 'disabled' })
      }
      await member.getByText('Submit / 提交', { exact: true }).click()
      const submit = member.getByRole('button', { name: /Submit answers|Submit answer|Submit$/ })
      if (await submit.count()) await submit.first().click()
      await expect
        .poll(async () => (await (await admin.request.get(origin + '/admin/api/contributions')).json()).contributions.length, { timeout: 180000 })
        .toBe(1)
      const row = (await (await admin.request.get(origin + '/admin/api/contributions')).json()).contributions[0]
      expect((await contributionRecords(root)).find(record => record.row.id === row.id)?.row.status).toBe('pending')
      expect(row.kind).toBe('plugin')
      expect(row.plugin).toBeUndefined()
      expect(row.files).not.toContain('.env.local')
      expect(await (await admin.request.get(origin + '/admin/api/plugins')).json()).toEqual([])
      await member.getByRole('button', { name: 'Plugins', exact: true }).click()
      await member
        .getByRole('button', { name: /@example\/team-contribution/ })
        .first()
        .click()
        .catch(async error => {
          throw new Error(errors.join('\n') + '\n' + (await member.locator('body').innerText()), { cause: error })
        })
      await member.getByRole('region', { name: 'Plugin contribution', exact: true }).waitFor()
      await member.getByRole('button', { name: 'Withdraw contribution', exact: true }).waitFor()
      if (evidence) await member.screenshot({ path: join(evidence, 'plugin-access-native-status.png'), fullPage: true, animations: 'disabled' })
      await admin.goto(origin + '/admin/plugins?locale=en')
      await admin.getByRole('tab', { name: 'Member contributions' }).click()
      await admin.getByRole('button', { name: 'Review contribution' }).click()
      await admin.getByRole('heading', { name: 'package.json', exact: true }).waitFor()
      await admin.getByRole('heading', { name: 'cordis.patch.yml', exact: true }).waitFor()
      await admin.getByRole('button', { name: 'Adopt contribution', exact: true }).click()
      await admin.getByLabel('Platform credential', { exact: true }).waitFor()
      expect(await admin.getByLabel('Upstream base URL', { exact: true }).inputValue()).toBe(upstreamURL)
      await admin.getByLabel('Platform credential', { exact: true }).fill('platform-contribution-fixture-secret')
      await admin.getByRole('button', { name: 'Test upstream', exact: true }).click()
      await admin.getByText('HTTP 200', { exact: true }).waitFor()
      expect(await admin.getByRole('dialog').innerText()).not.toContain('platform-contribution-fixture-secret')
      expect(await (await admin.request.get(origin + '/admin/api/plugins')).json()).toEqual([])
      if (evidence) await admin.screenshot({ path: join(evidence, 'plugin-access-configuration.png'), fullPage: true, animations: 'disabled' })
      await admin.getByRole('button', { name: 'Continue to distribution', exact: true }).click()
      await admin.getByText('Publish to Platform App Center', { exact: true }).click()
      await admin.getByText('Confirm platform credential sharing', { exact: true }).click()
      const ordinaryGroups = await (await admin.request.get(origin + '/admin/api/groups')).json(),
        groupId = (await accounts.get('coworker'))!.groupId
      await admin.getByText(ordinaryGroups.find((row: { id: string }) => row.id === groupId).name, { exact: true }).click()
      if (evidence) await admin.screenshot({ path: join(evidence, 'plugin-access-distribution.png'), fullPage: true, animations: 'disabled' })
      await admin.getByRole('button', { name: 'Confirm adoption', exact: true }).click()
      await admin.getByRole('button', { name: 'Finish adoption', exact: true }).waitFor()
      const plugins = await (await admin.request.get(origin + '/admin/api/plugins')).json()
      expect(plugins).toMatchObject([{ packageName: '@example/team-contribution', stage: 'available', published: true }])
      const records = await withPluginFacts(root, ({ library }) => library.list())
      expect(JSON.stringify(records)).not.toContain('plugin-intake')
      await expect
        .poll(async () => await member.getByRole('region', { name: 'Plugin contribution', exact: true }).innerText(), { timeout: 15000 })
        .toContain('Adopted')
      const managed = await (await admin.request.get(origin + '/admin/api/groups/' + (await accounts.get('coworker'))!.groupId + '/plugins')).json()
      expect(managed.plugins.find((row: { packageName: string }) => row.packageName === '@example/team-contribution').granted).toBe(true)
      expect((await coworker.request.post(origin + '/recovery/restart', { headers: { origin }, data: { confirmed: true } })).status()).toBe(200)
      await signInCommunity(coworker, origin, 'coworker', 'password')
      const result = await coworker.request.get(new URL('contribution-search', coworker.url()).href)
      expect(result.status(), await result.text()).toBe(200)
      expect(await result.text()).toContain('PLUGIN_ACCESS_READY')
      expect(calls.some(row => row.path.endsWith('/search'))).toBe(true)
      expect(calls.every(row => row.authorization === 'Bearer platform-contribution-fixture-secret')).toBe(true)
      const scan = async (directory: string): Promise<void> => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const path = join(directory, entry.name)
          if (entry.isDirectory()) await scan(path)
          else if (entry.isFile()) expect((await readFile(path)).includes(Buffer.from('platform-contribution-fixture-secret')), path).toBe(false)
        }
      }
      await scan(join(effectiveUserDataRoot({ dataRoot: root }), 'coworker'))
      expect(
        JSON.stringify(await (await admin.request.get(origin + '/admin/api/plugins/upstreams?packageName=%40example%2Fteam-contribution')).json()),
      ).not.toContain('platform-contribution-fixture-secret')
    } finally {
      await browser.close()
      await app.stop()
      await new CommunityRuntimeDriver(runtime).rebuild()
      await accounts.close()
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
      upstream.closeAllConnections()
      await new Promise<void>(resolve => upstream.close(() => resolve()))
      await removeCommunityFixture(root)
    }
  },
  300000,
)
