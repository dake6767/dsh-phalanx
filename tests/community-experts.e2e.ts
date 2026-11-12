// Validation: T2; real credentials: none; actual DSH through installed candidate CLI on Linux.
import { memberSpacePath } from './support/real-dsh-runtime.js'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { chmod, copyFile, mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import { FileExecutionArtifacts } from '../src/adapters/execution-artifacts.js'
import { FileSkillArtifacts } from '../src/adapters/skill-artifacts.js'
import { FileSkillDistribution } from '../src/adapters/skill-distribution.js'
import type { CommunityRuntimeConfig } from '../src/domain/community-config.js'
import { signInCommunity } from './fixtures/community-native-browser.js'
import { removeCommunityFixture } from './fixtures/owned-cleanup.js'
import { skillZip } from './fixtures/skills/archive.js'
import { candidateApplication } from './support/candidate-application.js'
import { selectBuiltinDatabase } from './support/community-bootstrap-browser.js'
import { communityEntryUrl } from './support/community-space.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { hasToolResult, latestHumanText, streamText, streamToolCall } from './support/real-dsh-model.js'
import { cookieHeader, createBrowserDshRpc } from './support/real-dsh-rpc.js'
import { assertPinnedDshRevision, runtimeSection } from './support/real-dsh-runtime.js'

it('creates and grants a skill expert with isolated skills, base tools, appended persona and delegated execution', async () => {
  assertPinnedDshRevision(runtimeSettings)
  const root = await realpath(await mkdtemp(join(tmpdir(), 'community-experts-'))),
    secret = randomUUID()
  const captured = new Map<string, { tools: string[]; system: string; context: string }>()
  let credentialExposed = false
  const model = createServer(async (request, response) => {
    let text = ''
    for await (const chunk of request) text += chunk
    credentialExposed ||= text.includes(secret)
    const body = JSON.parse(text),
      human = latestHumanText(body),
      marker = human.includes('CHILD_EXPERT_TASK') ? 'CHILD_EXPERT_TASK' : human
    if (body.tools?.length)
      captured.set(marker, {
        context: text,
        tools: body.tools.map((tool: { name: string }) => tool.name),
        system: typeof body.system === 'string' ? body.system : (body.system ?? []).map((part: { text: string }) => part.text ?? '').join('\n'),
      })
    response.setHeader('content-type', 'text/event-stream')
    if (marker === 'DELEGATE_EXPERT_TASK' && !hasToolResult(body, 'expert-delegate', false)) {
      streamToolCall(response, 'expert-delegate', 'subagent', { description: 'Check inherited expert capability', prompt: 'CHILD_EXPERT_TASK' })
      return
    }
    streamText(response, 'EXPERT_READY')
  })
  model.listen(0, '127.0.0.1')
  await once(model, 'listening')
  const modelOrigin = `http://127.0.0.1:${(model.address() as { port: number }).port}`
  const runtime: CommunityRuntimeConfig = runtimeSection(root, modelOrigin, runtimeSettings)
  const overlay = join(root, 'expert-test-overlay.json')
  await writeFile(overlay, '[]')
  const app = candidateApplication({
    listen: { host: '127.0.0.1', port: 0 },
    sessionSecret: 'expert-acceptance-fixture-session-secret',
    runtime: { ...runtime, patches: [...(runtime.patches ?? []), overlay] },
  })
  const browser = await chromium.launch({ headless: true })
  let primaryFailure: unknown
  const cleanupErrors: unknown[] = []
  try {
    const origin = await app.start(),
      admin = await browser.newPage({ locale: 'en' })
    admin.setDefaultTimeout(30000)
    await admin.goto(`${origin}/bootstrap#credential=${readBootstrapCredential(root)!.credential}`)
    await selectBuiltinDatabase(admin)
    await admin.getByLabel('Username', { exact: true }).fill('admin')
    await admin.getByLabel('Password', { exact: true }).fill('password')
    await admin.getByRole('button', { name: 'Create administrator', exact: true }).click()
    await admin.getByRole('button', { name: /^(Skip for now and finish installation|暂时跳过，完成安装)$/u }).click()
    await admin.waitForURL(origin + '/admin')
    const api = async (path: string, input?: object) => {
      const response = input
        ? await admin.request.post(origin + '/admin/api/' + path, { headers: { origin }, data: input })
        : await admin.request.get(origin + '/admin/api/' + path)
      expect(response.status(), await response.text()).toBeLessThan(300)
      return response.json()
    }
    const models = await api('models')
    await api('models', {
      revision: models.revision,
      action: 'save-provider',
      provider: {
        name: 'Fixture',
        baseUrl: modelOrigin + '/anthropic',
        apiFormat: 'anthropic-messages',
        apiKey: 'fictional-expert-model-key',
        enabled: true,
        models: [{ name: 'fixture-model', enabled: true }],
      },
    })
    const memberAccount = await api('accounts', { username: 'member', password: 'password', email: '' })
    const home = join(await memberSpacePath(root, 'member'), 'home')
    await writeFile(
      overlay,
      JSON.stringify([
        { insert: [{ id: 'expert-observer', name: runtime.container ? '/dsh-phalanx/home/expert-observer.mjs' : join(home, 'expert-observer.mjs') }] },
      ]),
    )
    await mkdir(home, { recursive: true })
    for (const name of ['skill-observer.mjs', 'expert-observer.mjs']) await copyFile(`tests/fixtures/${name}`, join(home, name))

    for (const name of ['expert-research', 'expert-writing', 'shared-reference']) {
      const files = [
        { path: 'SKILL.md', content: `---\nname: ${name}\ndescription: ${name}\n---\nUse ${name}.` },
        ...(name === 'expert-research'
          ? [
              {
                path: 'bin/expert-cli',
                content: '#!/usr/bin/env node\nconsole.log(process.env.EXPERT_SECRET ? "EXPERT_EXECUTION_OK" : "MISSING_CREDENTIAL")\n',
              },
              { path: 'scripts/expert.js', content: 'console.log(process.env.EXPERT_SECRET ? "EXPERT_SCRIPT_OK" : "MISSING_CREDENTIAL")\n' },
            ]
          : []),
      ]
      const response = await admin.request.post(origin + '/admin/api/skills/upload', {
        headers: { origin, 'content-type': 'application/zip' },
        data: skillZip(files),
      })
      expect(response.status()).toBe(200)
      const preview = await response.json()
      await api('skills/change', { action: 'confirm', token: preview.token, revision: preview.revision })
    }
    const packs = await api('skill-packs')
    await api('skill-packs', {
      action: 'save',
      revision: packs.revision,
      pack: { name: 'marketing', description: 'Marketing workflow', skills: ['expert-writing'], instructions: 'Start with expert-writing.', published: false },
    })
    const skillGrantPath = `groups/${memberAccount.groupId}/skills`,
      grant = await api(skillGrantPath)
    await api(skillGrantPath, { action: 'save', names: ['shared-reference'], revision: grant.revision, confirmed: true })
    await api('skills/execution?name=expert-research', {
      enabled: true,
      commands: [
        { command: 'expert-cli', blocked: [] },
        { command: 'scripts/expert.js', blocked: [] },
      ],
      variables: [{ name: 'EXPERT_SECRET', value: secret, secret: true }],
    })
    await expect.poll(async () => (await api('skills/execution?name=expert-research')).preparation?.stage, { timeout: 120000 }).toBe('ready')
    const member = await browser.newPage({ locale: 'en' })
    member.setDefaultTimeout(30000)
    await signInCommunity(member, origin, 'member', 'password')
    const rpc = createBrowserDshRpc(member.context()),
      cookie = await cookieHeader(member.context(), origin)
    const roster = () => rpc.remoteRpc<{ presets: { id: string; name?: string; broken?: string }[] }>(origin, cookie, 'agentPresets/list', {})
    // hidden in 0.1.32: preserve isolated runtime coverage through administrator APIs.
    await api('experts', {
      revision: (await api('experts')).revision,
      expert: {
        name: 'Commerce expert',
        description: 'Marketing workflow',
        icon: '',
        persona: 'EXPERT_MARKETING_PERSONA',
        skills: ['expert-research', 'shared-reference'],
        skillPacks: ['marketing'],
      },
    })
    const library = await api('experts'),
      expert = library.experts[0],
      preset = `phalanx-expert-${expert.id}`
    expect(expert).toMatchObject({ published: false, revision: 1 })
    expect((await roster()).presets.some(row => row.id === preset)).toBe(false)
    const groupPath = `groups/${memberAccount.groupId}/experts`
    expect((await api(groupPath)).experts[0].granted).toBe(false)
    const groups = await api('groups'),
      admins = groups.find((row: { kind: string }) => row.kind === 'admin')
    expect((await api(`groups/${admins.id}/experts`)).experts[0].granted).toBe(false)
    await api(groupPath, { names: [expert.id], revision: (await api(groupPath)).revision, confirmed: true })
    await expect.poll(async () => (await api(groupPath)).experts[0].granted).toBe(true)
    expect((await roster()).presets.some(row => row.id === preset)).toBe(false)
    expect((await member.request.post(origin + '/recovery/restart', { headers: { origin }, data: { confirmed: true } })).status()).toBe(200)
    expect((await roster()).presets.find(row => row.id === preset)).toMatchObject({ name: 'Commerce expert' })
    expect((await roster()).presets.find(row => row.id === preset)?.broken).toBeUndefined()
    const session = async (agentPreset?: string) =>
      (
        await rpc.remoteRpc<{ sessionId: string }>(origin, cookie, 'session/create', {
          request: {
            cwd: runtime.container ? '/dsh-phalanx/workspace' : join(await memberSpacePath(root, 'member'), 'workspace'),
            ...(agentPreset ? { agentPreset } : {}),
          },
        })
      ).sessionId
    const expertSession = await session(preset),
      standardSession = await session()
    const skills = async (sessionId: string) =>
      (await rpc.remoteRpc<{ skills: { name: string }[] }>(origin, cookie, 'skills/list', { request: { sessionId } })).skills.map(row => row.name)
    const expertSkills = await skills(expertSession),
      standardSkills = await skills(standardSession)
    for (const name of ['expert-research', 'expert-writing', 'marketing', 'shared-reference']) expect(expertSkills).toContain(name)
    expect(expertSkills.filter(name => name === 'shared-reference')).toHaveLength(1)
    expect(standardSkills).toContain('shared-reference')
    for (const name of ['expert-research', 'expert-writing', 'marketing']) expect(standardSkills).not.toContain(name)
    for (const [sessionId, marker] of [
      [expertSession, 'EXPERT_PERSONA_TASK'],
      [standardSession, 'STANDARD_PERSONA_TASK'],
    ]) {
      await rpc.remoteRpc(origin, cookie, 'session/prompt', {
        request: { requestId: randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text: marker }] },
      })
      await expect.poll(() => captured.has(marker!), { timeout: 30000 }).toBe(true)
    }
    expect(captured.get('EXPERT_PERSONA_TASK')!.system).toContain('EXPERT_MARKETING_PERSONA')
    expect(captured.get('EXPERT_PERSONA_TASK')!.system).toContain('You are a coding agent powered by')
    expect(captured.get('EXPERT_PERSONA_TASK')!.system).toContain('GLOBAL_PLATFORM_GUIDE')
    expect(captured.get('STANDARD_PERSONA_TASK')!.system).not.toContain('EXPERT_MARKETING_PERSONA')
    expect(captured.get('EXPERT_PERSONA_TASK')!.tools).toEqual(expect.arrayContaining(['bash', 'read', 'write', 'glob', 'grep', 'subagent']))
    const tool = await member.request.post(communityEntryUrl(origin, cookie) + 'skills-fixture', {
      headers: { origin },
      data: {
        operation: 'tool',
        sessionId: expertSession,
        name: 'bash',
        args: { command: 'expert-cli', description: 'Run expert delegated command', timeoutMs: 20000 },
      },
    })
    expect(tool.status(), await tool.text()).toBe(200)
    const execution = (await tool.json()).value
    expect(execution.stdout.text, JSON.stringify({ exitCode: execution.exitCode, stderr: execution.stderr })).toContain('EXPERT_EXECUTION_OK')
    await rpc.remoteRpc(origin, cookie, 'session/prompt', {
      request: { requestId: randomUUID(), sessionId: expertSession, mode: 'queue', content: [{ type: 'text', text: 'DELEGATE_EXPERT_TASK' }] },
    })
    await expect.poll(() => captured.has('CHILD_EXPERT_TASK'), { timeout: 30000 }).toBe(true)
    expect(captured.get('CHILD_EXPERT_TASK')!.system).toContain('EXPERT_MARKETING_PERSONA')
    expect(captured.get('CHILD_EXPERT_TASK')!.tools).toEqual(expect.arrayContaining(['bash', 'read', 'write']))
    expect(captured.get('CHILD_EXPERT_TASK')!.context).toContain('expert-research')
    expect(captured.get('CHILD_EXPERT_TASK')!.context).toContain('expert-writing')
    expect(credentialExposed).toBe(false)
    await expect
      .poll(async () => (await api('experts')).experts.flatMap((row: { checking?: readonly string[] }) => row.checking ?? []), { timeout: 30000 })
      .toEqual([])
    expect((await api('experts')).experts[0].failures).toEqual([])
    // hidden in 0.1.32: expert editor locale/mobile assertions are paused; definition remains persisted.
    expect((await api('experts')).experts[0].persona).toBe('EXPERT_MARKETING_PERSONA')
    const definition = await member.request.post(communityEntryUrl(origin, cookie) + 'skills-fixture', {
      headers: { origin },
      data: { operation: 'get', sessionId: expertSession, name: 'expert-research' },
    })
    const skillPath = (await definition.json()).resourceBase.path
    const scripted = await member.request.post(communityEntryUrl(origin, cookie) + 'skills-fixture', {
      headers: { origin },
      data: {
        operation: 'tool',
        sessionId: expertSession,
        name: 'bash',
        args: { command: `node '${skillPath}/scripts/expert.js'`, description: 'Run delegated expert script', timeoutMs: 20000 },
      },
    })
    expect(scripted.status(), await scripted.text()).toBe(200)
    const scriptResult = (await scripted.json()).value
    expect(scriptResult.stdout.text, scriptResult.stderr.text).toContain('EXPERT_SCRIPT_OK')
    // A damaged protected artifact must never publish a partially copied skill.
    const writing = (await api('skills')).find((skill: { name: string }) => skill.name === 'expert-writing')
    const damaged = new FileSkillArtifacts(join(root, 'skills/artifacts'), []).directory(writing.hash)
    await chmod(damaged, 0o700)
    await symlink('SKILL.md', join(damaged, 'incomplete-link'))
    for (let start = 0; start < 2; start++) {
      expect((await member.request.post(origin + '/recovery/restart', { headers: { origin }, data: { confirmed: true } })).status()).toBe(200)
      expect((await roster()).presets.find(row => row.id === preset)?.broken).toBeUndefined()
      const surviving = await skills(await session(preset))
      expect(surviving).toContain('expert-research')
      expect(surviving).not.toContain('expert-writing')
      await expect
        .poll(async () => (await api('experts')).experts.flatMap((row: { checking?: readonly string[] }) => row.checking ?? []), { timeout: 30000 })
        .toEqual([])
      expect((await api('experts')).experts[0].failures).toContainEqual({ username: 'member', entries: ['skill:expert-writing'] })
    }
  } catch (error) {
    primaryFailure = error
  } finally {
    const attempt = async (action: () => Promise<unknown>) => {
      try {
        await action()
        return true
      } catch (error) {
        cleanupErrors.push(error)
        return false
      }
    }
    await attempt(() => browser.close())
    const stopped = await attempt(() => app.stop()),
      rebuilt = await attempt(() => new CommunityRuntimeDriver(runtime).rebuild())
    if (stopped && rebuilt) {
      const artifacts = new FileSkillArtifacts(join(root, 'skills/artifacts'), [])
      await attempt(() => new FileSkillDistribution(join(root, 'skills/members'), artifacts).synchronize([]))
      await attempt(() => artifacts.collect([]))
      await attempt(() => new FileExecutionArtifacts(join(root, 'execution/artifacts')).collect([]))
      await attempt(() => removeCommunityFixture(root))
    }
    model.closeAllConnections()
    await attempt(() => new Promise<void>(resolve => model.close(() => resolve())))
  }
  if (cleanupErrors.length) throw new AggregateError(primaryFailure ? [primaryFailure, ...cleanupErrors] : cleanupErrors, 'Expert acceptance cleanup failed')
  if (primaryFailure) throw primaryFailure
}, 360000)
