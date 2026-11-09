// Validation: T1; real credentials: none; controlled browser/process fixtures. CI selects its explicit public-entry subset.
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { afterEach, expect, it } from 'vitest'
import { FileSkillArtifacts } from '../src/adapters/skill-artifacts.js'
import { FileSkillDistribution } from '../src/adapters/skill-distribution.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import type { CommunityGroupView } from '../src/domain/admin-contract.js'
import type { CommunityApplication } from '../src/ports/community-application.js'
import { removeCommunityFixture } from './fixtures/owned-cleanup.js'
import { createCommunityApplication, openTestDatabase } from './support/community-application.js'
import { skillZip, validSkill } from './fixtures/skills/archive.js'
import { selectBuiltinDatabase } from './support/community-bootstrap-browser.js'
let app: CommunityApplication | undefined
let browser: Browser | undefined
let root: string | undefined
afterEach(async () => {
  await browser?.close()
  await app?.stop()
  if (root) {
    const artifacts = new FileSkillArtifacts(join(root, 'skills/artifacts'), [])
    await new FileSkillDistribution(join(root, 'skills/members'), artifacts).synchronize([])
    await artifacts.collect([])
    await removeCommunityFixture(root)
  }
})
const select = async (page: Page, label: string, option: string) => {
  await page.getByRole('button', { name: new RegExp(label) }).click()
  await page.getByRole('option', { name: option, exact: true }).click()
}
it('manages groups, membership, defaults and administrator transitions through HeroUI', async () => {
  root = await mkdtemp(join(tmpdir(), 'community-groups-'))
  app = createCommunityApplication({
    listen: { host: '127.0.0.1', port: 0 },
    sessionSecret: 'groups-fixture-session-secret-32-bytes',
    runtime: {
      command: '/unavailable-dsh',
      args: [],
      dataRoot: root,
      defaultModel: { provider: 'deepseek-official', model: 'deepseek-chat', upstream: { baseUrl: 'https://api.deepseek.com' } },
    },
  })
  const origin = await app.start()
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ locale: 'en' })
  page.setDefaultTimeout(15_000)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`${origin}/bootstrap#credential=${readBootstrapCredential(root)!.credential}`)
  await selectBuiltinDatabase(page)
  await page.getByLabel('Username', { exact: true }).fill('admin')
  await page.getByLabel('Password', { exact: true }).fill('password')
  await page.getByRole('button', { name: 'Create administrator' }).click()
  await page.waitForURL(`${origin}/admin`)
  await page.getByRole('link', { name: 'Group management', exact: true }).click()
  await page.getByRole('button', { name: 'Create group', exact: true }).click()
  await page.getByLabel('Group name', { exact: true }).fill('Research')
  await page.getByRole('button', { name: 'Confirm action', exact: true }).click()
  const research = page.getByRole('row').filter({ hasText: 'Research' })
  await research.waitFor()
  await research.getByRole('button', { name: 'More actions for group Research', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Set as default', exact: true }).click()
  await page.getByText('The new default applies only to accounts created afterward.', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Confirm action', exact: true }).click()
  await research.getByText('Default for new accounts', { exact: true }).waitFor()
  await research.getByRole('button', { name: 'More actions for group Research', exact: true }).click()
  expect(await page.getByRole('menuitem', { name: 'Delete group', exact: true }).isDisabled()).toBe(true)
  expect(await page.getByRole('menuitem', { name: 'Set as default', exact: true }).isDisabled()).toBe(true)
  await page.keyboard.press('Escape')
  await page.getByRole('link', { name: 'Account management', exact: true }).click()
  await page.getByRole('button', { name: 'Add account', exact: true }).click()
  let dialog = page.getByRole('dialog', { name: 'Create a member', exact: true })
  expect(await dialog.getByRole('button', { name: /Group/ }).innerText()).toContain('Research')
  await dialog.getByLabel('Username', { exact: true }).fill('member')
  await dialog.getByLabel('Email', { exact: true }).fill('member@example.test')
  await dialog.getByLabel('Temporary password').fill('password')
  await dialog.getByRole('button', { name: 'Create account', exact: true }).click()
  await dialog.waitFor({ state: 'detached' })
  const database = await openTestDatabase(root)
  try {
    await database.query('UPDATE dsh_phalanx.accounts SET email=NULL WHERE username=$1', ['member'])
  } finally {
    await database.close()
  }
  await page.reload()
  await page.getByRole('button', { name: 'Edit member', exact: true }).click()
  dialog = page.getByRole('dialog', { name: 'Edit account: member', exact: true })
  await select(page, 'Group', 'Default group')
  await dialog.getByRole('button', { name: 'Save changes', exact: true }).click()
  await dialog.waitFor({ state: 'detached' })
  const memberAfter = await (await page.request.get(`${origin}/admin/api/accounts`)).json()
  expect(memberAfter.items.find((account: { username: string }) => account.username === 'member')).toMatchObject({ email: '', groupId: 'default' })
  await select(page, 'Filter by group', 'Research')
  expect(await page.getByRole('button', { name: 'Edit member', exact: true }).count()).toBe(0)
  expect(
    await page
      .getByRole('region', { name: 'Accounts', exact: true })
      .getByText(/^0 accounts/)
      .count(),
  ).toBe(2)
  await select(page, 'Filter by group', 'Administrators')
  await page.getByRole('button', { name: 'More actions for admin', exact: true }).click()
  expect(await page.getByRole('menuitem', { name: 'Disable admin', exact: true }).isDisabled()).toBe(true)
  await page.keyboard.press('Escape')
  await select(page, 'Filter by group', 'All groups')
  await page.getByRole('button', { name: 'More actions for member', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Make member an administrator', exact: true }).click()
  await page.getByRole('button', { name: 'Confirm action', exact: true }).click()
  await page.getByRole('dialog', { name: 'Make administrator: member', exact: true }).waitFor({ state: 'detached' })
  await page.getByRole('button', { name: 'More actions for member', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Remove administrator role from member', exact: true }).click()
  expect(await page.getByRole('button', { name: /Target group/ }).innerText()).toContain('Research')
  await select(page, 'Target group', 'Default group')
  await page.getByRole('button', { name: 'Confirm action', exact: true }).click()
  await page.getByRole('dialog', { name: 'Remove administrator role: member', exact: true }).waitFor({ state: 'detached' })
  const groups = (await (await page.request.get(`${origin}/admin/api/groups`)).json()) as CommunityGroupView[]
  expect(groups.find(group => group.id === 'admin')?.memberCount).toBe(1)
  expect(groups.find(group => group.id === 'default')?.memberCount).toBe(1)
  const researchId = groups.find(group => group.name === 'Research')!.id
  const refused = await page.request.post(`${origin}/admin/api/groups`, { data: { action: 'set-default', id: researchId, confirmed: false } })
  expect(refused.status()).toBe(400)
  expect(await refused.json()).toMatchObject({ code: 'group-action-invalid' })
  await page.getByRole('link', { name: 'Group management', exact: true }).click()
  await research.getByRole('button', { name: 'More actions for group Research', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Rename group', exact: true }).click()
  await page.getByLabel('Group name').fill('Lab')
  await page.getByRole('button', { name: 'Confirm action', exact: true }).click()
  await page.getByRole('row').filter({ hasText: 'Lab' }).waitFor()
  await page.getByRole('button', { name: 'More actions for group Default group', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Set as default', exact: true }).click()
  await page.getByRole('button', { name: 'Confirm action', exact: true }).click()
  await page
    .getByRole('dialog')
    .filter({ has: page.getByRole('button', { name: 'Confirm action', exact: true }) })
    .waitFor({ state: 'detached' })
  await page.getByRole('button', { name: 'More actions for group Lab', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Delete group', exact: true }).click()
  await page.getByRole('button', { name: 'Confirm action', exact: true }).click()
  await page.getByRole('row').filter({ hasText: 'Lab' }).waitFor({ state: 'detached' })
  const evidence = process.env.DSH_PHALANX_E2E_EVIDENCE_DIR
  if (evidence) {
    await mkdir(evidence, { recursive: true })
    await page.screenshot({ path: join(evidence, 'groups-desktop.png'), fullPage: true })
  }
  await page.getByRole('button', { name: /Platform language/ }).click()
  await page.getByRole('menuitemradio', { name: '简体中文', exact: true }).click()
  await page.getByRole('heading', { name: '分组管理', exact: true }).waitFor()
  await page.getByRole('dialog').waitFor({ state: 'detached' })
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  if (evidence) await page.screenshot({ path: join(evidence, 'groups-mobile.png'), fullPage: true })
  expect(errors).toEqual([])
})

it('edits native feature defaults with dirty guards, unavailable explanations and stale-form protection through the public entry', async () => {
  root = await mkdtemp(join(tmpdir(), 'community-native-settings-'))
  const { nativeFeatureCatalog } = await import('../src/domain/native-features.js')
  app = createCommunityApplication(
    {
      listen: { host: '127.0.0.1', port: 0 },
      runtime: {
        command: '/unavailable-dsh',
        args: [],
        dataRoot: root,
        defaultModel: { provider: 'deepseek-official', model: 'deepseek-chat', upstream: { baseUrl: 'https://api.deepseek.com' } },
      },
    },
    {
      nativeFeatures: [
        {
          feature: {
            ...nativeFeatureCatalog()[0]!,
            id: 'future-feature',
            name: { en: 'Future feature', 'zh-CN': '未来功能' },
            availability: { available: false, reason: { en: 'Unavailable in this DSH revision.', 'zh-CN': '当前 DSH 版本不可用。' } },
          },
          entries: [],
        },
        ...(['alpha', 'beta'] as const).map(id => ({
          feature: {
            ...nativeFeatureCatalog()[0]!,
            id: `fixture-${id}`,
            name: { en: `Option ${id}`, 'zh-CN': `选项 ${id}` },
            description: { en: 'Required fixture option.', 'zh-CN': '必选组测试选项。' },
            constraints: [{ kind: 'at-least-one' as const, group: 'fixture-required' }],
          },
          entries: [`fixture-${id}`],
        })),
      ],
    },
  )
  const origin = await app.start()
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ locale: 'en' })
  page.setDefaultTimeout(15000)
  if (process.env.DSH_PHALANX_E2E_CPU_THROTTLE) await (await page.context().newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: 4 })
  await page.goto(`${origin}/bootstrap#credential=${readBootstrapCredential(root)!.credential}`)
  await selectBuiltinDatabase(page)
  await page.getByLabel('Username', { exact: true }).fill('admin')
  await page.getByLabel('Password', { exact: true }).fill('password')
  await page.getByRole('button', { name: 'Create administrator' }).click()
  await page.waitForURL(`${origin}/admin`)
  await page.getByRole('link', { name: 'Group management', exact: true }).click()
  const row = page.getByRole('row').filter({ hasText: 'Default group' })
  await row.getByRole('button', { name: 'Details', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Default group', exact: true })
  await dialog.getByRole('tab', { name: 'DSH native features', exact: true }).click()
  const terminal = dialog.getByRole('checkbox', { name: 'Manual terminal access', exact: true })
  expect(await terminal.isChecked()).toBe(true)
  const presets = dialog.getByRole('region', { name: 'DSH built-in Agent presets', exact: true })
  for (const name of ['Standard', 'PTC', 'Minimal']) await presets.getByText(name, { exact: true }).click()
  expect(await presets.getByRole('checkbox', { name: 'Creator', exact: true }).isDisabled()).toBe(true)
  await presets.getByText('Keep at least one of these options enabled.', { exact: true }).waitFor()
  for (const name of ['Standard', 'PTC', 'Minimal']) await presets.getByText(name, { exact: true }).click()
  expect(await presets.getByRole('checkbox', { name: 'Creator', exact: true }).isDisabled()).toBe(false)
  expect(await dialog.getByRole('checkbox', { name: 'Future feature', exact: true }).isDisabled()).toBe(true)
  await dialog.getByText('Unavailable in this DSH revision.', { exact: true }).waitFor()
  await dialog.getByText('Manual terminal access', { exact: true }).click()
  await dialog.getByRole('tab', { name: 'Plugins', exact: true }).click()
  await page.getByRole('dialog', { name: 'Unsaved changes', exact: true }).getByRole('button', { name: 'Discard changes', exact: true }).click()
  await dialog.getByRole('tab', { name: 'DSH native features', exact: true }).click()
  expect(await terminal.isChecked()).toBe(true)
  await dialog.getByText('Option alpha', { exact: true }).click()
  expect(await dialog.getByRole('checkbox', { name: 'Option beta', exact: true }).isDisabled()).toBe(true)
  await dialog.getByText('Keep at least one of these options enabled.', { exact: true }).waitFor()
  await dialog.getByText('Manual terminal access', { exact: true }).click()
  await dialog.getByRole('button', { name: 'Save changes', exact: true }).click()
  await dialog.getByText('Saved. Restart running instances to apply these changes.', { exact: true }).waitFor()
  const path = `${origin}/admin/api/groups/default/native-features`
  const current = await (await page.request.get(path)).json()
  expect(current.features.find((feature: { id: string }) => feature.id === 'terminal').enabled).toBe(false)
  const invalid = await page.request.post(path, { data: { revision: current.revision, disabledIds: ['fixture-alpha', 'fixture-beta'] }, headers: { origin } })
  expect(invalid.status()).toBe(400)
  expect(await invalid.json()).toMatchObject({ code: 'native-features-required' })
  const emptyPresets = await page.request.post(path, {
    data: { revision: current.revision, disabledIds: ['preset-standard', 'preset-ptc', 'preset-minimal', 'preset-cordis'] },
    headers: { origin },
  })
  expect(emptyPresets.status()).toBe(400)
  expect(await emptyPresets.json()).toMatchObject({ code: 'native-features-required' })
  expect((await page.request.post(path, { data: { revision: current.revision, disabledIds: [] }, headers: { origin } })).status()).toBe(200)
  expect((await page.request.post(path, { data: { revision: current.revision, disabledIds: ['terminal'] }, headers: { origin } })).status()).toBe(409)
  expect(
    (await page.request.post(path, { data: { revision: current.revision, disabledIds: [] }, headers: { origin: 'https://foreign.example.test' } })).status(),
  ).toBe(403)
  expect((await page.request.put(path, { data: {} })).status()).toBe(405)
  await dialog.getByText('Manual terminal access', { exact: true }).click()
  await dialog.getByRole('button', { name: 'Save changes', exact: true }).click()
  await dialog.getByRole('alert').filter({ hasText: 'Native feature settings changed' }).waitFor()
})

it('folds group grants and expert choices without dropping selected children', async () => {
  root = await mkdtemp(join(tmpdir(), 'community-folding-choices-'))
  app = createCommunityApplication({
    listen: { host: '127.0.0.1', port: 0 },
    runtime: {
      command: '/unavailable-dsh',
      args: [],
      dataRoot: root,
      defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'http://127.0.0.1:1' } },
    },
  })
  const origin = await app.start()
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ locale: 'en' })
  page.setDefaultTimeout(15000)
  if (process.env.DSH_PHALANX_E2E_CPU_THROTTLE) await (await page.context().newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: 4 })
  await page.goto(`${origin}/bootstrap#credential=${readBootstrapCredential(root)!.credential}`)
  await selectBuiltinDatabase(page)
  await page.getByLabel('Username', { exact: true }).fill('admin')
  await page.getByLabel('Password', { exact: true }).fill('password')
  await page.getByRole('button', { name: 'Create administrator' }).click()
  await page.waitForURL(`${origin}/admin`)
  const preview = await (
    await page.request.post(origin + '/admin/api/skills/import', {
      headers: { origin, 'content-type': 'application/zip' },
      data: skillZip(['solo', 'child'].map(name => ({ path: `skills/${name}/SKILL.md`, content: validSkill.replace('example-skill', name) }))),
    })
  ).json()
  expect(
    (
      await page.request.post(origin + '/admin/api/skills/import/confirm', {
        headers: { origin },
        data: {
          token: preview.token,
          names: ['solo', 'child'],
          replacements: [],
          packs: [{ name: 'research', description: 'Research workflow', skills: ['child'] }],
        },
      })
    ).status(),
  ).toBe(200)
  await page.getByRole('link', { name: 'Group management', exact: true }).click()
  await page.getByRole('row').filter({ hasText: 'Default group' }).getByRole('button', { name: 'Details', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Default group', exact: true })
  await dialog.getByRole('tab', { name: 'Skills', exact: true }).click()
  await dialog.getByRole('button', { name: 'Add skills', exact: true }).click()
  // The picker lists packs, standalone skills and pack members that can also be granted on their own.
  const picker = page.getByRole('dialog', { name: 'Add skills', exact: true })
  await picker.getByRole('checkbox', { name: 'research', exact: true }).waitFor()
  await picker.getByRole('checkbox', { name: 'child', exact: true }).waitFor()
  await picker.getByRole('checkbox', { name: 'solo', exact: true }).waitFor()
  const evidence = process.env.DSH_PHALANX_E2E_EVIDENCE_DIR
  if (evidence) {
    await mkdir(evidence, { recursive: true })
    await page.screenshot({ path: join(evidence, 'group-folding.png'), fullPage: true, animations: 'disabled' })
  }
  await picker.getByText('research', { exact: true }).click()
  await picker.getByRole('button', { name: 'Confirm selection', exact: true }).click()
  await dialog.getByRole('listitem').filter({ hasText: 'research' }).waitFor()
  await dialog.getByRole('button', { name: 'Save changes', exact: true }).click()
  await page.getByRole('button', { name: 'Confirm action', exact: true }).click()
  await expect
    .poll(
      async () =>
        (await (await page.request.get(origin + '/admin/api/groups/default/skills')).json()).packs.find((row: { name: string }) => row.name === 'research')
          .granted,
    )
    .toBe(true)
  expect(
    (await (await page.request.get(origin + '/admin/api/groups/default/skills')).json()).skills.find((row: { name: string }) => row.name === 'child').granted,
  ).toBe(false)
  await page.getByRole('button', { name: 'Close group details', exact: true }).click()
  // hidden in 0.1.32: expert editor selection and mobile display are paused.
})
