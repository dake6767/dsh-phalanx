// Validation: T1; real credentials: none; controlled browser/process fixtures. CI selects its explicit public-entry subset.
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser } from 'playwright'
import { afterEach, expect, it, vi } from 'vitest'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { FileExecutionArtifacts } from '../src/adapters/execution-artifacts.js'
import { FileSkillArtifacts } from '../src/adapters/skill-artifacts.js'
import { FileSkillDistribution } from '../src/adapters/skill-distribution.js'
import type { CommunityApplication } from '../src/ports/community-application.js'
import { removeCommunityFixture } from './fixtures/owned-cleanup.js'
import { skillZip, validSkill } from './fixtures/skills/archive.js'
import { createCommunityApplication } from './support/community-application.js'
import { selectBuiltinDatabase } from './support/community-bootstrap-browser.js'
let app: CommunityApplication | undefined, browser: Browser | undefined, root: string | undefined
// Skills are immutable while available; removal through the public API releases their files.
afterEach(async () => {
  try {
    await browser?.close()
    await app?.stop()
    if (root) {
      const artifacts = new FileSkillArtifacts(join(root, 'skills/artifacts'), [])
      await new FileSkillDistribution(join(root, 'skills/members'), artifacts).synchronize([])
      await new FileExecutionArtifacts(join(root, 'runtime-dependencies', '.trees')).collect([])
      await artifacts.collect([])
      await new FileExecutionArtifacts(join(root, 'execution/artifacts')).collect([])
      await removeCommunityFixture(root)
    }
  } finally {
    vi.unstubAllEnvs()
  }
})
it('imports, previews, replaces and removes skills in the member/plugin page framework without fetching markdown resources', async () => {
  root = await mkdtemp(join(tmpdir(), 'community-skills-'))
  // Exercise the no-container development path regardless of tools installed on the CI host.
  const tools = join(root, 'development-path')
  await mkdir(tools)
  const python = execFileSync('python3', ['-I', '-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim()
  await symlink(python, join(tools, 'python3'))
  vi.stubEnv('PATH', tools)
  app = createCommunityApplication({
    listen: { host: '127.0.0.1', port: 0 },
    sessionSecret: 'skills-fixture-session-secret-32-bytes',
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
  page.setDefaultTimeout(10_000)
  if (process.env.DSH_PHALANX_E2E_CPU_THROTTLE) await (await page.context().newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: 4 })
  // HTTP deployments do not expose this secure-context API; form row identities must work without it.
  await page.addInitScript(() => {
    Object.defineProperty(Crypto.prototype, 'randomUUID', { value: undefined, configurable: true })
  })
  const evidence = process.env.DSH_PHALANX_E2E_EVIDENCE_DIR
  if (evidence) await mkdir(evidence, { recursive: true })
  const screenshot = async (name: string) => {
    if (evidence) await page.screenshot({ path: join(evidence, name), fullPage: true, animations: 'disabled' })
  }
  const external: string[] = []
  page.on('request', request => {
    if (request.url().includes('untrusted.example')) external.push(request.url())
  })
  expect((await page.request.get(`${origin}/admin/api/skills`)).status()).toBe(401)
  await page.goto(`${origin}/bootstrap#credential=${readBootstrapCredential(root)!.credential}`)
  await selectBuiltinDatabase(page)
  await page.getByLabel('Username', { exact: true }).fill('admin')
  await page.getByLabel('Password', { exact: true }).fill('password')
  await page.getByRole('button', { name: 'Create administrator' }).click()
  await page.getByRole('button', { name: /^(Skip for now and finish installation|暂时跳过，完成安装)$/u }).click()
  await page.waitForURL(`${origin}/admin`)
  await page.getByRole('link', { name: 'Skill library', exact: true }).click()
  await page.getByText('No skills yet', { exact: true }).waitFor()
  const tabs = page.getByRole('tablist', { name: 'Skill library', exact: true })
  // Library tabs size to their labels rather than stretching across the panel.
  expect((await tabs.boundingBox())!.width).toBeLessThan((await page.locator('.skill-library-tabs').boundingBox())!.width * 0.75)
  const tabContainer = await page.locator('.skill-library-tabs > .tabs__list-container').boundingBox()
  for (const name of ['Skills', 'Skill packs']) {
    const bounds = await tabs.getByRole('tab', { name, exact: true }).boundingBox()
    expect(bounds!.x).toBeGreaterThanOrEqual(tabContainer!.x)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(tabContainer!.x + tabContainer!.width + 1)
  }
  await page.getByRole('tab', { name: 'Skills', exact: true }).focus()
  await page.keyboard.press('ArrowRight')
  await expect.poll(() => page.getByRole('tab', { name: 'Skill packs', exact: true }).getAttribute('aria-selected')).toBe('true')
  await page.keyboard.press('ArrowLeft')
  await page.getByText('No skills yet', { exact: true }).waitFor()
  const upload = async (body: string, includeScript = true) => {
    await page.getByRole('button', { name: 'Import skill', exact: true }).click()
    await page.getByLabel('Skill archive (.zip)', { exact: true }).setInputFiles({
      name: 'skill.zip',
      mimeType: 'application/zip',
      buffer: skillZip([
        { path: 'SKILL.md', content: body },
        { path: '_meta.json', content: 'opaque market metadata' },
        ...(includeScript ? [{ path: 'scripts/query.py', content: 'import os\nkey = os.getenv("NEWS_KEY")\nprint("TRIAL_OK")\n' }] : []),
      ]),
    })
    await page.getByRole('button', { name: 'Preview skill', exact: true }).click()
    await page.getByRole('dialog').getByText('_meta.json', { exact: true }).waitFor()
    await page.getByText('Also create a skill pack', { exact: true }).click()
    if (await page.getByRole('checkbox', { name: 'Replace existing example-skill', exact: true }).count())
      await page.getByText('Replace existing example-skill', { exact: true }).click()
  }
  await upload(validSkill + '\n# Safe preview\n![remote](https://untrusted.example/image.png)\n<script>alert(1)</script>')
  expect(await (await page.request.get(`${origin}/admin/api/skills`)).json()).toEqual([])
  await page.getByRole('button', { name: 'Confirm import', exact: true }).click()
  await page.getByRole('button', { name: 'View skill example-skill', exact: true }).waitFor()
  const library = page.getByRole('region', { name: 'All skills', exact: true })
  expect(await library.getByText('Not published', { exact: true }).filter({ visible: true }).count()).toBe(1)
  expect(await library.getByText(/managed members ·/u).count()).toBe(0)
  await screenshot('skills-list-desktop.png')
  await page.getByRole('button', { name: 'View skill example-skill', exact: true }).click()
  await page.getByRole('dialog').getByRole('heading', { name: 'Safe preview' }).waitFor()
  await screenshot('skill-details-desktop.png')
  expect(await page.getByRole('dialog').locator('img').count()).toBe(0)
  expect(external).toEqual([])
  const dependency = {
    name: 'browser-news',
    prepareCommand: "mkdir bin; printf '#!/bin/sh\\nprintf NEWS_READY\\n' > bin/news-cli; chmod +x bin/news-cli",
    pathDirectories: ['bin'],
    checkCommand: 'news-cli',
  }
  expect(
    (await page.request.post(origin + '/admin/api/runtime-dependencies', { headers: { origin }, data: { action: 'create', input: dependency } })).ok(),
  ).toBe(true)
  await expect
    .poll(async () => (await (await page.request.get(origin + '/admin/api/runtime-dependencies?name=browser-news')).json()).stage, { timeout: 15_000 })
    .toBe('ready')
  await page.getByRole('tab', { name: 'Platform execution', exact: true }).click()
  expect(await page.getByLabel('Delegated command', { exact: true }).inputValue()).toBe('scripts/query.py')
  expect(await page.getByLabel('Credential variable', { exact: true }).inputValue()).toBe('NEWS_KEY')
  await page.getByText('Enable platform execution', { exact: true }).click()
  expect(await page.getByRole('switch', { name: 'Enable platform execution' }).isChecked()).toBe(true)
  await page.getByLabel('Delegated command', { exact: true }).fill('news-cli')
  await page.getByLabel('Credential variable', { exact: true }).fill('NEWS_KEY')
  await page.getByLabel('Credential value', { exact: true }).fill('fixture-news-credential')
  expect(await page.getByLabel('Preparation command (optional)', { exact: true }).count()).toBe(0)
  await page.getByRole('dialog').getByText('browser-news', { exact: true }).click()
  expect(await page.getByRole('checkbox', { name: 'browser-news', exact: true }).isChecked()).toBe(true)
  await page.getByRole('button', { name: 'Save execution settings', exact: true }).click()
  await page.getByText('Execution settings saved.', { exact: true }).waitFor()
  expect(await page.getByLabel('Credential value', { exact: true }).inputValue()).toBe('')
  expect(await page.getByLabel('Credential value', { exact: true }).getAttribute('placeholder')).toBe('••••tial')
  const executionView = await (await page.request.get(origin + '/admin/api/skills/execution?name=example-skill')).text()
  expect(executionView).not.toContain('fixture-news-credential')
  expect(JSON.parse(executionView)).toMatchObject({ enabled: true, variables: [{ name: 'NEWS_KEY', secret: true, configured: true }] })
  expect(JSON.parse(executionView).runtimeDependencies).toEqual(['browser-news'])
  const prepared = await (await page.request.get(origin + '/admin/api/runtime-dependencies?name=browser-news')).json()
  expect(prepared.references).toEqual([{ kind: 'execution', name: 'skill:example-skill' }])
  await page.getByLabel('Credential value', { exact: true }).fill('replacement-browser-credential')
  await page.getByRole('button', { name: 'Save execution settings', exact: true }).click()
  await page.getByText('Execution settings saved.', { exact: true }).waitFor()
  expect((await (await page.request.get(origin + '/admin/api/runtime-dependencies?name=browser-news')).json()).current.id).toBe(prepared.current.id)
  await page.getByText('Dependencies ready', { exact: true }).waitFor()
  await page.getByLabel('Blocked first arguments', { exact: true }).fill('apikey-get\napikey-set')
  await page.getByRole('button', { name: 'Add command', exact: true }).click()
  await page.getByRole('group', { name: 'Command 2', exact: true }).getByLabel('Delegated command', { exact: true }).fill('scripts/query.py')
  await page.getByRole('button', { name: 'Add variable', exact: true }).click()
  const secondVariable = page.getByRole('group', { name: 'Variable 2', exact: true })
  await secondVariable.getByLabel('Credential variable', { exact: true }).fill('MPS_REGION')
  await secondVariable.getByText('Secret value', { exact: true }).click()
  expect(await secondVariable.getByRole('checkbox', { name: 'Secret value', exact: true }).isChecked()).toBe(false)
  await secondVariable.getByLabel('Credential value', { exact: true }).fill('region-one')
  await page.getByRole('button', { name: 'Add variable', exact: true }).click()
  const thirdVariable = page.getByRole('group', { name: 'Variable 3', exact: true })
  await thirdVariable.getByLabel('Credential variable', { exact: true }).fill('MPS_SECRET_ID')
  await thirdVariable.getByLabel('Credential value', { exact: true }).fill('fictional-second-secret')
  await page.getByRole('button', { name: 'Save execution settings', exact: true }).click()
  await page.getByText('Execution settings saved.', { exact: true }).waitFor()
  const multiple = await (await page.request.get(origin + '/admin/api/skills/execution?name=example-skill')).json()
  expect(multiple.commands).toEqual([
    { command: 'news-cli', blocked: ['apikey-get', 'apikey-set'] },
    { command: 'scripts/query.py', blocked: [] },
  ])
  expect(multiple.variables).toEqual([
    { name: 'NEWS_KEY', secret: true, configured: true, last4: 'tial' },
    { name: 'MPS_REGION', secret: false, configured: true, value: 'region-one' },
    { name: 'MPS_SECRET_ID', secret: true, configured: true, last4: 'cret' },
  ])
  expect(await thirdVariable.getByLabel('Credential value', { exact: true }).inputValue()).toBe('')
  expect(await thirdVariable.getByLabel('Credential value', { exact: true }).getAttribute('placeholder')).toBe('••••cret')
  expect(await secondVariable.getByLabel('Credential value', { exact: true }).inputValue()).toBe('region-one')
  await page.getByRole('tab', { name: 'Skill contents', exact: true }).click()
  await page.getByRole('button', { name: 'Publish to Platform App Center', exact: true }).click()
  const publication = page.getByRole('dialog', { name: 'Confirm skill publication', exact: true })
  await publication.getByText('All members can use the platform credentials through this resource.', { exact: true }).waitFor()
  expect(await publication.innerText()).not.toContain('fictional-second-secret')
  await publication.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.getByRole('tab', { name: 'Platform execution', exact: true }).click()
  await page.getByText('Platform execution is not isolated. Development only.', { exact: true }).waitFor()
  const denied = await (
    await page.request.post(origin + '/admin/api/execution/trial', { headers: { origin }, data: { owner: 'skill:example-skill', line: 'news-cli' } })
  ).json()
  expect(denied).toMatchObject({ exitCode: 125, stderr: expect.stringContaining('DSH_PHALANX_EXECUTION[unauthorized]') })
  const groups = await (await page.request.get(origin + '/admin/api/groups')).json()
  const adminGroup = groups.find((group: { kind: string }) => group.kind === 'admin')
  const grantPath = origin + `/admin/api/groups/${adminGroup.id}/skills`
  const grant = await (await page.request.get(grantPath)).json()
  expect(
    (
      await page.request.post(grantPath, { headers: { origin }, data: { action: 'save', names: ['example-skill'], revision: grant.revision, confirmed: true } })
    ).ok(),
  ).toBe(true)
  await page.getByLabel('Command line', { exact: true }).fill('scripts/query.py')
  await page.getByRole('button', { name: 'Run command', exact: true }).click()
  await page.getByText('TRIAL_OK', { exact: true }).waitFor()
  await page.getByText('Exit code: 0', { exact: true }).waitFor()
  await screenshot('skill-execution-desktop.png')

  await page.getByRole('button', { name: 'Close skill details', exact: true }).click()
  await upload(validSkill.replace('A useful skill', 'Updated skill'), false)
  await page.getByText('Changes apply to new sessions. Running tasks using this skill may fail.', { exact: true }).waitFor()
  const replacement = page.waitForResponse(response => response.url() === origin + '/admin/api/skills/import/confirm' && response.request().method() === 'POST')
  await page.getByRole('button', { name: 'Confirm replacement', exact: true }).click()
  expect((await replacement).ok()).toBe(true)
  expect(await (await page.request.get(`${origin}/admin/api/skills`)).json()).toEqual([
    expect.objectContaining({ name: 'example-skill', description: 'Updated skill', published: false }),
  ])
  const csrf = await page.request.post(`${origin}/admin/api/skills/change`, {
    headers: { origin: 'https://other.example.test' },
    data: { action: 'remove', name: 'example-skill', revision: 'invalid' },
  })
  expect(csrf.status()).toBe(403)
  await page.getByRole('button', { name: 'View skill example-skill', exact: true }).click()
  await page.getByRole('tab', { name: 'Platform execution', exact: true }).click()
  await page.getByText('Commands missing from this skill version', { exact: true }).waitFor()
  const retained = await (await page.request.get(origin + '/admin/api/skills/execution?name=example-skill')).json()
  expect(retained.commands).toEqual(multiple.commands)
  expect(retained.variables).toEqual(multiple.variables)
  expect(retained.unavailableCommands).toEqual(['scripts/query.py'])
  await page.getByRole('tab', { name: 'Version management', exact: true }).click()
  await page.getByRole('button', { name: 'Remove skill', exact: true }).click()
  await page.getByRole('button', { name: 'Confirm removal', exact: true }).click()
  await page.getByText('No skills yet', { exact: true }).waitFor()
  // hidden in 0.1.32: removal retains execution audit through the administrator API.
  const audit = await (await page.request.get(origin + '/admin/api/usage-records')).json()
  expect(audit.items.some((row: { capability: { operation: string } }) => row.capability.operation === 'scripts/query.py')).toBe(true)
  expect((await (await page.request.get(origin + '/admin/api/usage-records?username=nobody')).json()).total).toBe(0)
  await page.getByRole('link', { name: 'System settings', exact: true }).click()
  await page.getByRole('tab', { name: 'Resources and limits', exact: true }).click()
  await page.getByLabel('Execution timeout (seconds)', { exact: true }).fill('60')
  await page.getByRole('button', { name: 'Save execution limits', exact: true }).click()
  await page.getByText('Execution limits saved.', { exact: true }).waitFor()
  await screenshot('execution-settings-desktop.png')
  await page.getByRole('link', { name: 'Skill library', exact: true }).click()
  await page.getByRole('button', { name: /Platform language/ }).click()
  await page.getByRole('menuitemradio', { name: '简体中文', exact: true }).click()
  await page.getByRole('heading', { name: '技能库', exact: true }).waitFor()
  await page.getByRole('menuitemradio', { name: '简体中文', exact: true }).waitFor({ state: 'detached' })
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await screenshot('skills-empty-mobile-zh.png')
})

it('groups the main skill library by packs while keeping standalone skills reachable', async () => {
  root = await mkdtemp(join(tmpdir(), 'community-skill-folding-'))
  const tools = join(root, 'development-path')
  await mkdir(tools)
  const python = execFileSync('python3', ['-I', '-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim()
  await symlink(python, join(tools, 'python3'))
  vi.stubEnv('PATH', tools)
  app = createCommunityApplication({
    listen: { host: '127.0.0.1', port: 0 },
    sessionSecret: 'skill-folding-fixture-session-secret-32-bytes',
    runtime: {
      command: '/unavailable-dsh',
      args: [],
      dataRoot: root,
      defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'http://127.0.0.1:1' } },
    },
  })
  const origin = await app.start()
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ locale: 'en', viewport: { width: 1280, height: 900 } })
  page.setDefaultTimeout(10000)
  if (process.env.DSH_PHALANX_E2E_CPU_THROTTLE) await (await page.context().newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: 4 })
  await page.goto(`${origin}/bootstrap#credential=${readBootstrapCredential(root)!.credential}`)
  await selectBuiltinDatabase(page)
  await page.getByLabel('Username', { exact: true }).fill('admin')
  await page.getByLabel('Password', { exact: true }).fill('password')
  await page.getByRole('button', { name: 'Create administrator' }).click()
  await page.getByRole('button', { name: /^(Skip for now and finish installation|暂时跳过，完成安装)$/u }).click()
  await page.waitForURL(origin + '/admin')
  const preview = await (
    await page.request.post(origin + '/admin/api/skills/import', {
      headers: { origin, 'content-type': 'application/zip' },
      data: skillZip(['solo', 'child', 'shared'].map(name => ({ path: `skills/${name}/SKILL.md`, content: validSkill.replace('example-skill', name) }))),
    })
  ).json()
  expect(
    (
      await page.request.post(origin + '/admin/api/skills/import/confirm', {
        headers: { origin },
        data: {
          token: preview.token,
          names: ['solo', 'child', 'shared'],
          replacements: [],
          packs: [
            { name: 'research', description: 'Research workflow', skills: ['child', 'shared'] },
            { name: 'writing', description: 'Writing workflow', skills: ['shared'] },
          ],
        },
      })
    ).status(),
  ).toBe(200)
  await page.goto(origin + '/admin/skills?locale=en')
  const library = page.getByRole('region', { name: 'All skills', exact: true })
  await library.getByRole('button', { name: 'View skill solo', exact: true }).waitFor()
  for (const name of ['child', 'shared']) expect(await library.getByRole('button', { name: `View skill ${name}`, exact: true }).count()).toBe(0)
  for (const name of ['research', 'writing']) await library.getByRole('button', { name: `View skill pack ${name}`, exact: true }).waitFor()
  const evidence = process.env.DSH_PHALANX_E2E_EVIDENCE_DIR
  if (evidence) {
    await mkdir(evidence, { recursive: true })
    await page.screenshot({ path: join(evidence, 'skill-list-collapsed-desktop.png'), fullPage: true, animations: 'disabled' })
  }
  await library.getByRole('button', { name: 'View skills in research', exact: true }).click()
  const packContents = page.getByRole('dialog', { name: 'research', exact: true })
  for (const name of ['child', 'shared']) await packContents.getByRole('button', { name: `View skill ${name}`, exact: true }).waitFor()
  expect(await library.getByRole('button', { name: 'View skills in research', exact: true }).getAttribute('aria-expanded')).toBe('true')
  if (evidence) await page.screenshot({ path: join(evidence, 'skill-list-expanded-desktop.png'), fullPage: true, animations: 'disabled' })
  await packContents.getByRole('button', { name: 'View skill child', exact: true }).click()
  await page.getByRole('dialog').getByText('A useful skill', { exact: true }).first().waitFor()
  await page.getByRole('button', { name: 'Close skill details', exact: true }).click()
  await library.getByRole('button', { name: 'View skill pack research', exact: true }).click({ position: { x: 12, y: 12 } })
  await page.getByLabel('Pack name', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Close skill pack details', exact: true }).click()
  await library.getByRole('button', { name: /Filter by publication/u }).click()
  await page.getByRole('option', { name: 'Live in Platform App Center', exact: true }).click()
  await library.getByText('No skills match this filter.', { exact: true }).waitFor()
  await library.getByRole('button', { name: 'Show all skills', exact: true }).click()
  await library.getByRole('button', { name: 'View skill pack research', exact: true }).click({ position: { x: 12, y: 12 } })
  await page.getByLabel('Pack description', { exact: true }).fill('Unsaved draft')
  expect(await page.getByRole('button', { name: 'Publish to Platform App Center', exact: true }).isDisabled()).toBe(true)
  await page.getByRole('button', { name: 'Discard changes', exact: true }).click()
  await page.getByRole('button', { name: 'Publish to Platform App Center', exact: true }).click()
  await page.getByRole('dialog', { name: 'Confirm skill pack publication', exact: true }).getByRole('button', { name: 'Confirm', exact: true }).click()
  await page.getByRole('button', { name: 'Unpublish', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Close skill pack details', exact: true }).click()
  await page.getByRole('dialog').waitFor({ state: 'detached' })
  await library.getByRole('button', { name: /Filter by publication/u }).click()
  await page.getByRole('option', { name: 'Live in Platform App Center', exact: true }).click()
  await library.getByRole('button', { name: 'View skill pack research', exact: true }).waitFor()
  expect(await library.getByRole('button', { name: 'View skill pack writing', exact: true }).count()).toBe(0)
  expect(await library.getByRole('button', { name: 'View skill solo', exact: true }).count()).toBe(0)
  await library.getByRole('button', { name: /Filter by publication/u }).click()
  await page.getByRole('option', { name: 'All skills', exact: true }).click()
  await library.getByRole('button', { name: 'View skills in research', exact: true }).click()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: /Platform language/ }).click()
  await page.getByRole('menuitemradio', { name: '简体中文', exact: true }).click()
  await page.getByRole('menuitemradio', { name: '简体中文', exact: true }).waitFor({ state: 'detached' })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('region', { name: '全部技能', exact: true }).getByRole('button', { name: '查看 research 中的技能', exact: true }).click()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  if (evidence) await page.screenshot({ path: join(evidence, 'skill-list-expanded-mobile-zh.png'), fullPage: true, animations: 'disabled' })
})
