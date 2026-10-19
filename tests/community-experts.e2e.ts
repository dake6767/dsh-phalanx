// Validation: T2; real credentials: none; actual DSH through installed candidate CLI on Linux.
import type { CommunityRuntimeConfig } from '../src/domain/community-config.js'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { candidateApplication } from './support/candidate-application.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { assertPinnedDshRevision, runtimeSection } from './support/real-dsh-runtime.js'
import { createBrowserDshRpc, cookieHeader } from './support/real-dsh-rpc.js'
import { communityEntryUrl } from './support/community-space.js'
import { hasToolResult, latestHumanText, streamText, streamToolCall } from './support/real-dsh-model.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import { FileSkillArtifacts } from '../src/adapters/skill-artifacts.js'
import { FileSkillDistribution } from '../src/adapters/skill-distribution.js'
import { FileExecutionArtifacts } from '../src/adapters/execution-artifacts.js'
import { signInCommunity } from './fixtures/community-native-browser.js'
import { skillZip } from './fixtures/skills/archive.js'

it('creates and grants a skill expert with isolated skills, base tools, appended persona and delegated execution', async () => {
  assertPinnedDshRevision(runtimeSettings)
  const root = await realpath(await mkdtemp(join(tmpdir(), 'community-experts-'))), secret = randomUUID()
  const captured = new Map<string, { tools: string[], system: string, context: string }>()
  let credentialExposed = false
  const model = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk
    credentialExposed ||= text.includes(secret)
    const body = JSON.parse(text), human = latestHumanText(body), marker = human.includes('CHILD_EXPERT_TASK') ? 'CHILD_EXPERT_TASK' : human
    if (body.tools?.length) captured.set(marker, { context: text, tools: body.tools.map((tool: { name: string }) => tool.name), system: typeof body.system === 'string' ? body.system : (body.system ?? []).map((part: { text: string }) => part.text ?? '').join('\n') })
    response.setHeader('content-type', 'text/event-stream')
    if (marker === 'DELEGATE_EXPERT_TASK' && !hasToolResult(body, 'expert-delegate', false)) {
      streamToolCall(response, 'expert-delegate', 'subagent', { description: 'Check inherited expert capability', prompt: 'CHILD_EXPERT_TASK' }); return
    }
    streamText(response, 'EXPERT_READY')
  })
  model.listen(0, '127.0.0.1'); await once(model, 'listening')
  const modelOrigin = `http://127.0.0.1:${(model.address() as { port: number }).port}`
  const runtime: CommunityRuntimeConfig = runtimeSection(root, modelOrigin, runtimeSettings)
  const home = join(root, 'users/member/home')
  const overlay = join(root, 'expert-test-overlay.json')
  await writeFile(overlay, JSON.stringify([{ id: 'tools', config: { mode: 'native' } }, { insert: [{ id: 'expert-observer', name: runtime.container ? '/dsh-phalanx/home/expert-observer.mjs' : join(home, 'expert-observer.mjs') }] }]))
  const app = candidateApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'expert-acceptance-fixture-session-secret', runtime: { ...runtime, patches: [...(runtime.patches ?? []), overlay] } })
  const browser = await chromium.launch({ headless: true })
  let primaryFailure: unknown
  const cleanupErrors: unknown[] = []
  try {
    const origin = await app.start(), admin = await browser.newPage({ locale: 'en' }); admin.setDefaultTimeout(30000)
    await admin.goto(`${origin}/bootstrap#credential=${readBootstrapCredential(root)!.credential}`)
    await admin.getByLabel('Username', { exact: true }).fill('admin'); await admin.getByLabel('Password', { exact: true }).fill('password')
    await admin.getByRole('button', { name: 'Create administrator', exact: true }).click(); await admin.waitForURL(origin + '/admin')
    const api = async (path: string, input?: object) => {
      const response = input ? await admin.request.post(origin + '/admin/api/' + path, { headers: { origin }, data: input }) : await admin.request.get(origin + '/admin/api/' + path)
      expect(response.status(), await response.text()).toBeLessThan(300); return response.json()
    }
    const models = await api('models')
    await api('models', { revision: models.revision, action: 'save-provider', provider: { name: 'Fixture', baseUrl: modelOrigin + '/anthropic', apiFormat: 'anthropic-messages', apiKey: 'fictional-expert-model-key', enabled: true, models: [{ name: 'fixture-model', enabled: true }] } })
    const memberAccount = await api('accounts', { username: 'member', password: 'password', email: '' })
    await mkdir(home, { recursive: true })
    for (const name of ['skill-observer.mjs', 'expert-observer.mjs']) await copyFile(`tests/fixtures/${name}`, join(home, name))

    for (const name of ['expert-research', 'expert-writing', 'shared-reference']) {
      const files = [{ path: 'SKILL.md', content: `---\nname: ${name}\ndescription: ${name}\n---\nUse ${name}.` }, ...(name === 'expert-research' ? [{ path: 'bin/expert-cli', content: '#!/usr/bin/env node\nconsole.log(process.env.EXPERT_SECRET ? "EXPERT_EXECUTION_OK" : "MISSING_CREDENTIAL")\n' }, { path: 'scripts/expert.js', content: 'console.log(process.env.EXPERT_SECRET ? "EXPERT_SCRIPT_OK" : "MISSING_CREDENTIAL")\n' }] : [])]
      const response = await admin.request.post(origin + '/admin/api/skills/upload', { headers: { origin, 'content-type': 'application/zip' }, data: skillZip(files) })
      expect(response.status()).toBe(200); const preview = await response.json()
      await api('skills/change', { action: 'confirm', token: preview.token, revision: preview.revision })
    }
    const packs = await api('skill-packs')
    await api('skill-packs', { action: 'save', revision: packs.revision, pack: { name: 'marketing', description: 'Marketing workflow', skills: ['expert-writing'], instructions: 'Start with expert-writing.', published: false } })
    const skillGrantPath = `groups/${memberAccount.groupId}/skills`, grant = await api(skillGrantPath)
    await api(skillGrantPath, { action: 'save', names: ['shared-reference'], revision: grant.revision, confirmed: true })
    await api('skills/execution?name=expert-research', { enabled: true, commands: [{ command: 'expert-cli', blocked: [] }, { command: 'scripts/expert.js', blocked: [] }], variables: [{ name: 'EXPERT_SECRET', value: secret, secret: true }] })
    await expect.poll(async () => (await api('skills/execution?name=expert-research')).preparation?.stage, { timeout: 120000 }).toBe('ready')
    const member = await browser.newPage({ locale: 'en' }); member.setDefaultTimeout(30000)
    await signInCommunity(member, origin, 'member', 'password')
    const rpc = createBrowserDshRpc(member.context()), cookie = await cookieHeader(member.context(), origin)
    const roster = () => rpc.remoteRpc<{ presets: { id: string, name?: string, broken?: string }[] }>(origin, cookie, 'agentPresets/list', {})
    await admin.getByRole('link', { name: 'Expert library', exact: true }).click()
    await admin.getByRole('button', { name: 'Create expert', exact: true }).click()
    await admin.getByLabel('Expert name', { exact: true }).fill('Commerce expert')
    await admin.getByLabel('Expert description', { exact: true }).fill('Marketing workflow')
    await admin.getByLabel('Expert persona', { exact: true }).fill('EXPERT_MARKETING_PERSONA')
    await admin.getByRole('dialog').getByText('expert-research', { exact: true }).first().click()
    await admin.getByRole('dialog').getByText('shared-reference', { exact: true }).first().click()
    await admin.getByRole('dialog').getByText('marketing', { exact: true }).first().click()
    await admin.getByRole('button', { name: 'Save expert', exact: true }).click()
    await admin.getByRole('button', { name: 'Edit expert Commerce expert', exact: true }).waitFor()
    const library = await api('experts'), expert = library.experts[0], preset = `phalanx-expert-${expert.id}`
    expect(expert).toMatchObject({ published: false, revision: 1 })
    expect((await roster()).presets.some(row => row.id === preset)).toBe(false)
    const groupPath = `groups/${memberAccount.groupId}/experts`
    expect((await api(groupPath)).experts[0].granted).toBe(false)
    const groups = await api('groups'), admins = groups.find((row: { kind: string }) => row.kind === 'admin')
    expect((await api(`groups/${admins.id}/experts`)).experts[0].granted).toBe(true)
    await admin.getByRole('link', { name: 'Group management', exact: true }).click()
    await admin.getByRole('row').filter({ hasText: 'Ordinary group' }).getByRole('button', { name: 'Details', exact: true }).click()
    await admin.getByRole('tab', { name: 'Expert grants', exact: true }).click()
    await admin.getByRole('dialog').getByText('Commerce expert', { exact: true }).first().click()
    await admin.getByRole('button', { name: 'Save grants', exact: true }).click()
    await expect.poll(async () => (await api(groupPath)).experts[0].granted).toBe(true)
    expect((await roster()).presets.some(row => row.id === preset)).toBe(false)
    expect((await member.request.post(origin + '/recovery/restart', { headers: { origin }, data: { confirmed: true } })).status()).toBe(200)
    expect((await roster()).presets.find(row => row.id === preset)).toMatchObject({ name: 'Commerce expert' })
    expect((await roster()).presets.find(row => row.id === preset)?.broken).toBeUndefined()
    const session = async (agentPreset?: string) => (await rpc.remoteRpc<{ sessionId: string }>(origin, cookie, 'session/create', { request: { cwd: runtime.container ? '/dsh-phalanx/workspace' : join(root, 'users/member/workspace'), ...(agentPreset ? { agentPreset } : {}) } })).sessionId
    const expertSession = await session(preset), standardSession = await session()
    const skills = async (sessionId: string) => (await rpc.remoteRpc<{ skills: { name: string }[] }>(origin, cookie, 'skills/list', { request: { sessionId } })).skills.map(row => row.name)
    const expertSkills = await skills(expertSession), standardSkills = await skills(standardSession)
    for (const name of ['expert-research', 'expert-writing', 'marketing', 'shared-reference']) expect(expertSkills).toContain(name)
    expect(expertSkills.filter(name => name === 'shared-reference')).toHaveLength(1)
    expect(standardSkills).toContain('shared-reference')
    for (const name of ['expert-research', 'expert-writing', 'marketing']) expect(standardSkills).not.toContain(name)
    for (const [sessionId, marker] of [[expertSession, 'EXPERT_PERSONA_TASK'], [standardSession, 'STANDARD_PERSONA_TASK']]) {
      await rpc.remoteRpc(origin, cookie, 'session/prompt', { request: { requestId: randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text: marker }] } })
      await expect.poll(() => captured.has(marker!), { timeout: 30000 }).toBe(true)
    }
    expect(captured.get('EXPERT_PERSONA_TASK')!.system).toContain('EXPERT_MARKETING_PERSONA')
    expect(captured.get('EXPERT_PERSONA_TASK')!.system).toContain('You are a coding agent powered by')
    expect(captured.get('EXPERT_PERSONA_TASK')!.system).toContain('GLOBAL_PLATFORM_GUIDE')
    expect(captured.get('STANDARD_PERSONA_TASK')!.system).not.toContain('EXPERT_MARKETING_PERSONA')
    expect(captured.get('EXPERT_PERSONA_TASK')!.tools).toEqual(expect.arrayContaining(['bash', 'read', 'write', 'glob', 'grep', 'subagent']))
    const tool = await member.request.post(communityEntryUrl(origin, cookie) + 'skills-fixture', { headers: { origin }, data: { operation: 'tool', sessionId: expertSession, name: 'bash', args: { command: 'expert-cli', description: 'Run expert delegated command', timeoutMs: 20000 } } })
    expect(tool.status(), await tool.text()).toBe(200)
    const execution = (await tool.json()).value
    expect(execution.stdout.text, JSON.stringify({ exitCode: execution.exitCode, stderr: execution.stderr })).toContain('EXPERT_EXECUTION_OK')
    await rpc.remoteRpc(origin, cookie, 'session/prompt', { request: { requestId: randomUUID(), sessionId: expertSession, mode: 'queue', content: [{ type: 'text', text: 'DELEGATE_EXPERT_TASK' }] } })
    await expect.poll(() => captured.has('CHILD_EXPERT_TASK'), { timeout: 30000 }).toBe(true)
    expect(captured.get('CHILD_EXPERT_TASK')!.system).toContain('EXPERT_MARKETING_PERSONA')
    expect(captured.get('CHILD_EXPERT_TASK')!.tools).toEqual(expect.arrayContaining(['bash', 'read', 'write']))
    expect(captured.get('CHILD_EXPERT_TASK')!.context).toContain('expert-research')
    expect(captured.get('CHILD_EXPERT_TASK')!.context).toContain('expert-writing')
    expect(credentialExposed).toBe(false)
    expect((await api('experts')).experts[0].failures).toEqual([])
    await admin.getByRole('button', { name: 'Close group details', exact: true }).first().click()
    await admin.getByRole('link', { name: 'Expert library', exact: true }).click()
    await admin.getByRole('button', { name: /Platform language/ }).click()
    await admin.getByRole('menuitemradio', { name: '简体中文', exact: true }).click()
    await admin.getByRole('button', { name: '编辑专家 Commerce expert', exact: true }).click()
    expect(await admin.getByLabel('人设说明', { exact: true }).inputValue()).toBe('EXPERT_MARKETING_PERSONA')
    await admin.setViewportSize({ width: 390, height: 844 })
    const drawer = admin.getByRole('dialog', { name: '编辑专家', exact: true })
    await expect.poll(() => drawer.evaluate(element => { const rect = element.getBoundingClientRect(); return element.scrollWidth <= element.clientWidth && rect.left >= -1 && rect.right <= innerWidth + 1 })).toBe(true)
    const evidence = process.env.DSH_PHALANX_E2E_EVIDENCE_DIR
    if (evidence) { await mkdir(evidence, { recursive: true }); await admin.screenshot({ path: join(evidence, 'expert-editor-zh-mobile.png') }) }
    await admin.getByRole('button', { name: '关闭专家详情', exact: true }).click()
    const definition = await member.request.post(communityEntryUrl(origin, cookie) + 'skills-fixture', { headers: { origin }, data: { operation: 'get', sessionId: expertSession, name: 'expert-research' } })
    const skillPath = (await definition.json()).resourceBase.path
    const scripted = await member.request.post(communityEntryUrl(origin, cookie) + 'skills-fixture', { headers: { origin }, data: { operation: 'tool', sessionId: expertSession, name: 'bash', args: { command: `node '${skillPath}/scripts/expert.js'`, description: 'Run delegated expert script', timeoutMs: 20000 } } })
    expect(scripted.status(), await scripted.text()).toBe(200)
    const scriptResult = (await scripted.json()).value
    expect(scriptResult.stdout.text, scriptResult.stderr.text).toContain('EXPERT_SCRIPT_OK')

  } catch (error) { primaryFailure = error }
  finally {
    const attempt = async (action: () => Promise<unknown>) => { try { await action(); return true } catch (error) { cleanupErrors.push(error); return false } }
    await attempt(() => browser.close())
    const stopped = await attempt(() => app.stop()), rebuilt = await attempt(() => new CommunityRuntimeDriver(runtime).rebuild())
    if (stopped && rebuilt) {
      const artifacts = new FileSkillArtifacts(join(root, 'skills/artifacts'), [])
      await attempt(() => new FileSkillDistribution(join(root, 'skills/members'), artifacts).synchronize([]))
      await attempt(() => artifacts.collect([]))
      await attempt(() => new FileExecutionArtifacts(join(root, 'execution/artifacts')).collect([]))
      await attempt(() => rm(root, { recursive: true, force: true }))
    }
    model.closeAllConnections(); await attempt(() => new Promise<void>(resolve => model.close(() => resolve())))
  }
  if (cleanupErrors.length) throw new AggregateError(primaryFailure ? [primaryFailure, ...cleanupErrors] : cleanupErrors, 'Expert acceptance cleanup failed')
  if (primaryFailure) throw primaryFailure
}, 360000)
