// Validation: T2; real credentials: none; actual Linux rootless DSH. Missing inputs must fail the T2 report gate.
import { removeCommunityFixture } from './fixtures/owned-cleanup.js'
import { effectiveUserDataRoot } from '../src/domain/storage-layout.js'
import { withPluginFacts } from './support/plugin-facts.js'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
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
  'packs a local plugin in real DSH, privately prechecks it and adopts the independent platform copy with native detail status',
  async () => {
    assertPinnedDshRevision(runtimeSettings)
    const root = await mkdtemp(join(tmpdir(), 'plugin-contributions-native-'))
    const server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array))
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        response.setHeader('content-type', 'text/event-stream')
        if (
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
            purpose: 'Share our team plugin',
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
      const origin = await app.start(),
        admin = await browser.newPage({ locale: 'en' }),
        member = await browser.newPage({ locale: 'en' })
      const errors: string[] = []
      member.on('console', message => {
        if (message.type() === 'warning' || message.type() === 'error') errors.push(message.text())
      })
      await signInCommunity(admin, origin, 'admin', 'password', true)
      await signInCommunity(member, origin, 'member', 'password')
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
      await writeFile(join(directory, 'index.js'), "export const name='team-contribution-fixture';export function apply(){}")
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
      await composer.fill('SUBMIT_PLUGIN: Submit team-plugin to the platform.')
      await composer.press('Enter')
      await member.getByText('Submit / 提交', { exact: true }).waitFor({ timeout: 60000 })
      expect(await member.locator('body').innerText()).toContain('Plugin / 插件: @example/team-contribution@1.0.0')
      expect(await member.locator('body').innerText()).toContain('.env.local')
      expect(await (await admin.request.get(origin + '/admin/api/plugins')).json()).toEqual([])
      const evidence = process.env.DSH_PHALANX_E2E_EVIDENCE_DIR
      if (evidence) {
        await mkdir(evidence, { recursive: true })
        await member.screenshot({ path: join(evidence, 'plugin-confirm.png'), fullPage: true, animations: 'disabled' })
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
      if (evidence) await member.screenshot({ path: join(evidence, 'plugin-native-status.png'), fullPage: true, animations: 'disabled' })
      await admin.goto(origin + '/admin/plugins?locale=en')
      await admin.getByRole('tab', { name: 'Member contributions' }).click()
      await admin.getByRole('button', { name: 'Review contribution' }).click()
      await admin.getByRole('heading', { name: 'package.json', exact: true }).waitFor()
      await admin.getByRole('heading', { name: 'cordis.patch.yml', exact: true }).waitFor()
      await admin.getByRole('button', { name: 'Adopt contribution', exact: true }).click()
      if (evidence) await admin.screenshot({ path: join(evidence, 'plugin-admin-review.png'), fullPage: true, animations: 'disabled' })
      await admin.getByRole('button', { name: 'Continue to distribution', exact: true }).click()
      await admin.getByRole('button', { name: 'Confirm adoption', exact: true }).click()
      await admin.getByRole('button', { name: 'Finish adoption', exact: true }).waitFor()
      const plugins = await (await admin.request.get(origin + '/admin/api/plugins')).json()
      expect(plugins).toMatchObject([{ packageName: '@example/team-contribution', stage: 'available', published: false }])
      const records = await withPluginFacts(root, ({ library }) => library.list())
      expect(JSON.stringify(records)).not.toContain('plugin-intake')
      await expect
        .poll(async () => await member.getByRole('region', { name: 'Plugin contribution', exact: true }).innerText(), { timeout: 15000 })
        .toContain('Adopted')
    } finally {
      await browser.close()
      await app.stop()
      await new CommunityRuntimeDriver(runtime).rebuild()
      await accounts.close()
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
      await removeCommunityFixture(root)
    }
  },
  300000,
)
