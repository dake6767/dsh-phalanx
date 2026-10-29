// Validation: T4 only; real credentials: required (provider keys or deployed account). Never selected by T2.
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { chmod, lstat, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser } from 'playwright'
import { expect, it } from 'vitest'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import { execFileText } from '../src/adapters/runtime-command.js'
import type { CommunityMcpSettings } from '../src/domain/admin-contract.js'
import { signInCommunity } from './fixtures/community-native-browser.js'
import { removeCommunityFixture } from './fixtures/owned-cleanup.js'
import { candidateApplication } from './support/candidate-application.js'
import { openCommunityHttpEntry } from './support/community-http-entry.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { hasToolResult, streamText, streamToolCall } from './support/real-dsh-model.js'
import { cookieHeader, createRealDshRpc } from './support/real-dsh-rpc.js'
import { assertPinnedDshRevision, runtimeSection } from './support/real-dsh-runtime.js'
import { memberExposesMcpCredentials, readPrivateMcpCredential } from './support/real-mcp-credentials.js'
import { amapSample, bochaSample } from './support/real-mcp-samples.js'
import { readUsageRecords } from './support/usage-records.js'
import { verifiedBochaInput } from './support/verified-bocha-input.js'

const samples = [
  {
    service: amapSample,
    keyFile: process.env.DSH_PHALANX_AMAP_API_KEY_FILE,
    tool: 'maps_weather',
    args: { city: '110000' },
    valid: (text: string) => /北京市|北京/u.test(text) && /weather|天气|temperature|温度/u.test(text),
  },
  {
    service: bochaSample,
    keyFile: process.env.DSH_PHALANX_BOCHA_API_KEY_FILE,
    tool: 'bocha_web_search',
    args: { query: 'Python official documentation', count: 1 },
    valid: (text: string) => text.includes('Title:') && text.includes('URL:'),
  },
]
for (const sample of samples) {
  const { service: sampleService, keyFile } = sample

  it.skipIf(!keyFile || !runtimeSettings.containerImage)(
    `calls official ${sampleService.name} through real DSH with private credentials`,
    async () => {
      let service = sampleService
      assertPinnedDshRevision(runtimeSettings)
      const secret = await readPrivateMcpCredential(keyFile!)
      let called = false,
        exposed = false,
        semanticResult = false,
        failed = false,
        tools: string[] = [],
        passed = false,
        preparation: unknown,
        failureReason = ''
      const model = createServer(async (request, response) => {
        let text = ''
        for await (const chunk of request) text += chunk
        exposed ||= text.includes(secret)
        const body = JSON.parse(text)
        tools = (body.tools ?? []).map((row: { name: string }) => row.name).filter((name: string) => name.startsWith('mcp__' + service.name + '__'))
        response.setHeader('content-type', 'text/event-stream')
        if (hasToolResult(body, 'sample-read', false)) {
          called = true
          const blocks = (body.messages ?? [])
            .flatMap((row: { content?: unknown }) => (Array.isArray(row.content) ? row.content : []))
            .filter((block: { type?: string; tool_use_id?: string }) => block.type === 'tool_result' && block.tool_use_id === 'sample-read')
          semanticResult = sample.valid(JSON.stringify(blocks))
          if (!semanticResult)
            failureReason = JSON.stringify(blocks).replaceAll(secret, '[redacted]').replaceAll(encodeURIComponent(secret), '[redacted]').slice(0, 2000)
          streamText(response, 'SAMPLE_READ_DONE')
        } else if (hasToolResult(body, 'sample-read', true)) {
          failed = true
          failureReason = JSON.stringify(
            (body.messages ?? [])
              .flatMap((row: { content?: unknown }) => (Array.isArray(row.content) ? row.content : []))
              .filter((block: { type?: string; tool_use_id?: string }) => block.type === 'tool_result' && block.tool_use_id === 'sample-read'),
          )
            .replaceAll(secret, '[redacted]')
            .replaceAll(encodeURIComponent(secret), '[redacted]')
            .slice(0, 2000)
          streamText(response, 'SAMPLE_READ_FAILED')
        } else streamToolCall(response, 'sample-read', 'mcp__' + service.name + '__' + sample.tool, sample.args)
      })
      model.listen(0, '127.0.0.1')
      await once(model, 'listening')
      const modelOrigin = `http://127.0.0.1:${(model.address() as { port: number }).port}`
      const root = await mkdtemp(join(tmpdir(), 'real-private-mcp-'))
      const base = runtimeSection(root, modelOrigin, runtimeSettings)
      const fixture = service.name === 'p-bocha' ? await verifiedBochaInput(base) : { runtime: base, service }
      const runtime = fixture.runtime
      service = fixture.service
      const app = candidateApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'real-private-fixture-session-secret', runtime })
      const rpc = createRealDshRpc()
      const cookie = (response: Response) =>
        response.headers
          .getSetCookie()
          .map(value => value.split(';')[0])
          .join('; ')
      let count = 0,
        memberBrowser: Browser | undefined
      try {
        const origin = await app.start()
        const bootstrap = await fetch(origin + '/bootstrap', {
          method: 'POST',
          redirect: 'manual',
          headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ credential: readBootstrapCredential(root)!.credential, username: 'admin', password: 'password' }),
        })
        expect(bootstrap.status).toBe(303)
        const admin = cookie(bootstrap)
        // Do not include request bodies, response bodies or credential values in assertion diagnostics.
        const post = (path: string, body: object) =>
          fetch(origin + '/admin/api/' + path, {
            method: 'POST',
            headers: { cookie: admin, origin, 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
        const settings = await (await fetch(origin + '/admin/api/models', { headers: { cookie: admin } })).json()
        expect(
          (
            await post('models', {
              revision: settings.revision,
              action: 'save-provider',
              provider: {
                name: 'Fixture',
                baseUrl: modelOrigin + '/anthropic',
                apiFormat: 'anthropic-messages',
                apiKey: 'fictional-model-key',
                enabled: true,
                models: [{ name: 'fixture-model', enabled: true }],
              },
            })
          ).status,
        ).toBe(200)
        const created = await post('accounts', { username: 'member', password: 'password', email: '' })
        expect(created.status).toBe(201)
        const account = (await created.json()) as { spaceId: string; groupId: string }
        if (service.name === 'p-amap') {
          const browser = await chromium.launch({ headless: true })
          try {
            const page = await browser.newPage({ locale: 'en' })
            page.setDefaultTimeout(60000)
            await page.goto(origin + '/login')
            await page.getByLabel('Username', { exact: true }).fill('admin')
            await page.getByLabel('Password', { exact: true }).fill('password')
            await page.getByRole('button', { name: /^Sign in/u }).click()
            await page.waitForURL(origin + '/admin')
            await page.getByRole('link', { name: 'MCP library', exact: true }).click()
            await page.getByRole('tab', { name: 'MCP catalog', exact: true }).click()
            await page.getByRole('button', { name: 'View MCP service Amap', exact: true }).click()
            await page.getByLabel('Amap Web Service Key', { exact: true }).fill(secret)
            await page.getByRole('button', { name: 'Import MCP service', exact: true }).click()
            await page.getByText('Import ready', { exact: true }).waitFor()
          } finally {
            await browser.close()
          }
        } else expect((await post('mcp', { action: 'save', service: { ...service, credential: secret } })).status).toBe(200)
        if (service.run) {
          await expect
            .poll(
              async () => {
                const library = await (await fetch(origin + '/admin/api/mcp', { headers: { cookie: admin } })).json()
                preparation = library.find((row: { name: string }) => row.name === service.name)?.preparation
                return (preparation as { stage?: string })?.stage
              },
              { timeout: 660000 },
            )
            .toMatch(/^(ready|failed)$/u)
          expect((preparation as { stage?: string })?.stage).toBe('ready')
        }
        const tested = await post('mcp/test', { name: service.name })
        expect(tested.status).toBe(200)
        const discovered = (await tested.json()) as CommunityMcpSettings
        expect(discovered.testStatus).toBe('passed')
        count = discovered.tools.length
        expect(discovered.tools.some(tool => tool.name === sample.tool)).toBe(true)
        expect(JSON.stringify(discovered).includes(secret)).toBe(false)
        if (service.name === 'p-amap') expect((await post('mcp', { action: 'publish', name: service.name, published: true })).status).toBe(200)
        else expect((await post(`groups/${account.groupId}/mcp`, { names: [service.name] })).status).toBe(200)
        const login = await fetch(origin + '/login', {
          method: 'POST',
          redirect: 'manual',
          headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ username: 'member', password: 'password' }),
        })
        expect(login.status).toBe(303)
        let member = cookie(login)
        if (service.name === 'p-amap') {
          memberBrowser = await chromium.launch({ headless: true })
          const page = await memberBrowser.newPage({ locale: 'en', viewport: { width: 1440, height: 1000 } })
          page.setDefaultTimeout(60000)
          await signInCommunity(page, origin, 'member', 'password')
          await page.getByRole('button', { name: 'Platform App Center', exact: true }).click()
          await page.getByRole('tab', { name: 'MCP services', exact: true }).click()
          const toggle = page.getByRole('switch', { name: 'Enable MCP service p-amap', exact: true })
          await expect.poll(() => toggle.getAttribute('aria-checked')).toBe('false')
          await toggle.click()
          await expect.poll(() => toggle.getAttribute('aria-checked')).toBe('true')
          if (process.env.DSH_PHALANX_E2E_EVIDENCE_DIR)
            await page.screenshot({ path: join(process.env.DSH_PHALANX_E2E_EVIDENCE_DIR, 'amap-member-enabled.png'), fullPage: true })
          member = await cookieHeader(page.context(), origin)
        } else member = (await openCommunityHttpEntry(origin, member, 300000)).cookie
        const session = await rpc.remoteRpc<{ sessionId: string }>(origin, member, 'session/create', { request: { cwd: '/dsh-phalanx/workspace' } })
        await rpc.remoteRpc(origin, member, 'session/prompt', {
          request: { requestId: randomUUID(), sessionId: session.sessionId, mode: 'queue', content: [{ type: 'text', text: 'CALL_SAMPLE_READ' }] },
        })
        await expect.poll(() => called || failed, { timeout: 90000 }).toBe(true)
        expect(tools).toContain('mcp__' + service.name + '__' + sample.tool)
        expect(exposed).toBe(false)
        const owner = createHash('sha256').update(root).digest('hex')
        const carrier = (await execFileText('podman', ['ps', '--filter', `label=dsh-phalanx.community-root=${owner}`, '--format', '{{.Names}}']))
          .trim()
          .split('\n')
          .filter(name => name.startsWith('dsh-phalanx-member-'))
          .join('\n')
        expect(Boolean(carrier) && !carrier.includes('\n')).toBe(true)
        const exec = (code: string) =>
          execFileText('podman', ['exec', carrier, 'node', '-e', code]).catch(async () => {
            throw Error('Member inspection command failed; output suppressed')
          })
        expect(await memberExposesMcpCredentials(carrier, [secret])).toBe(false)
        expect(JSON.stringify(await readUsageRecords(origin, admin)).includes(secret)).toBe(false)
        const sharedOwner = createHash('sha256').update(root).digest('hex')
        const sharedCarriers = async () =>
          (await execFileText('podman', ['ps', '--filter', `label=dsh-phalanx.mcp-shared=${sharedOwner}`, '--format', '{{.ID}}']))
            .trim()
            .split(/\s+/u)
            .filter(Boolean)
        if (service.run?.location === 'shared') {
          const ids = await sharedCarriers()
          expect(ids.length).toBeGreaterThan(0)
          const inspection = JSON.parse(await execFileText('podman', ['inspect', ...ids]))
          expect(JSON.stringify(inspection).includes(secret)).toBe(false)
          for (const row of inspection) {
            const mounts = row.Mounts.filter((mount: { Type: string }) => mount.Type === 'bind')
            expect(mounts).toHaveLength(1)
            expect(mounts[0].RW).toBe(false)
            expect(JSON.stringify(mounts).includes('/users/')).toBe(false)
          }
        }
        if (service.name === 'p-amap') expect((await post('mcp', { action: 'publish', name: service.name, published: false })).status).toBe(200)
        else expect((await post(`groups/${account.groupId}/mcp`, { names: [] })).status).toBe(200)
        if (service.run?.location === 'shared') await expect.poll(sharedCarriers, { timeout: 15000 }).toEqual([])
        const revoked = await exec(
          "fetch(new URL('/mcp/" +
            service.name +
            "',process.env.DSH_PHALANX_MODEL_GATEWAY_URL),{method:'POST',headers:{authorization:'Bearer '+process.env.DSH_PHALANX_MODEL_GATEWAY_ACCESS_TOKEN,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:78,method:'tools/list'})}).then(r=>process.stdout.write(String(r.status)))",
        )
        expect(revoked).toBe('403')
        expect(called).toBe(true)
        expect(failed).toBe(false)
        expect(semanticResult).toBe(true)
        passed = true
      } catch (error) {
        throw new Error(String(error).replaceAll(secret, '[redacted]').replaceAll(encodeURIComponent(secret), '[redacted]'))
      } finally {
        await memberBrowser?.close()
        await app.stop()
        await new CommunityRuntimeDriver(runtime).rebuild()
        model.closeAllConnections()
        await new Promise<void>(resolve => model.close(() => resolve()))
        const writable = async (path: string): Promise<void> => {
          if ((await lstat(path)).isDirectory()) {
            await chmod(path, 0o700)
            for (const name of await readdir(path)) await writable(join(path, name))
          }
        }
        await writable(root)
        await removeCommunityFixture(root)
        if (process.env.DSH_PHALANX_E2E_EVIDENCE_DIR)
          await writeFile(
            join(process.env.DSH_PHALANX_E2E_EVIDENCE_DIR, service.name + '-result.json'),
            JSON.stringify({
              passed,
              discoveredTools: count,
              called,
              semanticResult,
              failed,
              credentialExposed: exposed,
              failureReason,
              preparation,
            }).replaceAll(secret, '[redacted]') + '\n',
          )
      }
    },
    900000,
  )
}
