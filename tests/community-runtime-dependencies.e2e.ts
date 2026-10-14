import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { createCommunityApplication } from '../src/composition/community-application.js'
import { FileExecutionArtifacts } from '../src/adapters/execution-artifacts.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'

it('manages dependencies in the administration shell, showing preparation checks, retries and reference protections', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dependency-admin-'))
  const app = createCommunityApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'dependency-admin-fixture-secret-32', runtime: { command: '/unavailable', args: [], dataRoot: root, defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'https://example.test' } } } })
  const browser = await chromium.launch({ headless: true })
  try {
    const origin = await app.start(), page = await browser.newPage({ locale: 'en', viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(10000)
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
    await page.goto(`${origin}/bootstrap#credential=${readBootstrapCredential(root)!.credential}`)
    await page.getByLabel('Username', { exact: true }).fill('admin'); await page.getByLabel('Password', { exact: true }).fill('password')
    await page.getByRole('button', { name: 'Create administrator' }).click(); await page.waitForURL(`${origin}/admin`)
    await page.getByRole('link', { name: 'Runtime dependencies', exact: true }).click()
    await page.getByRole('button', { name: 'Create runtime dependency', exact: true }).click()
    await page.getByLabel('Dependency name', { exact: true }).fill('example')
    await page.getByLabel('PATH directories', { exact: true }).fill('bin')
    await page.getByLabel('Check command', { exact: true }).fill('example')
    await page.getByRole('button', { name: /Preparation example/ }).click()
    await page.getByRole('option', { name: 'npm package', exact: true }).click()
    expect(await page.getByLabel('Prepare command', { exact: true }).inputValue()).toContain('--prefix "$RD_OUT"')
    expect(await page.getByLabel('PATH directories', { exact: true }).inputValue()).toBe('bin')
    expect(await page.getByLabel('Check command', { exact: true }).inputValue()).toBe('example')
    await page.getByLabel('Prepare command', { exact: true }).fill('echo preparation-diagnostic; node -e "console.log(require(\'node:crypto\').randomUUID())"; exit 9')
    await page.getByRole('button', { name: 'Start preparation', exact: true }).click()
    const drawer = page.getByRole('dialog', { name: 'example', exact: true })
    await drawer.getByText('Preparation failed', { exact: true }).first().waitFor()
    await expect.poll(() => drawer.getByLabel('Full preparation and check log').inputValue()).toContain('preparation-diagnostic')
    const previousLog = await drawer.getByLabel('Full preparation and check log').inputValue()
    const retried = page.waitForResponse(response => response.url() === origin + '/admin/api/runtime-dependencies' && response.request().method() === 'POST' && response.request().postDataJSON().action === 'prepare')
    await drawer.getByRole('button', { name: 'Retry preparation', exact: true }).click()
    expect((await retried).status()).toBe(202)
    await expect.poll(async () => { const row = await (await page.request.get(origin + '/admin/api/runtime-dependencies?name=example')).json(); return row.stage === 'failed' && row.log !== previousLog && row.log.includes('preparation-diagnostic') }).toBe(true)
    await drawer.getByRole('button', { name: 'Delete dependency', exact: true }).click()
    await page.getByRole('dialog', { name: 'Delete runtime dependency', exact: true }).getByRole('button', { name: 'Delete dependency', exact: true }).click()
    await page.getByText('No runtime dependencies yet', { exact: true }).waitFor()
    const created = await page.request.post(origin + '/admin/api/runtime-dependencies', { headers: { origin }, data: { action: 'create', input: { name: 'ready', prepareCommand: 'mkdir bin; printf "#!/bin/sh\\necho check-output\\n" > bin/example; chmod +x bin/example', pathDirectories: ['bin'], checkCommand: 'example' } } }); expect(created.status()).toBe(202)
    await expect.poll(async () => (await (await page.request.get(origin + '/admin/api/runtime-dependencies?name=ready')).json()).stage).toBe('ready')
    // References are connected in tickets 07–09; exercise this page's existing wire seam now.
    await page.route('**/admin/api/runtime-dependencies', async route => {
      const response = await route.fetch(), rows = await response.json()
      await route.fulfill({ response, json: rows.map((row: object) => ({ ...row, source: 'mcp-catalog', references: [{ kind: 'mcp', name: 'p-example' }] })) })
    })
    await page.reload(); await page.getByRole('button', { name: 'View dependency ready', exact: true }).click()
    const ready = page.getByRole('dialog', { name: 'ready', exact: true })
    await expect.poll(() => ready.getByLabel('Full preparation and check log').inputValue()).toContain('check-output')
    await ready.getByRole('tab', { name: 'Definition and references', exact: true }).click()
    expect(await ready.getByRole('button', { name: 'Delete dependency', exact: true }).isDisabled()).toBe(true)
    await ready.getByText('MCP service · p-example', { exact: true }).waitFor(); await ready.getByText('Managed by the MCP catalog. Definition is read-only.', { exact: true }).waitFor()
    if (process.env.DSH_PHALANX_E2E_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.DSH_PHALANX_E2E_EVIDENCE_DIR, 'runtime-dependency-desktop.png'), fullPage: true, animations: 'disabled' })
    await ready.getByRole('button', { name: 'Close dependency details', exact: true }).click()
    await page.setViewportSize({ width: 390, height: 844 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    if (process.env.DSH_PHALANX_E2E_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.DSH_PHALANX_E2E_EVIDENCE_DIR, 'runtime-dependency-mobile.png'), fullPage: true })
    expect((await page.request.post(origin + '/admin/api/accounts', { headers: { origin }, data: { username: 'member', email: 'member@example.test', password: 'password' } })).status()).toBe(201)
    const memberContext = await browser.newContext({ locale: 'en' }), member = await memberContext.newPage()
    await member.request.post(origin + '/login', { form: { username: 'member', password: 'password' } })
    expect((await member.request.get(origin + '/admin/api/runtime-dependencies')).status()).toBe(403)
    await member.goto(origin + '/market')
    expect(await member.getByText('Runtime dependencies', { exact: true }).count()).toBe(0)
    await memberContext.close()
    expect(errors).toEqual([])
  } finally { await browser.close(); await app.stop(); await new FileExecutionArtifacts(join(root, 'runtime-dependencies', '.trees')).collect([]); await rm(root, { recursive: true, force: true }) }
})
