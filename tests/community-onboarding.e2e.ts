import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'
import { createCommunityApplication } from '../src/composition/community-application.js'
import type { CommunityApplication } from '../src/ports/community-application.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { defaultWorkspacePath, assertPinnedDshRevision, runtimeSection } from './support/real-dsh-runtime.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { signInCommunity as signIn, selectCommunityWorkspace as selectWorkspace, runCommunityTerminal as terminal } from './fixtures/community-native-browser.js'
import { newValidationContext, saveBrowserEvidence } from './fixtures/browser-evidence.js'

describe('community onboarding through the native DSH product entry', () => {
  let root: string | undefined
  let application: CommunityApplication | undefined
  let browser: Browser | undefined
  afterEach(async context => {
    await saveBrowserEvidence(context)
    await browser?.close()
    await application?.stop()
    if (root !== undefined) await rm(root, { recursive: true, force: true })
    root = undefined; application = undefined; browser = undefined
  })
  const start = async (): Promise<string> => {
    if (root === undefined) throw new Error('test data root is missing')
    application = createCommunityApplication({ listen: { host: '127.0.0.1', port: 0 },
      sessionSecret: 'community-native-browser-session-secret-32-bytes',
      runtime: runtimeSection(root, 'http://127.0.0.1:1', runtimeSettings) })
    return await application.start()
  }

  it('creates the first admin and member through the browser, then reads the same user-space file after restart', async () => {
    if (runtimeSettings.dshRoot === undefined || runtimeSettings.containerImage !== undefined) {
      throw new Error('This acceptance requires the pinned external DSH in development mode')
    }
    assertPinnedDshRevision(runtimeSettings)
    root = await mkdtemp(join(tmpdir(), 'community-native-onboarding-'))
    let origin = await start()
    const credential = readBootstrapCredential(root)!.credential
    browser = await chromium.launch({ headless: true })
    const adminContext = await newValidationContext(browser)
    const admin = await adminContext.newPage()
    await admin.goto(`${origin}/bootstrap#credential=${encodeURIComponent(credential)}`)
    expect(await (await adminContext.request.get(`${origin}/bootstrap`)).text()).not.toContain(credential)
    expect(await admin.locator('.create-account select').count()).toBe(0)
    expect(await admin.getByLabel('Bootstrap credential').count()).toBe(0)
    expect(await admin.getByLabel('Email', { exact: true }).count()).toBe(0)
    await admin.getByLabel('Username').fill('admin')
    await admin.getByLabel('Password', { exact: true }).fill('admin-password')
    await admin.getByRole('button', { name: 'Create administrator' }).click()
    await admin.waitForURL(`${origin}/admin`)
    expect(readBootstrapCredential(root)).toBeUndefined()
    await admin.getByRole('heading', { name: 'Account management' }).waitFor()
    expect(await admin.getByRole('link', { name: 'Model management', exact: true }).count()).toBe(1)
    await admin.getByRole('link', { name: 'Model management', exact: true }).click()
    await admin.getByRole('region', { name: 'Model settings', exact: true }).getByText('No shared models configured.', { exact: true }).waitFor()
    await admin.getByRole('link', { name: 'Open DSH', exact: true }).click()
    await admin.waitForURL(url => url.origin === origin && /^\/app\/[^/]+\/$/u.test(url.pathname))
    await selectWorkspace(adminContext, admin, origin, defaultWorkspacePath(root, 'admin'))
    await terminal(admin, "printf 'ADMIN_DSH_%s' 'ENTRY_OK'", 'ADMIN_DSH_ENTRY_OK')
    await admin.goto(`${origin}/admin`)
    await admin.getByLabel('Username').fill('member')
    await admin.getByLabel('Email').fill('member@example.test')
    await admin.getByLabel('Temporary password').fill('member-password')
    await admin.getByRole('button', { name: 'Create account', exact: true }).click()
    await admin.getByRole('status').filter({ hasText: 'Account member created.' }).waitFor()
    const row = admin.getByRole('row').filter({ hasText: 'member@example.test' })
    await row.waitFor()
    expect(await row.textContent()).toContain('Member')
    expect(await admin.getByLabel('Temporary password').inputValue()).toBe('')
    expect(await admin.locator('.create-account select').count()).toBe(0)
    await adminContext.close()

    let memberContext = await newValidationContext(browser)
    let member = await memberContext.newPage()
    await signIn(member, origin, 'member', 'member-password')
    const workspace = defaultWorkspacePath(root, 'member')
    await selectWorkspace(memberContext, member, origin, workspace)
    await member.locator('[data-composer-input]').fill('NO_MODEL_TASK')
    await member.locator('[data-composer-input]').press('Enter')
    await member.getByText(/Shared models are not configured/u).filter({ visible: true }).first().waitFor({ timeout: 20_000 })
    const marker = 'COMMUNITY_FILE_PERSISTED'
    const escaped = [...marker].map(character => `\\${character.charCodeAt(0).toString(8).padStart(3, '0')}`).join('')
    const file = `${workspace}/onboarding-persistence.txt`
    await terminal(member, `printf '${escaped}' > '${file}'; cat '${file}'`, marker)
    const refused = await memberContext.request.post(`${origin}/admin/api/accounts`, { data: { username: 'intruder', email: 'intruder@example.test', password: 'password' } })
    expect(refused.status()).toBe(403)
    expect((await memberContext.request.get(`${origin}/register`)).status()).toBe(404)
    await memberContext.close()
    await application!.stop()
    origin = await start()
    expect(readBootstrapCredential(root)).toBeUndefined()
    memberContext = await newValidationContext(browser)
    member = await memberContext.newPage()
    await signIn(member, origin, 'member', 'member-password')
    await selectWorkspace(memberContext, member, origin, workspace)
    await terminal(member, `cat '${file}'`, marker)
    await memberContext.close()
  })
})
