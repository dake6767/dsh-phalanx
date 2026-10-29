// Validation: T4 integration; real credentials: none; exact historical amd64 artifacts required. Not part of the approved T2 batch.
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import { FileExecutionArtifacts } from '../src/adapters/execution-artifacts.js'
import { execFileText } from '../src/adapters/runtime-command.js'
import { FileSkillArtifacts } from '../src/adapters/skill-artifacts.js'
import { FileSkillDistribution } from '../src/adapters/skill-distribution.js'
import type { CommunityRuntimeConfig } from '../src/domain/community-config.js'
import { effectiveUserDataRoot } from '../src/domain/storage-layout.js'
import { signInCommunity } from './fixtures/community-native-browser.js'
import { removeCommunityFixture } from './fixtures/owned-cleanup.js'
import { skillZip } from './fixtures/skills/archive.js'
import { candidateApplication } from './support/candidate-application.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { hasToolResult, streamText, streamToolCall } from './support/real-dsh-model.js'
import { cookieHeader, createBrowserDshRpc } from './support/real-dsh-rpc.js'
import { assertPinnedDshRevision, runtimeSection } from './support/real-dsh-runtime.js'
import { upgradeApplication } from './support/upgrade-application.js'

const baselineRoot = process.env.DSH_PHALANX_0113_INSTALL_ROOT
const baselineImage = process.env.DSH_PHALANX_0113_CONTAINER_IMAGE

