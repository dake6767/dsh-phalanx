// Validation: T1; real credentials: none; real HTTP registry, shell preparation and controlled browser.
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { afterEach, expect, it, vi } from 'vitest'
import { PlatformProcessHost } from '../src/adapters/platform-process-host.js'
import { candidateApplication as createCommunityApplication } from './support/candidate-application.js'
import { FileExecutionArtifacts } from '../src/adapters/execution-artifacts.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'

afterEach(() => { vi.restoreAllMocks() })

it('persists administrator download choices and uses the changed registry when dependencies are prepared again', async () => {
  // T1 controls the host-availability seam; npm and the HTTP registry remain real.
  // Ubuntu runners may have podman installed without any DSH image.
  vi.spyOn(PlatformProcessHost.prototype, 'detect').mockResolvedValue()
  const requests: string[] = []
  const registry = createServer((request, response) => {
    requests.push(request.url ?? '')
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ name: 'fixture-package', 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': { name: 'fixture-package', version: '1.0.0' } } }))
  })
  registry.listen(0, '127.0.0.1'); await once(registry, 'listening')
  const registryRoot = `http://127.0.0.1:${(registry.address() as import('node:net').AddressInfo).port}`
  const root = await mkdtemp(join(tmpdir(), 'download-source-browser-'))
  const config = { listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'download-source-fixture-secret-32', runtime: { command: '/unavailable', args: [], dataRoot: root, defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'https://example.test' } } } }
  const priorSources = process.env.DSH_PHALANX_DOWNLOAD_SOURCES
  process.env.DSH_PHALANX_DOWNLOAD_SOURCES = JSON.stringify({ preset: 'official', overrides: { npm: `${registryRoot}/initial` } })
  let app
  try { app = createCommunityApplication(config) }
  finally { if (priorSources === undefined) delete process.env.DSH_PHALANX_DOWNLOAD_SOURCES; else process.env.DSH_PHALANX_DOWNLOAD_SOURCES = priorSources }
  const browser = await chromium.launch({ headless: true })
  try {
    let origin = await app.start()
    const page = await browser.newPage({ locale: 'en' }); page.setDefaultTimeout(10000)
    await page.goto(`${origin}/bootstrap#credential=${readBootstrapCredential(root)!.credential}`)
    await page.getByLabel('Username', { exact: true }).fill('admin'); await page.getByLabel('Password', { exact: true }).fill('password')
    await page.getByRole('button', { name: 'Create administrator' }).click(); await page.waitForURL(`${origin}/admin`)
    await page.getByRole('link', { name: 'System settings', exact: true }).click()
    const panel = page.getByRole('region', { name: 'Download sources', exact: true })
    expect(await panel.getByLabel('npm registry', { exact: true }).inputValue()).toBe(`${registryRoot}/initial`)
    await panel.getByLabel('npm registry', { exact: true }).fill(`${registryRoot}/first`)
    await panel.getByRole('button', { name: 'Save download sources', exact: true }).click()
    await panel.getByText('Download sources saved.', { exact: true }).waitFor()
    const create = await page.request.post(`${origin}/admin/api/runtime-dependencies`, { headers: { origin }, data: { action: 'create', input: { name: 'download-probe', prepareCommand: 'set -eu; npm view fixture-package version --update-notifier=false --fetch-retries=0; mkdir bin; printf "#!/bin/sh\\necho ready\\n" > bin/probe; chmod +x bin/probe', pathDirectories: ['bin'] } } })
    expect(create.ok()).toBe(true)
    const ready = async () => { const response = await page.request.get(`${origin}/admin/api/runtime-dependencies`); const rows = await response.json(); const row = rows.find((row: { name: string }) => row.name === 'download-probe'); if (row?.stage === 'failed') throw new Error(row.log); return row }
    await expect.poll(async () => (await ready())?.stage, { timeout: 20000 }).toBe('ready')
    expect(requests).toContain('/first/fixture-package')
    await panel.getByRole('button', { name: /Download preset/u }).click()
    await page.getByRole('option', { name: 'Mainland China', exact: true }).click()
    expect(await panel.getByLabel('npm registry', { exact: true }).inputValue()).toBe('https://registry.npmmirror.com')
    await panel.getByLabel('npm registry', { exact: true }).fill(`${registryRoot}/second`)
    await panel.getByRole('button', { name: 'Save download sources', exact: true }).click()
    await panel.getByText('Download sources saved.', { exact: true }).waitFor()
    requests.length = 0
    const prepared = await page.request.post(`${origin}/admin/api/runtime-dependencies`, { headers: { origin }, data: { action: 'prepare', name: 'download-probe' } })
    expect(prepared.ok()).toBe(true)
    await expect.poll(async () => (await ready())?.log ?? '', { timeout: 20000 }).toContain(`${registryRoot}/second`)
    await expect.poll(async () => (await ready())?.stage, { timeout: 20000 }).toBe('ready')
    expect(requests).toContain('/second/fixture-package')
    expect(requests).not.toContain('/first/fixture-package')
    await app.stop(); app = createCommunityApplication(config); origin = await app.start()
    await page.goto(`${origin}/admin/settings`)
    expect(await panel.getByLabel('npm registry', { exact: true }).inputValue()).toBe(`${registryRoot}/second`)
  } finally { await browser.close(); await app.stop(); await new FileExecutionArtifacts(join(root, 'runtime-dependencies/.trees')).collect([]); registry.closeAllConnections(); await new Promise<void>(resolve => registry.close(() => resolve())); await rm(root, { recursive: true, force: true }) }
}, 60000)
