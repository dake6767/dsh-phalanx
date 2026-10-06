import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import WebSocket from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import { createCommunityApplication } from '../src/composition/community-application.js'
import type { CommunityApplication } from '../src/ports/community-application.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { DSH_REMOTE_MUX_PATH, SESSION_LIST } from '../src/dsh/session-protocol.js'
import { defaultWorkspacePath, assertPinnedDshRevision, runtimeSection } from './support/real-dsh-runtime.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { cookieHeader, createRealDshRpc } from './support/real-dsh-rpc.js'
import { signInCommunity as signIn, selectCommunityWorkspace, runCommunityTerminal as terminal, sendCommunityTerminal } from './fixtures/community-native-browser.js'
import { communityEntryUrl } from './support/community-space.js'
import { newValidationContext, saveBrowserEvidence } from './fixtures/browser-evidence.js'

describe('community account lifecycle through real DSH', () => {
  let root: string | undefined
  let application: CommunityApplication | undefined
  let browser: Browser | undefined
  const sockets: WebSocket[] = []
  afterEach(async context => {
    await saveBrowserEvidence(context)
    for (const socket of sockets.splice(0)) socket.terminate()
    await browser?.close(); await application?.stop()
    if (root !== undefined) await rm(root, { recursive: true, force: true })
    root = undefined; application = undefined; browser = undefined
  })
  const start = async () => {
    application = createCommunityApplication({ listen: { host: '127.0.0.1', port: 0 },
      sessionSecret: 'community-lifecycle-browser-session-secret-32-bytes',
      runtime: runtimeSection(root!, 'http://127.0.0.1:1', runtimeSettings) })
    return await application.start()
  }
  const workspace = async (context: BrowserContext, page: Page, origin: string, username: string) => {
    await selectCommunityWorkspace(context, page, origin, defaultWorkspacePath(root!, username))
  }
  const connect = async (origin: string, context: BrowserContext) => {
    const cookie = await cookieHeader(context, origin)
    const socket = new WebSocket(`${communityEntryUrl(origin, cookie).replace(/^http/u, 'ws')}${DSH_REMOTE_MUX_PATH.slice(1)}`, { headers: { cookie } })
    sockets.push(socket)
    socket.on('error', () => {})
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
    return socket
  }
  const perform = async (admin: Page, label: string, password?: string) => {
    if (label.startsWith('Disable ') || label.startsWith('Enable ')) await admin.getByRole('button', { name: label, exact: true }).click()
    else {
      await admin.getByRole('button', { name: `More actions for ${label.includes('other') ? 'other' : 'member'}`, exact: true }).click()
      await admin.getByRole('menuitem', { name: label, exact: true }).click()
    }
    const dialog = admin.getByRole('dialog').filter({ has: admin.getByRole('button', { name: 'Confirm action', exact: true }) })
    await dialog.waitFor()
    if (password !== undefined) await dialog.getByLabel('New password').fill(password)
    await dialog.getByRole('button', { name: 'Confirm action', exact: true }).click()
    await dialog.waitFor({ state: 'detached' })
    await admin.getByRole('status').waitFor()
  }

  it('manages two members, revokes old devices, protects the last admin and preserves deleted user data', async () => {
    if (runtimeSettings.dshRoot === undefined || runtimeSettings.containerImage !== undefined) throw new Error('This acceptance requires pinned development DSH, without a container image')
    assertPinnedDshRevision(runtimeSettings)
    root = await mkdtemp(join(tmpdir(), 'community-native-lifecycle-'))
    let origin = await start()
    browser = await chromium.launch({ headless: true })
    const adminContext = await newValidationContext(browser)
    let admin = await adminContext.newPage()
    await admin.goto(`${origin}/bootstrap#credential=${encodeURIComponent(readBootstrapCredential(root)!.credential)}`)
    await admin.getByLabel('Username').fill('admin')
    await admin.getByLabel('Password', { exact: true }).fill('admin-password')
    await admin.getByRole('button', { name: 'Create administrator' }).click()
    await admin.waitForURL(`${origin}/admin`)
    for (const username of ['member', 'other']) {
      await admin.getByRole('button', { name: 'Add account', exact: true }).click()
      await admin.getByLabel('Username').fill(username); await admin.getByLabel('Email').fill(`${username}@example.test`)
      await admin.getByLabel('Temporary password').fill('member-password')
      await admin.getByRole('button', { name: 'Create account', exact: true }).click()
      await admin.getByRole('status').filter({ hasText: `Account ${username} created.` }).waitFor()
      await admin.getByRole('row').filter({ hasText: `${username}@example.test` }).waitFor()
    }
    const memberContext = await newValidationContext(browser)
    const member = await memberContext.newPage()
    await signIn(member, origin, 'member', 'member-password'); await workspace(memberContext, member, origin, 'member')
    const marker = 'COMMUNITY_FILE_RETAINED'
    const octal = [...marker].map(character => `\\${character.charCodeAt(0).toString(8).padStart(3, '0')}`).join('')
    const retainedFile = `${defaultWorkspacePath(root, 'member')}/account-retained.txt`
    await terminal(member, `printf '${octal}' > '${retainedFile}'; cat '${retainedFile}'`, marker)
    const device = await newValidationContext(browser)
    await signIn(await device.newPage(), origin, 'member', 'member-password')
    const otherContext = await newValidationContext(browser)
    const other = await otherContext.newPage()
    await signIn(other, origin, 'other', 'member-password'); await workspace(otherContext, other, origin, 'other')
    const memberSocket = await connect(origin, memberContext)
    const deviceSocket = await connect(origin, device)
    const otherSocket = await connect(origin, otherContext)
    const beforeEmail = await (await adminContext.request.get(`${origin}/admin/api/accounts`)).json() as { items: { username: string, spaceId: string }[] }
    const emailSpace = beforeEmail.items.find(row => row.username === 'member')!.spaceId
    await admin.getByRole('button', { name: 'Edit member', exact: true }).click()
    const emailDrawer = admin.getByRole('dialog', { name: 'Edit account: member', exact: true })
    await emailDrawer.getByLabel('Email', { exact: true }).fill('updated@example.test')
    await emailDrawer.getByRole('button', { name: 'Save email', exact: true }).click(); await emailDrawer.waitFor({ state: 'detached' })
    const afterEmail = await (await adminContext.request.get(`${origin}/admin/api/accounts`)).json() as { items: { username: string, spaceId: string, email: string }[] }
    expect(afterEmail.items.find(row => row.username === 'member')).toMatchObject({ spaceId: emailSpace, email: 'updated@example.test' })
    expect(memberSocket.readyState).toBe(WebSocket.OPEN); expect(deviceSocket.readyState).toBe(WebSocket.OPEN)
    const emailMarker = [...'EMAIL_SESSION_RETAINED'].map(character => `\\${character.charCodeAt(0).toString(8).padStart(3, '0')}`).join('')
    await sendCommunityTerminal(member, `if [ "$(cat '${retainedFile}')" = '${marker}' ]; then printf '${emailMarker}'; fi`, 'EMAIL_SESSION_RETAINED')
    const closedDevices = Promise.all([memberSocket, deviceSocket].map(socket => new Promise<void>(resolve => socket.once('close', () => resolve()))))
    await perform(admin, 'Reset password for member', 'new-password')
    await closedDevices
    for (const context of [memberContext, device]) expect((await context.request.get(origin, { maxRedirects: 0 })).status()).toBe(303)
    expect(otherSocket.readyState).toBe(WebSocket.OPEN)
    const replacement = await newValidationContext(browser)
    await signIn(await replacement.newPage(), origin, 'member', 'new-password')
    const replacementSocket = await connect(origin, replacement)
    const disabledClose = new Promise<void>(resolve => replacementSocket.once('close', () => resolve()))
    await perform(admin, 'Disable member'); await disabledClose
    expect((await replacement.request.get(origin, { maxRedirects: 0 })).status()).toBe(303)
    expect(otherSocket.readyState).toBe(WebSocket.OPEN)
    await perform(admin, 'Enable member')
    expect((await replacement.request.get(origin, { maxRedirects: 0 })).status()).toBe(303)
    await signIn(member, origin, 'member', 'new-password')
    await workspace(memberContext, member, origin, 'member')
    await member.getByText('This terminal no longer exists. Open a new terminal.', { exact: true }).waitFor()
    await terminal(member, `cat '${retainedFile}'`, marker)
    await perform(admin, 'Make other an administrator')
    expect((await otherContext.request.get(`${origin}/admin/api/session`)).status()).toBe(200)
    await perform(admin, 'Remove administrator role from other')
    expect((await otherContext.request.get(`${origin}/admin/api/session`)).status()).toBe(403)
    for (const input of [{ action: 'set-disabled', disabled: true }, { action: 'set-admin', admin: false }, { action: 'delete' }]) {
      expect((await adminContext.request.post(`${origin}/admin/api/accounts/admin/actions`, { data: input })).status()).toBe(409)
    }
    expect((await otherContext.request.post(`${origin}/admin/api/accounts/member/actions`, { data: { action: 'delete' } })).status()).toBe(403)
    const beforeDelete = await (await adminContext.request.get(`${origin}/admin/api/accounts`)).json() as { items: { username: string, spaceId: string }[] }
    const oldSpaceId = beforeDelete.items.find(account => account.username === 'member')!.spaceId
    await admin.getByRole('button', { name: 'More actions for member', exact: true }).click()
    await admin.getByRole('menuitem', { name: 'Delete member', exact: true }).click()
    expect(await admin.getByRole('dialog', { name: 'Delete account: member', exact: true }).textContent()).toContain('User-space files will be preserved')
    await admin.getByRole('dialog', { name: 'Delete account: member', exact: true }).getByRole('button', { name: 'Confirm action' }).click()
    await admin.getByRole('dialog', { name: 'Delete account: member', exact: true }).waitFor({ state: 'detached' })
    expect((await memberContext.request.get(origin, { maxRedirects: 0 })).status()).toBe(303)
    expect(otherSocket.readyState).toBe(WebSocket.OPEN)
    const rpc = createRealDshRpc()
    expect((await rpc.remoteRpc<{ items: unknown[] }>(origin, await cookieHeader(otherContext, origin), SESSION_LIST, { _request: {} })).items.length).toBeGreaterThan(0)
    // Development mode has no container boundary: observe retained data through
    // the deployer's own native DSH terminal, not by reading the host from this test.
    const deployer = await adminContext.newPage()
    await deployer.goto(`${origin}/enter`); await workspace(adminContext, deployer, origin, 'admin')
    await terminal(deployer, `cat '${retainedFile}'`, marker)
    for (const context of browser.contexts()) await context.close()
    await application!.stop(); origin = await start()
    const restarted = await newValidationContext(browser)
    admin = await restarted.newPage(); await signIn(admin, origin, 'admin', 'admin-password', true)
    await admin.getByRole('button', { name: 'Add account', exact: true }).click()
    await admin.getByLabel('Username').fill('member'); await admin.getByLabel('Email').fill('replacement@example.test')
    await admin.getByLabel('Temporary password').fill('password')
    await admin.getByRole('button', { name: 'Create account', exact: true }).click()
    await admin.getByRole('status').filter({ hasText: 'Account member created.' }).waitFor()
    const afterCreate = await (await restarted.request.get(`${origin}/admin/api/accounts`)).json() as { items: { username: string, spaceId: string }[] }
    const newSpaceId = afterCreate.items.find(account => account.username === 'member')!.spaceId
    expect(newSpaceId).not.toBe(oldSpaceId)
    const recreatedContext = await newValidationContext(browser)
    const recreated = await recreatedContext.newPage()
    await signIn(recreated, origin, 'member', 'password')
    await selectCommunityWorkspace(recreatedContext, recreated, origin, defaultWorkspacePath(root, `_spaces/${newSpaceId}`))
    await terminal(recreated, "test ! -e account-retained.txt && printf 'NEW_%s' SPACE", 'NEW_SPACE')
  })
})
