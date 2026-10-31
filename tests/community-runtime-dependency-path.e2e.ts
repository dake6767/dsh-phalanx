// Validation: T2; real credentials: none; actual Linux rootless DSH. Missing inputs must fail the T2 report gate.
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it, vi } from 'vitest'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import { FileExecutionArtifacts } from '../src/adapters/execution-artifacts.js'
import { FileSkillArtifacts } from '../src/adapters/skill-artifacts.js'
import { FileSkillDistribution } from '../src/adapters/skill-distribution.js'
import { effectiveUserDataRoot } from '../src/domain/storage-layout.js'
import { startCommunityModel } from './fixtures/community-model.js'
import { runCommunityTerminal, selectCommunityWorkspace } from './fixtures/community-native-browser.js'
import { removeCommunityFixture } from './fixtures/owned-cleanup.js'
import { skillZip } from './fixtures/skills/archive.js'
import { candidateApplication } from './support/candidate-application.js'
import { openTestAccounts } from './support/community-application.js'
import { communityEntryUrl } from './support/community-space.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { cookieHeader } from './support/real-dsh-rpc.js'
import { assertPinnedDshRevision, defaultWorkspacePath, instanceWorkspacePath, runtimeSection } from './support/real-dsh-runtime.js'

it.skipIf(!runtimeSettings.containerImage)(
  'hot grants, updates and revokes dependency commands in real agent bash and terminals while retaining running processes',
  async () => {
    assertPinnedDshRevision(runtimeSettings)
    const root = await mkdtemp(join(tmpdir(), 'dependency-member-')),
      home = join(effectiveUserDataRoot({ dataRoot: root }), 'member/home'),
      workspace = join(effectiveUserDataRoot({ dataRoot: root }), 'member/workspace')
    const overlay = join(root, 'observer.json')
    await writeFile(
      overlay,
      JSON.stringify([
        { id: 'tools', config: { mode: 'native' } },
        { id: 'session-log-deepseek', disabled: true },
        { insert: [{ id: 'skills-observer', name: '/dsh-phalanx/home/skills-observer.mjs' }] },
      ]),
    )
    const model = await startCommunityModel(),
      runtime = { ...runtimeSection(root, model.origin, runtimeSettings), patches: [overlay] }
    const app = candidateApplication({
      listen: { host: '127.0.0.1', port: 0 },
      sessionSecret: 'dependency-member-fixture-secret-32',
      runtime,
      modelGateway: { upstreamApiKey: 'community-provider-fixture-key' },
    })
    let startupFailure: unknown
    const realStart = CommunityRuntimeDriver.prototype.start
    const diagnostic = vi.spyOn(CommunityRuntimeDriver.prototype, 'start').mockImplementation(async function (this: CommunityRuntimeDriver, ...args) {
      try {
        return await realStart.apply(this, args)
      } catch (error) {
        startupFailure = error
        throw error
      }
    })
    const accounts = await openTestAccounts(root),
      browser = await chromium.launch({ headless: true })
    try {
      await accounts.createFirstAdmin({ username: 'admin', password: 'password', email: '' })
      await accounts.create({ username: 'member', password: 'password', email: '' })
      const origin = await app.start()
      await mkdir(home, { recursive: true, mode: 0o700 })
      await copyFile(fileURLToPath(new URL('./fixtures/skill-observer.mjs', import.meta.url)), join(home, 'skills-observer.mjs'))
      const page = await browser.newPage({ locale: 'en' })
      page.setDefaultTimeout(15000)
      const login = await fetch(origin + '/login', {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ username: 'admin', password: 'password' }),
      })
      const admin = login.headers
        .getSetCookie()
        .map(value => value.split(';')[0])
        .join('; ')
      const get = async (path: string) => {
        const response = await fetch(origin + path, { headers: { cookie: admin } })
        expect(response.status).toBe(200)
        return response.json()
      }
      const post = async (path: string, body: object, options?: { preparationDeadline: number }) => {
        const send = () =>
          fetch(origin + path, {
            method: 'POST',
            headers: { cookie: admin, origin, 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
        let response = await send()
        // Ready facts and the member PATH can publish before the preparation lease retires.
        // Retry only rejected busy requests; an accepted update is never submitted twice.
        while (response.status === 409 && Date.now() < (options?.preparationDeadline ?? 0)) {
          const rejected = await response.clone().json()
          if (rejected.code !== 'runtime-dependency-unavailable' || rejected.error !== 'Wait for the current preparation to finish.') break
          await delay(50)
          response = await send()
        }
        expect(response.ok, await response.clone().text()).toBe(true)
        return response.json()
      }
      const memberLogin = await page.request.post(origin + '/login', { maxRedirects: 0, form: { username: 'member', password: 'password' } })
      expect(memberLogin.status(), await memberLogin.text()).toBe(303)
      expect(memberLogin.headers().location, String(startupFailure)).not.toBe('/recovery')
      await page.goto(origin + memberLogin.headers().location)
      await selectCommunityWorkspace(page.context(), page, origin, instanceWorkspacePath(defaultWorkspacePath(root, 'member'), true), true)
      await page.locator('[data-composer-input]').fill('Create a terminal session.')
      await page.locator('[data-composer-input]').press('Enter')
      await page.getByText('COMMUNITY_', { exact: true }).waitFor({ timeout: 30000 })
      model.release()
      await page.locator('p').filter({ hasText: 'COMMUNITY_MODEL_READY' }).last().waitFor()
      const cookie = await cookieHeader(page.context(), origin)
      const observe = async (body: object) => {
        const response = await fetch(communityEntryUrl(origin, cookie) + 'skills-fixture', {
          method: 'POST',
          headers: { cookie, origin, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        expect(response.status, await response.clone().text()).toBe(200)
        return response.json()
      }
      const bash = async (command: string) => {
        const { sessionId } = await observe({ operation: 'create' })
        return (await observe({ operation: 'tool', sessionId, name: 'bash', args: { description: 'Probe dependency command', command, timeoutMs: 10000 } }))
          .value
      }
      const terminal = async (command: string, output: string) => {
        if (!(await page.locator('[data-sidebar-right-guide-entry="terminal"]').isVisible()) && (await page.locator('[data-dockkit-add-tab]').isVisible()))
          await page.locator('[data-dockkit-add-tab]').click()
        await runCommunityTerminal(page, command, output)
      }
      const initial = await observe({ operation: 'inventory' })
      expect((await bash('rd-tool')).exitCode).toBe(127)
      const definition = (version: string) => ({
        name: 'member-tools',
        prepareCommand: `set -eu; mkdir bin; printf '%s\n' '#!/bin/sh' 'if [ "\${1:-}" = hold ]; then touch /dsh-phalanx/workspace/held; while [ ! -e /dsh-phalanx/workspace/release ]; do sleep 0.02; done; fi' > bin/rd-tool; printf 'cat "%s/version"\\n' "$RD_OUT" >> bin/rd-tool; printf '%s\\n' '${version}' > version; chmod +x bin/rd-tool`,
        pathDirectories: ['bin'],
        checkCommand: 'rd-tool',
      })
      await post('/admin/api/runtime-dependencies', { action: 'create', input: definition('v1') })
      await expect.poll(async () => (await get('/admin/api/runtime-dependencies?name=member-tools')).stage, { timeout: 30000 }).toBe('ready')
      const archive = skillZip([{ path: 'SKILL.md', content: '---\nname: dependency-skill\ndescription: Dependency fixture\n---\nUse rd-tool.' }])
      const uploaded = await fetch(origin + '/admin/api/skills/upload', {
        method: 'POST',
        headers: { cookie: admin, origin, 'content-type': 'application/zip' },
        body: new Uint8Array(archive),
      })
      expect(uploaded.status).toBe(200)
      const preview = await uploaded.json()
      await post('/admin/api/skills/change', { action: 'confirm', token: preview.token, revision: preview.revision })
      const bind = async (names: string[]) => {
        const detail = await get('/admin/api/skills/detail?name=dependency-skill')
        await post('/admin/api/skills/change', { action: 'runtime-dependencies', name: detail.name, names, revision: detail.revision })
      }
      await bind(['member-tools'])
      const groupPath = '/admin/api/groups/' + (await accounts.get('member'))!.groupId + '/skills'
      const grant = async (names: string[]) => {
        const group = await get(groupPath)
        await post(groupPath, { action: 'save', names, confirmed: true, revision: group.revision })
      }
      await grant(['dependency-skill'])
      expect(await bash('rd-tool')).toMatchObject({ exitCode: 0, stdout: { text: 'v1\n' } })
      await terminal("rd-tool > /dsh-phalanx/workspace/terminal.txt; printf 'FIRST_%s\\n' DONE", 'FIRST_DONE')
      expect(await readFile(join(workspace, 'terminal.txt'), 'utf8')).toBe('v1\n')
      await terminal("rd-tool hold > /dsh-phalanx/workspace/held-output.txt & printf 'HELD_%s\\n' STARTED", 'HELD_STARTED')
      await expect
        .poll(async () => {
          try {
            await readFile(join(workspace, 'held'))
            return true
          } catch {
            return false
          }
        })
        .toBe(true)
      for (const version of ['v2', 'v3']) {
        const deadline = Date.now() + 30000
        await post('/admin/api/runtime-dependencies', { action: 'update', name: 'member-tools', input: definition(version) }, { preparationDeadline: deadline })
        await expect
          .poll(async () => (await get('/admin/api/runtime-dependencies?name=member-tools')).stage, { timeout: Math.max(1, deadline - Date.now()) })
          .toBe('ready')
        // Ready publishes frozen facts before the asynchronous member PATH projection finishes.
        await expect
          .poll(
            async () => {
              const result = await bash('rd-tool')
              return { exitCode: result.exitCode, stdout: result.stdout.text }
            },
            { timeout: Math.max(1, deadline - Date.now()) },
          )
          .toEqual({ exitCode: 0, stdout: version + '\n' })
      }
      await grant([])
      expect((await bash('rd-tool')).exitCode).toBe(127)
      await terminal("rd-tool; printf 'REVOKED_%s\\n' $?", 'REVOKED_127')
      await bind([])
      await post('/admin/api/runtime-dependencies', { action: 'remove', name: 'member-tools' })
      await writeFile(join(workspace, 'release'), '')
      await expect.poll(async () => readFile(join(workspace, 'held-output.txt'), 'utf8')).toBe('v1\n')
      expect((await observe({ operation: 'inventory' })).instance).toBe(initial.instance)
    } finally {
      diagnostic.mockRestore()
      await browser.close()
      await app.stop()
      await new CommunityRuntimeDriver(runtime).rebuild()
      await accounts.close()
      const skills = new FileSkillArtifacts(join(root, 'skills/artifacts'), [])
      await new FileSkillDistribution(join(root, 'skills/members'), skills).synchronize([])
      await skills.collect([])
      await new FileExecutionArtifacts(join(root, 'runtime-dependencies', '.trees')).collect([])
      await removeCommunityFixture(root)
      await model.close()
    }
  },
  300000,
)