it.skipIf(!baselineRoot || !baselineImage || !runtimeSettings.containerImage)(
  'preserves formal 0.1.13 grants and selections for plugins, skills and packs, then uses MCP through the installed candidate',
  async () => {
    assertPinnedDshRevision(runtimeSettings)
    const baseline = JSON.parse(await readFile(join(baselineRoot!, 'build-info.json'), 'utf8'))
    expect(baseline.commit).toBe('7b265e0ba3379e5eb9d15ff1510b0fbcc460b72c')
    expect(JSON.parse(await readFile(join(baselineRoot!, 'package.json'), 'utf8')).version).toBe('0.1.13')
    expect((await execFileText('podman', ['image', 'inspect', baselineImage!, '--format', '{{index .Config.Labels "dsh.revision"}}'])).trim()).toBe(
      baseline.versions.dsh.revision,
    )
    // This seam must exercise two installed public commands, never silently fall back to source.
    expect(process.env.DSH_PHALANX_INSTALL_ROOT).toBeTruthy()
    const root = await mkdtemp(join(tmpdir(), 'formal-contributions-upgrade-'))
    let toolCalled = false
    const model = createServer(async (req, res) => {
      let text = ''
      for await (const chunk of req) text += chunk
      const body = JSON.parse(text)
      res.setHeader('content-type', 'text/event-stream')
      if (hasToolResult(body, 'upgrade-call', false)) {
        toolCalled = text.includes('UPGRADE_MCP_READY')
        streamText(res, 'UPGRADE_DONE')
      } else if (hasToolResult(body, 'upgrade-call', true)) streamText(res, 'UPGRADE_FAILED')
      else streamToolCall(res, 'upgrade-call', 'mcp__p-upgrade__upgrade_echo', {})
    })
    model.listen(0, '127.0.0.1')
    await once(model, 'listening')
    const modelOrigin = `http://127.0.0.1:${(model.address() as { port: number }).port}`
    const runtime: CommunityRuntimeConfig = runtimeSection(root, modelOrigin, runtimeSettings)
    const oldRuntime = { ...runtime, container: { ...runtime.container!, image: baselineImage! } }
    const config = { listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'formal-contributions-upgrade-fixture-secret', runtime }
    let app = upgradeApplication({ ...config, runtime: oldRuntime }, baselineRoot, 120000)
    const browser = await chromium.launch({ headless: true })
    const admin = await browser.newContext({ locale: 'en' }),
      member = await browser.newContext({ locale: 'en' })
    let passed = false
    try {
      let origin = await app.start()
      const post = async (path: string, data: object) => {
        const response = await admin.request.post(origin + '/admin/api/' + path, { headers: { origin }, data })
        expect(response.status(), path + ': ' + (await response.text())).toBe(200)
        return response.json()
      }
      const get = async (path: string) => {
        const response = await admin.request.get(origin + '/admin/api/' + path)
        expect(response.status(), path).toBe(200)
        return response.json()
      }
      const select = async (kind: string, data: object) => {
        const response = await member.request.post(origin + '/market/api/' + kind, { headers: { origin }, data })
        expect(response.status(), kind + ': ' + (await response.text())).toBe(200)
      }
      expect(
        (
          await admin.request.post(origin + '/bootstrap', {
            headers: { origin },
            form: { credential: readBootstrapCredential(root)!.credential, username: 'admin', password: 'password' },
            maxRedirects: 0,
          })
        ).status(),
      ).toBe(303)
      expect(
        (
          await admin.request.post(origin + '/admin/api/accounts', {
            headers: { origin },
            data: { username: 'member', password: 'password', email: 'member@example.test' },
          })
        ).status(),
      ).toBe(201)
      const group = (await get('groups')).find((row: { isDefault: boolean }) => row.isDefault)
      const beforeAccounts = await get('accounts')
      const page = await member.newPage()
      page.setDefaultTimeout(30000)
      await signInCommunity(page, origin, 'member', 'password')
      const memberEntry = new URL(page.url()).pathname
      for (const mode of ['managed', 'selected']) {
        const packageName = '@example/upgrade-' + mode,
          source = join(root, mode)
        await mkdir(source)
        await writeFile(
          join(source, 'package.json'),
          JSON.stringify({ name: packageName, version: '1.0.0', type: 'module', main: './index.js', dsh: { bundle: { patch: './patch.yml' } } }),
        )
        await writeFile(join(source, 'index.js'), `export const name='upgrade-${mode}'; export function apply(){}`)
        await writeFile(join(source, 'patch.yml'), JSON.stringify([{ insert: [{ id: 'upgrade-' + mode, name: packageName }] }]))
        const packed = JSON.parse(await execFileText('npm', ['pack', source, '--ignore-scripts', '--json', '--pack-destination', root])) as {
          filename: string
        }[]
        expect(
          (
            await admin.request.post(origin + '/admin/api/plugins/upload', {
              headers: { origin, 'content-type': 'application/gzip', 'x-plugin-filename': mode + '.tgz' },
              data: await readFile(join(root, packed[0]!.filename)),
            })
          ).status(),
        ).toBe(202)
        await expect
          .poll(async () => (await get('plugins')).find((row: { packageName: string }) => row.packageName === packageName)?.stage, { timeout: 300000 })
          .toBe('available')
        await post('plugins/publication', { action: 'publish', packageName, published: true, confirmed: true })
        for (const kind of ['direct', 'child']) {
          const name = mode + '-' + kind
          const upload = await admin.request.post(origin + '/admin/api/skills/upload', {
            headers: { origin, 'content-type': 'application/zip' },
            data: skillZip([{ path: 'SKILL.md', content: `---\nname: ${name}\ndescription: Upgrade retained ${name}\n---\nPreserve ${name}.` }]),
          })
          expect(upload.status()).toBe(200)
          const preview = await upload.json()
          await post('skills/change', { action: 'confirm', token: preview.token, revision: preview.revision })
          const detail = await get('skills/detail?name=' + name)
          await post('skills/change', { action: 'publish', name, published: true, revision: detail.revision })
        }
        await post('skill-packs', {
          action: 'save',
          revision: (await get('skill-packs')).revision,
          pack: { name: mode + '-pack', description: 'Retain ' + mode, skills: [mode + '-child'], instructions: 'Keep this orchestration.', published: true },
        })
      }
      await post(`groups/${group.id}/plugins`, {
        action: 'save',
        packages: ['@example/upgrade-managed'],
        preinstalls: [],
        revision: (await get(`groups/${group.id}/plugins`)).revision,
      })
      await post(`groups/${group.id}/skills`, {
        action: 'save',
        names: ['managed-direct'],
        packs: ['managed-pack'],
        revision: (await get(`groups/${group.id}/skills`)).revision,
        confirmed: true,
      })
      await select('plugins', { action: 'install', packageName: '@example/upgrade-selected' })
      await select('skills', { action: 'install', name: 'selected-direct' })
      await select('skill-packs', { action: 'install', name: 'selected-pack' })
      expect((await member.request.post(origin + '/recovery/restart', { headers: { origin }, data: { confirmed: true } })).status()).toBe(200)
      const rpc = createBrowserDshRpc(member)
      const assertPlugins = async () => {
        const rows = await rpc.remoteRpc<{ moduleName: string; fiberPhase: string }[]>(
          origin,
          await cookieHeader(member, origin),
          'pluginManager/listPlugins',
          {},
        )
        for (const mode of ['managed', 'selected'])
          expect(rows.some(row => row.moduleName.includes('@example/upgrade-' + mode) && row.fiberPhase === 'active')).toBe(true)
      }
      await assertPlugins()
      const paths = [
        'plugins/grants.json',
        'plugins/selections.json',
        'skills/grants.json',
        'skills/selections.json',
        'skills/packs.json',
        'skills/pack-grants.json',
        'skills/pack-selections.json',
      ]
      const before = await Promise.all(paths.map(path => readFile(join(root, path), 'utf8')))
      const beforePlugins = await get('plugins')
      const beforeSkills = await get('skills'),
        beforePacks = (await get('skill-packs')).packs
      const home = join(effectiveUserDataRoot({ dataRoot: root }), 'member/home')
      await writeFile(join(home, 'upgrade-owned.txt'), 'member data retained')
      await page.close()
      await app.stop()
      await new CommunityRuntimeDriver(oldRuntime).rebuild()
      app = candidateApplication(config, 120000)
      origin = await app.start()
      expect(
        (await admin.request.post(origin + '/login', { headers: { origin }, form: { username: 'admin', password: 'password' }, maxRedirects: 0 })).status(),
      ).toBe(303)
      expect(
        (await get('accounts')).items.map((row: { username: string; spaceId: string; groupId: string }) => [row.username, row.spaceId, row.groupId]),
      ).toEqual(beforeAccounts.items.map((row: { username: string; spaceId: string; groupId: string }) => [row.username, row.spaceId, row.groupId]))
      expect(await Promise.all(paths.map(path => readFile(join(root, path), 'utf8')))).toEqual(before)
      const afterSkills = await get('skills'),
        afterPlugins = await get('plugins')
      expect(
        afterSkills.map(({ maintenanceRevision, ...row }: { maintenanceRevision?: string }) => {
          void maintenanceRevision
          return row
        }),
      ).toEqual(beforeSkills)
      expect(
        afterPlugins.map(({ maintenanceRevision, ...row }: { maintenanceRevision?: string }) => {
          void maintenanceRevision
          return row
        }),
      ).toEqual(beforePlugins)
      for (const row of [...afterSkills, ...afterPlugins]) expect(row.provenance?.maintainer ?? null).toBeNull()
      const adminPage = await admin.newPage()
      await adminPage.goto(origin + '/admin/plugins?locale=en')
      await adminPage.getByRole('tab', { name: 'Member contributions', exact: true }).waitFor()
      await adminPage.getByRole('button', { name: 'View plugin @example/upgrade-managed', exact: true }).click()
      await adminPage.getByRole('tab', { name: 'Basic settings', exact: true }).click()
      await adminPage.getByText('No maintainer', { exact: true }).waitFor()
      if (process.env.DSH_PHALANX_E2E_EVIDENCE_DIR)
        await adminPage.screenshot({ path: join(process.env.DSH_PHALANX_E2E_EVIDENCE_DIR, 'formal-upgrade-admin-unowned.png'), fullPage: true })
      await adminPage.close()
      expect((await get('skill-packs')).packs).toEqual(beforePacks)
      expect(await readFile(join(home, 'upgrade-owned.txt'), 'utf8')).toBe('member data retained')
      const upgraded = await member.newPage()
      upgraded.setDefaultTimeout(30000)
      if (process.env.DSH_PHALANX_E2E_CPU_THROTTLE) await (await member.newCDPSession(upgraded)).send('Emulation.setCPUThrottlingRate', { rate: 4 })
      await signInCommunity(upgraded, origin, 'member', 'password')
      expect(new URL(upgraded.url()).pathname).toBe(memberEntry)
      await assertPlugins()
      await upgraded.getByRole('button', { name: 'Platform App Center', exact: true }).click()
      for (const name of ['Plugins', 'Skills', 'Skill packs', 'MCP services']) await upgraded.getByRole('tab', { name, exact: true }).waitFor()
      await upgraded.getByRole('tab', { name: 'Skills', exact: true }).click()
      await upgraded.getByRole('heading', { name: 'selected-direct', exact: true }).waitFor()
      await upgraded.getByRole('tab', { name: 'Skill packs', exact: true }).click()
      await upgraded.getByText('Installed (self-selected pack)', { exact: true }).waitFor()
      await upgraded.getByText('Installed (platform preinstalled)', { exact: true }).waitFor()
      expect((await member.request.get(origin + '/market')).status()).toBe(404)
      const fixture =
        "require('readline').createInterface({input:process.stdin}).on('line',s=>{const b=JSON.parse(s);if(b.id===undefined)return;const result=b.method==='initialize'?{protocolVersion:b.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'upgrade',version:'1'}}:b.method==='tools/list'?{tools:[{name:'upgrade_echo',inputSchema:{type:'object'}}]}:{content:[{type:'text',text:'UPGRADE_MCP_READY'}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:b.id,result})+'\\n')})"
      await post('mcp', {
        action: 'save',
        service: {
          name: 'p-upgrade',
          description: 'Installed upgrade fixture',
          url: '',
          run: { location: 'member', command: 'node', args: ['-e', fixture], env: [], prepareCommand: '' },
        },
      })
      await expect.poll(async () => (await get('mcp'))[0]?.preparation?.stage, { timeout: 120000 }).toBe('ready')
      await post(`groups/${group.id}/mcp`, { names: ['p-upgrade'] })
      await upgraded.getByRole('tab', { name: 'MCP services', exact: true }).click()
      await upgraded.getByText('p-upgrade', { exact: true }).waitFor()
      await post('models', {
        revision: (await get('models')).revision,
        action: 'save-provider',
        provider: {
          name: 'Upgrade fixture',
          baseUrl: modelOrigin + '/anthropic',
          apiFormat: 'anthropic-messages',
          apiKey: 'fictional-model-key',
          enabled: true,
          models: [{ name: 'fixture-model', enabled: true }],
        },
      })
      const session = await rpc.remoteRpc<{ sessionId: string }>(origin, await cookieHeader(member, origin), 'session/create', {
        request: { cwd: '/dsh-phalanx/workspace' },
      })
      await rpc.remoteRpc(origin, await cookieHeader(member, origin), 'session/prompt', {
        request: { requestId: randomUUID(), sessionId: session.sessionId, mode: 'queue', content: [{ type: 'text', text: 'CALL_UPGRADED_MCP' }] },
      })
      await expect.poll(() => toolCalled, { timeout: 60000 }).toBe(true)
      if (process.env.DSH_PHALANX_E2E_EVIDENCE_DIR)
        await upgraded.screenshot({ path: join(process.env.DSH_PHALANX_E2E_EVIDENCE_DIR, 'formal-upgrade-contributions-native.png'), fullPage: true })
      passed = true
      console.info('Formal 0.1.13 installed upgrade: grants/selections/plugins/skills/packs/member files retained; installed MCP tool called through DSH')
    } finally {
      await browser.close()
      await app.stop()
      model.closeAllConnections()
      await new Promise<void>(resolve => model.close(() => resolve()))
      await new CommunityRuntimeDriver(runtime).rebuild()
      const artifacts = new FileSkillArtifacts(join(root, 'skills/artifacts'), [])
      await new FileSkillDistribution(join(root, 'skills/members'), artifacts).synchronize([])
      await artifacts.collect([])
      if (passed) {
        await new FileExecutionArtifacts(join(root, 'runtime-dependencies', '.trees')).collect([])
        await removeCommunityFixture(root)
      } else console.info('Failed upgrade fixture retained at', root)
    }
  },
  420000,
)
