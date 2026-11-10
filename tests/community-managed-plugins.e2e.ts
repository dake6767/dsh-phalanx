// Validation: T1; real credentials: none; controlled browser/process fixtures. CI selects its explicit public-entry subset.
import { prepareAndConfirmNpmPluginInBrowser } from './support/plugin-intake.js'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { declaredRuntimeRevision } from '../src/adapters/runtime-revision.js'
import { removeCommunityFixture } from './fixtures/owned-cleanup.js'
import { createCommunityApplication } from './support/community-application.js'
import { selectBuiltinDatabase } from './support/community-bootstrap-browser.js'

it('edits two plugin lists atomically with draft guards and conflict protection while retaining expert controls', async () => {
  const root = await mkdtemp(join(tmpdir(), 'managed-grants-ui-'))
  const app = createCommunityApplication(
    {
      listen: { host: '127.0.0.1', port: 0 },
      sessionSecret: 'managed-grants-ui-fixture-secret-value',
      runtime: {
        command: '/unavailable',
        args: [],
        dataRoot: root,
        defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'https://example.test' } },
      },
    },
    {
      pluginPreparer: {
        prepare: async input => ({
          ...input,
          title: input.packageName === 'shared-sidebar' ? 'Shared sidebar' : input.packageName === 'shared-helper' ? 'Shared helper' : 'Credential sidebar',
          description: '',
          artifact: 'artifacts/fixture',
          integrity: 'sha512-fixture',
          runtimeRevision: declaredRuntimeRevision(),
          bundlePatch: '[]',
          dependencies: {},
        }),
      },
    },
  )
  const browser = await chromium.launch({ headless: true })
  try {
    const origin = await app.start()
    const page = await browser.newPage({ locale: 'en' })
    page.setDefaultTimeout(15000)
    const evidence = process.env.DSH_PHALANX_E2E_EVIDENCE_DIR
    if (evidence) await mkdir(evidence, { recursive: true })
    const cdp = await page.context().newCDPSession(page)
    if (process.env.DSH_PHALANX_E2E_CPU_THROTTLE) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
    await page.goto(`${origin}/bootstrap#credential=${readBootstrapCredential(root)!.credential}`)
    await selectBuiltinDatabase(page)
    await page.getByLabel('Username', { exact: true }).fill('admin')
    await page.getByLabel('Password', { exact: true }).fill('password')
    await page.getByRole('button', { name: 'Create administrator' }).click()
    await page.getByRole('button', { name: /^(Skip for now and finish installation|暂时跳过，完成安装)$/u }).click()
    await page.waitForURL(`${origin}/admin`)
    await prepareAndConfirmNpmPluginInBrowser(page.request, origin, 'shared-sidebar@1.0.0')
    for (const packageName of ['shared-helper', 'credential-sidebar']) await prepareAndConfirmNpmPluginInBrowser(page.request, origin, `${packageName}@1.0.0`)
    expect(
      (
        await page.request.post(origin + '/admin/api/plugins/upstreams?packageName=credential-sidebar', {
          headers: { origin },
          data: { action: 'save', upstream: { name: 'shared', baseUrl: 'https://example.test', credential: 'fictional-shared-key', headers: [] } },
        })
      ).status(),
    ).toBe(200)
    const experts = await (await page.request.get(origin + '/admin/api/experts')).json()
    expect(
      (
        await page.request.post(origin + '/admin/api/experts', {
          headers: { origin },
          data: {
            revision: experts.revision,
            expert: { name: 'Reviewer', description: 'Review helper', icon: 'R', persona: 'Review carefully.', skills: [], skillPacks: [] },
          },
        })
      ).status(),
    ).toBe(200)
    await page.getByRole('link', { name: 'Group management', exact: true }).click()
    const ordinary = page.getByRole('row').filter({ hasText: 'Default group' })
    await ordinary.getByRole('button', { name: 'Details', exact: true }).click()
    const drawer = page.getByRole('dialog').filter({ has: page.getByRole('button', { name: 'Close group details', exact: true }) })
    const groups = await (await page.request.get(origin + '/admin/api/groups')).json(),
      group = groups.find((row: { isDefault: boolean }) => row.isDefault)
    const endpoint = origin + `/admin/api/groups/${group.id}/plugins`,
      current = async () => (await page.request.get(endpoint)).json()
    expect((await page.request.post(endpoint, { headers: { origin }, data: { action: 'save', packages: [], preinstalls: [] } })).status()).toBe(400)
    let posts = 0
    page.on('request', request => {
      if (request.method() === 'POST' && /\/admin\/api\/groups\/[^/]+\/plugins$/u.test(new URL(request.url()).pathname)) posts++
    })
    const save = drawer.getByRole('button', { name: 'Save changes', exact: true })
    const row = (name: string) => drawer.getByRole('listitem').filter({ hasText: name })
    const add = async (tab: 'Platform controlled' | 'Preinstalled plugins', names: readonly string[]) => {
      await drawer.getByRole('tab', { name: tab, exact: true }).click()
      await drawer.getByRole('button', { name: 'Add plugins', exact: true }).click()
      const modal = page.getByRole('dialog', { name: tab === 'Platform controlled' ? 'Add controlled plugins' : 'Add preinstalled plugins', exact: true })
      for (const name of names) {
        await modal.getByText(name, { exact: true }).click()
        expect(await modal.getByRole('checkbox', { name, exact: true }).isChecked()).toBe(true)
      }
      await modal.getByRole('button', { name: 'Confirm selection', exact: true }).click()
    }
    await drawer.getByRole('tab', { name: 'Platform controlled', exact: true }).click()
    await drawer.getByRole('button', { name: 'Add plugins', exact: true }).click()
    const cancelled = page.getByRole('dialog', { name: 'Add controlled plugins', exact: true })
    await cancelled.getByText('Shared sidebar', { exact: true }).click()
    await cancelled.getByRole('button', { name: 'Cancel', exact: true }).click()
    expect(await save.isDisabled()).toBe(true)
    expect(await row('shared-sidebar').count()).toBe(0)
    await add('Platform controlled', ['Shared sidebar', 'Shared helper', 'Credential sidebar'])
    expect(posts).toBe(0)
    expect((await current()).plugins.every((plugin: { granted: boolean }) => !plugin.granted)).toBe(true)
    await save.click()
    await expect.poll(() => save.isDisabled()).toBe(true)
    const limitation = 'Read-only loading limits some plugins. If control is unnecessary, let members install this plugin from the app center.'
    expect(await row('shared-sidebar').getByText(limitation, { exact: true }).count()).toBe(1)
    expect(await row('credential-sidebar').getByText(limitation, { exact: true }).count()).toBe(0)
    if (evidence) await page.screenshot({ path: join(evidence, 'group-controlled.png'), fullPage: true, animations: 'disabled' })
    await drawer.getByRole('tab', { name: 'Preinstalled plugins', exact: true }).click()
    await drawer.getByRole('button', { name: 'Add plugins', exact: true }).click()
    const nativeModal = page.getByRole('dialog', { name: 'Add preinstalled plugins', exact: true })
    expect(await nativeModal.getByRole('checkbox').count()).toBe(0)
    await nativeModal.getByRole('button', { name: 'Cancel', exact: true }).click()
    expect(await save.isDisabled()).toBe(true)
    await drawer.getByRole('tab', { name: 'Platform controlled', exact: true }).click()
    await row('shared-helper').getByRole('button', { name: 'Revoke', exact: true }).click()
    const revoke = page.getByRole('dialog', { name: 'Revoke controlled plugin', exact: true })
    await revoke.getByText('Members lose this plugin after restarting their instances.', { exact: true }).waitFor()
    await revoke.getByRole('button', { name: 'Confirm action', exact: true }).click()
    const beforeMove = posts
    await add('Preinstalled plugins', ['Shared helper'])
    expect(posts).toBe(beforeMove)
    expect(await nativeModal.count()).toBe(0)
    expect(await row('shared-helper').count()).toBe(1)
    expect(await drawer.getByText('Version at preinstallation; members can upgrade it themselves.', { exact: true }).count()).toBe(1)
    await save.click()
    const move = page.getByRole('dialog', { name: 'Confirm plugin configuration change', exact: true })
    await move
      .getByText(
        'Preinstalled native copies have editable settings but do not use platform credentials. Existing selected or expert read-only plugins still take priority.',
        { exact: true },
      )
      .waitFor()
    await move.getByRole('button', { name: 'Confirm action', exact: true }).click()
    await expect.poll(() => save.isDisabled()).toBe(true)
    expect((await current()).plugins.find((plugin: { packageName: string }) => plugin.packageName === 'shared-helper')).toMatchObject({
      granted: false,
      preinstalled: true,
    })
    if (evidence) {
      await page.screenshot({ path: join(evidence, 'group-preinstalled.png'), fullPage: true, animations: 'disabled' })
      await page.setViewportSize({ width: 390, height: 844 })
      await page.screenshot({ path: join(evidence, 'group-preinstalled-mobile.png'), fullPage: true, animations: 'disabled' })
      await page.setViewportSize({ width: 1280, height: 720 })
    }
    await row('shared-helper').getByRole('button', { name: 'Remove from list', exact: true }).click()
    const removal = page.getByRole('dialog', { name: 'Remove preinstalled plugin from list', exact: true })
    await removal.getByText('Installed copies remain in each member’s DSH; the platform will not remove them.', { exact: true }).waitFor()
    await removal.getByRole('button', { name: 'Cancel', exact: true }).click()
    expect(await row('shared-helper').count()).toBe(1)
    await row('shared-helper').getByRole('button', { name: 'Remove from list', exact: true }).click()
    await removal.getByRole('button', { name: 'Confirm action', exact: true }).click()
    await drawer.getByRole('tab', { name: 'Platform controlled', exact: true }).click()
    expect(await page.getByRole('dialog', { name: 'Unsaved changes', exact: true }).count()).toBe(0)
    await add('Platform controlled', ['Shared helper'])
    await save.click()
    await move.getByText('Moving to platform control discards members’ setting changes after restart.', { exact: true }).waitFor()
    await move.getByRole('button', { name: 'Cancel', exact: true }).click()
    await drawer.getByRole('tab', { name: 'Skills', exact: true }).click()
    await page.getByRole('dialog', { name: 'Unsaved changes', exact: true }).getByRole('button', { name: 'Continue editing', exact: true }).click()
    await drawer.getByRole('button', { name: 'Close group details', exact: true }).last().click()
    await page.getByRole('dialog', { name: 'Unsaved changes', exact: true }).getByRole('button', { name: 'Discard changes', exact: true }).click()
    await ordinary.getByRole('button', { name: 'Details', exact: true }).click()
    await drawer.getByRole('tab', { name: 'Platform controlled', exact: true }).click()
    await row('credential-sidebar').waitFor() // The second administrator changes an already loaded draft.
    const stale = await current()
    expect(
      (
        await page.request.post(endpoint, {
          headers: { origin },
          data: { action: 'save', packages: ['shared-sidebar'], preinstalls: ['shared-helper'], revision: stale.revision },
        })
      ).status(),
    ).toBe(200)
    await row('shared-sidebar').getByRole('button', { name: 'Revoke', exact: true }).click()
    await revoke.getByRole('button', { name: 'Confirm action', exact: true }).click()
    const conflicted = page.waitForResponse(response => response.url() === endpoint && response.request().method() === 'POST')
    await save.click()
    expect((await conflicted).status()).toBe(409)
    await drawer.getByRole('alert').getByText('Review the group configuration again.', { exact: true }).waitFor()
    expect(
      (await current()).plugins.filter((plugin: { granted: boolean }) => plugin.granted).map((plugin: { packageName: string }) => plugin.packageName),
    ).toEqual(['shared-sidebar'])
    await drawer.getByRole('button', { name: 'Close group details', exact: true }).last().click()
    await page.getByRole('dialog', { name: 'Unsaved changes', exact: true }).getByRole('button', { name: 'Discard changes', exact: true }).click()
    await page.getByRole('row').filter({ hasText: 'Administrators' }).getByRole('button', { name: 'Details', exact: true }).click()
    await add('Platform controlled', ['Shared sidebar'])
    await add('Preinstalled plugins', ['Shared helper'])
    await save.click()
    await expect.poll(() => save.isDisabled()).toBe(true)
    await drawer.getByRole('button', { name: 'Close group details', exact: true }).last().click()
    await page.getByRole('row').filter({ hasText: 'Administrators' }).getByRole('button', { name: 'Details', exact: true }).click()
    await drawer.getByRole('tab', { name: 'Platform controlled', exact: true }).click()
    await expect.poll(() => row('shared-sidebar').count()).toBe(1)
    await row('shared-sidebar').getByRole('button', { name: 'Revoke', exact: true }).click()
    await revoke.getByRole('button', { name: 'Confirm action', exact: true }).click()
    await drawer.getByRole('tab', { name: 'Preinstalled plugins', exact: true }).click()
    expect(await row('shared-helper').count()).toBe(1)
    await row('shared-helper').getByRole('button', { name: 'Remove from list', exact: true }).click()
    await removal.getByRole('button', { name: 'Confirm action', exact: true }).click()
    await save.click()
    await expect.poll(() => save.isDisabled()).toBe(true)
    // hidden in 0.1.32: expert-grant editor interactions are paused.
    await drawer.getByRole('button', { name: 'Close group details', exact: true }).last().click()
    // Controlled browser projection; failure aggregation is covered at the policy seam.
    let incomplete = 2
    await page.route('**/admin/api/groups/*/plugins', async route => {
      if (route.request().method() !== 'GET') {
        await route.continue()
        return
      }
      const response = await route.fetch()
      await route.fulfill({ response, json: { ...(await response.json()), preinstallIncompleteMembers: incomplete } })
    })
    await ordinary.getByRole('button', { name: 'Details', exact: true }).click()
    const warning = drawer.getByText('2 members did not finish preinstallation.', { exact: true })
    await warning.waitFor()
    await drawer.getByRole('tab', { name: 'Preinstalled plugins', exact: true }).click()
    expect(await warning.isVisible()).toBe(true)
    await drawer.getByRole('tab', { name: 'Skills', exact: true }).click()
    expect(await warning.isVisible()).toBe(false)
    await drawer.getByRole('button', { name: 'Close group details', exact: true }).last().click()
    incomplete = 0
    await ordinary.getByRole('button', { name: 'Details', exact: true }).click()
    await drawer.getByRole('tab', { name: 'Platform controlled', exact: true }).waitFor()
    expect(await warning.count()).toBe(0)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
  } finally {
    await browser.close()
    await app.stop()
    await removeCommunityFixture(root)
  }
})
