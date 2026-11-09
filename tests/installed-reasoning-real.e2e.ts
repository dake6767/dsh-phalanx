// Validation: T4 dedicated validation host; real credentials: required (0600 provider original and SSH). Never selected by T2.
import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { open, mkdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import type { CommunityModelSettings } from '../src/domain/admin-contract.js'
import type { UsageModelView } from '../src/domain/usage-record.js'
import {
  openCommunitySession,
  selectCommunityWorkspace,
  sendCommunityPrompt,
  signInCommunity,
  startCommunitySession,
} from './fixtures/community-native-browser.js'
import { cookieHeader, createBrowserDshRpc } from './support/real-dsh-rpc.js'
import { instanceWorkspacePath } from './support/real-dsh-runtime.js'

/** Read only the maintainer-selected original; never copy it or put its contents in diagnostics. */
async function originalCredential(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.size > 4096)
      throw Error('The provider original must be a current-user regular 0600 file')
    const key = (await file.readFile('utf8')).trim()
    if (!key || /[^\x21-\x7e]/u.test(key)) throw Error('The provider original must contain one raw key')
    return key
  } finally {
    await file.close()
  }
}

it('uses member-selected reasoning through both real protocols on the exact installed candidate', async () => {
  const host = process.env.DSH_PHALANX_INSTALL_SSH_TARGET,
    origin = process.env.DSH_PHALANX_INSTALL_ORIGIN,
    expectedSha = process.env.DSH_PHALANX_CANDIDATE_SHA,
    expectedImage = process.env.DSH_PHALANX_INSTALL_IMAGE_DIGEST,
    expectedPlatform = process.env.DSH_PHALANX_INSTALL_PLATFORM_SHA256,
    keyPath = process.env.DSH_PHALANX_REAL_REASONING_KEY_FILE,
    evidence = process.env.DSH_PHALANX_E2E_EVIDENCE_DIR
  if (
    !host ||
    !/^[a-zA-Z0-9][a-zA-Z0-9@_.-]*$/u.test(host) ||
    !origin ||
    !/^http:\/\/127\.0\.0\.1:\d+$/u.test(origin) ||
    !expectedSha ||
    !expectedImage ||
    !expectedPlatform ||
    !keyPath ||
    !evidence
  )
    throw Error('Requires an owned clean-install host, forwarded origin, exact candidate identity, provider original and private evidence directory')
  const { stdout } = await promisify(execFile)('ssh', ['-o', 'BatchMode=yes', host, 'sudo -n cat /etc/dsh-phalanx/installed-manifest.json'], { timeout: 30000 })
  const manifest = JSON.parse(stdout)
  expect(manifest).toMatchObject({
    commit: expectedSha,
    platform: 'linux/amd64',
    image: { digest: expectedImage },
    files: { 'dsh-phalanx-linux-amd64.tar.gz': expectedPlatform },
  })
  const key = await originalCredential(keyPath)
  const browser = await chromium.launch({ headless: true })
  const results: object[] = [],
    failures: unknown[] = []
  const admin = await browser.newContext({ locale: 'en' })
  let original: CommunityModelSettings | undefined
  const created: string[] = []
  const api = async (data?: object) => {
    const response = data
      ? await admin.request.post(origin + '/admin/api/models', { headers: { origin }, data })
      : await admin.request.get(origin + '/admin/api/models')
    expect(response.status()).toBe(200)
    const text = await response.text()
    expect(text.includes(key), 'Provider original absent from management responses').toBe(false)
    return JSON.parse(text) as CommunityModelSettings
  }
  try {
    expect(
      (
        await admin.request.post(origin + '/login', {
          headers: { origin },
          form: { username: 'installer-admin', password: 'installer-admin-password' },
          maxRedirects: 0,
        })
      ).status(),
    ).toBe(303)
    original = await api()
    expect(original.defaultModelId).not.toBeNull()
    for (const protocol of [
      { apiFormat: 'openai-completions', baseUrl: 'https://api.deepseek.com', effort: 'High' },
      { apiFormat: 'anthropic-messages', baseUrl: 'https://api.deepseek.com/anthropic', effort: 'Low' },
    ] as const) {
      const name = 'Reasoning acceptance ' + protocol.apiFormat
      let settings = await api({
        revision: (await api()).revision,
        action: 'save-provider',
        provider: {
          name,
          baseUrl: protocol.baseUrl,
          apiFormat: protocol.apiFormat,
          apiKey: key,
          enabled: true,
          models: [{ name: 'deepseek-flash', enabled: true, reasoning: true }],
        },
      })
      const provider = settings.providers.find(row => row.name === name)!,
        model = provider.models[0]!
      created.push(provider.id)
      settings = await api({ revision: settings.revision, action: 'set-default', defaultModelId: model.id })
      const memberContext = await browser.newContext({ locale: 'en' })
      try {
        const member = await memberContext.newPage(),
          frames: string[] = []
        member.setDefaultTimeout(60000)
        member.on('websocket', socket => socket.on('framereceived', event => frames.push(String(event.payload))))
        await signInCommunity(member, origin, 'installer-member', 'installer-member-password')
        await selectCommunityWorkspace(memberContext, member, origin, instanceWorkspacePath('', true), true)
        await startCommunitySession(member)
        const selector = member.getByRole('button', { name: /^Select model(?:,|$)/u })
        const selectionSettled = async () => {
          await expect
            .poll(async () => ({ busy: await selector.getAttribute('aria-busy'), open: await selector.getAttribute('aria-expanded') }), { timeout: 30000 })
            .toEqual({ busy: 'false', open: 'false' })
          expect(await selector.getAttribute('aria-label')).toContain('current deepseek-flash')
        }
        await selector.click()
        const modelMenu = member.getByRole('menuitem', { name: /^Model/u })
        // A blank retaining a removed provider opens directly on the model list.
        if (await modelMenu.count()) await modelMenu.click()
        await member.getByRole('menuitemradio', { name: /deepseek-flash(?:$|\s)/u }).click()
        await selectionSettled()
        await selector.click()
        await member.getByRole('menuitem', { name: /^Effort/u }).click()
        await member.getByRole('menuitemradio', { name: new RegExp('^' + protocol.effort + '$', 'iu') }).click()
        // Native selection closes asynchronously after the server accepts it.
        await selectionSettled()
        // Reopen to prove the native choice is checked before the actual request.
        await selector.click()
        await member.getByRole('menuitem', { name: /^Effort/u }).click()
        expect(await member.getByRole('menuitemradio', { name: new RegExp('^' + protocol.effort + '$', 'iu') }).getAttribute('aria-checked')).toBe('true')
        await member.keyboard.press('Escape')
        const usage = async () => {
          const response = await admin.request.get(origin + '/admin/api/usage-models?username=installer-member&modelId=' + encodeURIComponent(model.id))
          expect(response.status()).toBe(200)
          return ((await response.json()) as UsageModelView).items.find(row => row.username === 'installer-member' && row.modelId === model.id)
        }
        const rpc = createBrowserDshRpc(memberContext),
          cookie = await cookieHeader(memberContext, origin)
        const sessions = () =>
          rpc.remoteRpc<{ items: { sessionId: string; running: boolean; blank: boolean }[] }>(origin, cookie, 'session/list', { _request: {} })
        const previousSessions = new Set((await sessions()).items.filter(row => !row.blank).map(row => row.sessionId))
        const before = await usage(),
          marker = 'REASONING_OK_' + randomUUID().replaceAll('-', '')
        await sendCommunityPrompt(
          member,
          'Decode these hexadecimal UTF-8 bytes and reply only with the decoded text: ' + Buffer.from(marker).toString('hex') + '. Do not use tools.',
        )
        let sessionId: string | undefined
        await expect
          .poll(
            async () => {
              const createdSessions = (await sessions()).items.filter(row => !row.blank && !previousSessions.has(row.sessionId))
              if (createdSessions.length !== 1) return false
              sessionId = createdSessions[0]!.sessionId
              const conversation = member.locator(`[data-conversation-content][data-conversation-session=${JSON.stringify(sessionId)}]:visible`)
              if (!(await conversation.count())) await openCommunitySession(member, sessionId)
              return conversation.locator('p').filter({ hasText: marker }).last().isVisible()
            },
            { timeout: 300000 },
          )
          .toBe(true)
        await expect.poll(async () => (await sessions()).items.find(row => row.sessionId === sessionId)?.running, { timeout: 300000 }).toBe(false)
        await expect.poll(async () => (await usage())?.requests ?? 0, { timeout: 30000 }).toBeGreaterThan(before?.requests ?? 0)
        const after = (await usage())!
        expect(after.deniedRequests).toBe(before?.deniedRequests ?? 0)
        expect(after.tokens.output).toBeGreaterThan(before?.tokens.output ?? 0)
        expect(frames.join('\n').includes(key) || (await member.content()).includes(key), 'Provider original absent from member transport').toBe(false)
        results.push({
          protocol: protocol.apiFormat,
          baseUrl: protocol.baseUrl,
          model: model.name,
          modelId: model.id,
          username: 'installer-member',
          effort: protocol.effort.toLowerCase(),
          sessionId,
          nativeReply: true,
          before: before ?? null,
          after,
          reasoningCounter: after.tokens.reasoning ?? null,
          status: 'passed',
        })
      } finally {
        await memberContext.close()
      }
      settings = await api()
      await api({ revision: settings.revision, action: 'delete-provider', providerId: provider.id, defaultModelId: original.defaultModelId })
      created.splice(created.indexOf(provider.id), 1)
    }
  } catch (error) {
    failures.push(error)
  } finally {
    for (const id of [...created]) {
      try {
        await api({ revision: (await api()).revision, action: 'delete-provider', providerId: id, defaultModelId: original!.defaultModelId })
        created.splice(created.indexOf(id), 1)
      } catch (error) {
        failures.push(error)
      }
    }
    await browser.close()
    await mkdir(evidence, { recursive: true, mode: 0o700 })
    await writeFile(
      join(evidence, 'installed-reasoning-real.json'),
      JSON.stringify(
        {
          status: failures.length ? 'failed' : 'passed',
          candidate: expectedSha,
          imageDigest: expectedImage,
          platformSha256: expectedPlatform,
          results,
          providersRemoved: created.length === 0,
          failureCount: failures.length,
        },
        null,
        2,
      ) + '\n',
      { mode: 0o600 },
    )
  }
  if (failures.length) throw Error(failures.map(error => String(error).replaceAll(key, '[redacted]')).join('\n'))
}, 900000)
