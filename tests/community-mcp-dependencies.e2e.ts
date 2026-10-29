// Validation: T1; real credentials: none; controlled browser/process fixtures. CI selects its explicit public-entry subset.
import { chmod, lstat, mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { removeCommunityFixture } from './fixtures/owned-cleanup.js'
import { createCommunityApplication } from './support/community-application.js'
import { selectBuiltinDatabase } from './support/community-bootstrap-browser.js'

it('selects prepared dependencies in the existing MCP editor and retains its tabs and saved references', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-dependency-admin-'))
  const app = createCommunityApplication({
    listen: { host: '127.0.0.1', port: 0 },
    sessionSecret: 'mcp-dependency-admin-fixture-secret-32',
    runtime: {
      command: '/unavailable',
      args: [],
      dataRoot: root,
      defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'https://example.test' } },
    },
  })
  const browser = await chromium.launch({ headless: true })
  try {
    const origin = await app.start(),
      page = await browser.newPage({ locale: 'en', viewport: { width: 1440, height: 1000 } })
    page.setDefaultTimeout(15000)
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`${origin}/bootstrap#credential=${readBootstrapCredential(root)!.credential}`)
    await selectBuiltinDatabase(page)
    await page.getByLabel('Username', { exact: true }).fill('admin')
    await page.getByLabel('Password', { exact: true }).fill('password')
    await page.getByRole('button', { name: 'Create administrator' }).click()
    await page.waitForURL(`${origin}/admin`)
    const post = (path: string, data: unknown) => page.request.post(origin + '/admin/api/' + path, { headers: { origin }, data })
    expect(
      (
        await post('runtime-dependencies', {
          action: 'create',
          input: {
            name: 'fixture',
            prepareCommand: 'mkdir bin; printf "#!/bin/sh\\necho ready\\n" > bin/fixture; chmod +x bin/fixture',
            pathDirectories: ['bin'],
          },
        })
      ).status(),
    ).toBe(202)
    await expect.poll(async () => (await (await page.request.get(origin + '/admin/api/runtime-dependencies?name=fixture')).json()).stage).toBe('ready')
    await page.getByRole('link', { name: 'MCP library', exact: true }).click()
    await page.getByRole('button', { name: 'Add MCP service', exact: true }).click()
    await page.getByLabel('MCP service name', { exact: true }).fill('p-tools')
    await page.getByRole('button', { name: /Run location/ }).click()
    await page.getByRole('option', { name: 'Shared run', exact: true }).click()
    await page.getByLabel('MCP command', { exact: true }).fill('fixture')
    const dependency = page.getByRole('checkbox', { name: 'fixture', exact: true })
    await page.getByRole('dialog').getByText('fixture', { exact: true }).first().click()
    expect(await dependency.isChecked()).toBe(true)
    expect(await page.getByLabel('Prepare command', { exact: true }).count()).toBe(0)
    for (const name of ['Basic information', 'Access settings', 'MCP tools']) expect(await page.getByRole('tab', { name, exact: true }).count()).toBe(1)
    const evidence = process.env.DSH_PHALANX_E2E_EVIDENCE_DIR
    if (evidence) await page.screenshot({ path: join(evidence, 'mcp-dependency-picker-desktop.png'), fullPage: true })
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await page.getByRole('row').filter({ hasText: 'p-tools' }).getByRole('button', { name: 'Edit', exact: true }).click()
    expect(await dependency.isChecked()).toBe(true)
    const services = await (await page.request.get(origin + '/admin/api/mcp')).json()
    expect(services[0].run).toMatchObject({ command: 'fixture', runtimeDependencies: ['fixture'] })
    expect(services[0].run).not.toHaveProperty('prepareCommand')
    expect((await post('runtime-dependencies', { action: 'remove', name: 'fixture' })).status()).toBe(409)
    expect(errors).toEqual([])
  } finally {
    await browser.close()
    await app.stop()
    const writable = async (path: string): Promise<void> => {
      if ((await lstat(path)).isDirectory()) {
        await chmod(path, 0o700)
        for (const name of await readdir(path)) await writable(join(path, name))
      }
    }
    await writable(root)
    await removeCommunityFixture(root)
  }
})
