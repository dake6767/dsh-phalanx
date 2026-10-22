// Validation: T1; real credentials: none; controlled browser/process fixtures. CI selects its explicit public-entry subset.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { createCommunityApplication } from '../src/composition/community-application.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { declaredRuntimeRevision } from '../src/adapters/runtime-revision.js'

it('edits explicit plugin and expert grants for ordinary and administrator groups through HeroUI', async () => {
  const root = await mkdtemp(join(tmpdir(), 'managed-grants-ui-'))
  const app = createCommunityApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'managed-grants-ui-fixture-secret-value', runtime: { command: '/unavailable', args: [], dataRoot: root, defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'https://example.test' } } } }, {
    pluginPreparer: { prepare: async input => ({ ...input, title: 'Shared sidebar', description: '', artifact: 'artifacts/fixture', integrity: 'sha512-fixture', runtimeRevision: declaredRuntimeRevision(), bundlePatch: '[]', dependencies: {} }) },
  })
  const browser = await chromium.launch({ headless: true })
  try {
    const origin = await app.start(); const page = await browser.newPage({ locale: 'en' }); page.setDefaultTimeout(15000)
    const cdp = await page.context().newCDPSession(page)
    if (process.env.DSH_PHALANX_E2E_CPU_THROTTLE) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
    await page.goto(`${origin}/bootstrap#credential=${readBootstrapCredential(root)!.credential}`)
    await page.getByLabel('Username', { exact: true }).fill('admin'); await page.getByLabel('Password', { exact: true }).fill('password')
    await page.getByRole('button', { name: 'Create administrator' }).click(); await page.waitForURL(`${origin}/admin`)
    expect((await page.request.post(origin + '/admin/api/plugins', { headers: { origin }, data: { action: 'add', packageName: 'shared-sidebar', version: '1.0.0' } })).status()).toBe(202)
    const experts = await (await page.request.get(origin + '/admin/api/experts')).json()
    expect((await page.request.post(origin + '/admin/api/experts', { headers: { origin }, data: { revision: experts.revision, expert: { name: 'Reviewer', description: 'Review helper', icon: 'R', persona: 'Review carefully.', skills: [], skillPacks: [] } } })).status()).toBe(200)
    await page.getByRole('link', { name: 'Group management', exact: true }).click()
    const ordinary = page.getByRole('row').filter({ hasText: 'Ordinary group' })
    await ordinary.getByRole('button', { name: 'Details', exact: true }).click()
    const drawer = page.getByRole('dialog')
    await drawer.getByText('Shared sidebar', { exact: true }).click()
    expect(await drawer.getByRole('checkbox', { name: 'Shared sidebar' }).isChecked()).toBe(true)
    await drawer.getByRole('button', { name: 'Save grants', exact: true }).click()
    await expect.poll(() => drawer.getByRole('button', { name: 'Save grants', exact: true }).isDisabled()).toBe(true)
    expect(await drawer.getByRole('button', { name: 'Restart affected members' }).isDisabled()).toBe(true)
    await drawer.getByRole('button', { name: 'Close group details', exact: true }).last().click()
    await ordinary.getByRole('button', { name: 'Details', exact: true }).click()
    expect(await drawer.getByRole('checkbox', { name: 'Shared sidebar' }).isChecked()).toBe(true)
    await drawer.getByRole('button', { name: 'Close group details', exact: true }).last().click()
    await page.getByRole('row').filter({ hasText: 'Administrators' }).getByRole('button', { name: 'Details', exact: true }).click()
    const adminPlugin = drawer.getByRole('checkbox', { name: 'Shared sidebar' })
    await adminPlugin.waitFor(); expect(await adminPlugin.isDisabled()).toBe(false); expect(await adminPlugin.isChecked()).toBe(false)
    await drawer.getByText('Shared sidebar', { exact: true }).click()
    await drawer.getByRole('button', { name: 'Save grants', exact: true }).click()
    await expect.poll(() => drawer.getByRole('button', { name: 'Save grants', exact: true }).isDisabled()).toBe(true)
    await drawer.getByRole('button', { name: 'Close group details', exact: true }).last().click()
    await page.getByRole('row').filter({ hasText: 'Administrators' }).getByRole('button', { name: 'Details', exact: true }).click()
    expect(await adminPlugin.isChecked()).toBe(true)
    await drawer.getByText('Shared sidebar', { exact: true }).click()
    await drawer.getByRole('button', { name: 'Save grants', exact: true }).click()
    await expect.poll(() => drawer.getByRole('button', { name: 'Save grants', exact: true }).isDisabled()).toBe(true)
    await page.getByRole('tab', { name: 'Expert grants', exact: true }).click()
    const expert = drawer.getByRole('checkbox', { name: 'Reviewer', exact: true })
    await expert.waitFor(); expect(await expert.isDisabled()).toBe(false); expect(await expert.isChecked()).toBe(false)
    await drawer.getByText('Reviewer', { exact: true }).click()
    await drawer.getByRole('button', { name: 'Save grants', exact: true }).click()
    await expect.poll(() => drawer.getByRole('button', { name: 'Save grants', exact: true }).isDisabled()).toBe(true)
    await drawer.getByRole('button', { name: 'Close group details', exact: true }).last().click()
    await page.getByRole('row').filter({ hasText: 'Administrators' }).getByRole('button', { name: 'Details', exact: true }).click()
    await page.getByRole('tab', { name: 'Expert grants', exact: true }).click()
    expect(await expert.isChecked()).toBe(true)
    await drawer.getByText('Reviewer', { exact: true }).click()
    await drawer.getByRole('button', { name: 'Save grants', exact: true }).click()
    await expect.poll(() => drawer.getByRole('button', { name: 'Save grants', exact: true }).isDisabled()).toBe(true)
    if (process.env.DSH_PHALANX_E2E_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.DSH_PHALANX_E2E_EVIDENCE_DIR, 'group-grants.png'), fullPage: true, animations: 'disabled' })
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
  } finally { await browser.close(); await app.stop(); await rm(root, { recursive: true, force: true }) }
})
