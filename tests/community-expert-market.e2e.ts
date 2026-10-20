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
import { openNativeSettings, signInCommunity } from './fixtures/community-native-browser.js'
import { skillZip } from './fixtures/skills/archive.js'

it('publishes and summons experts with restart snapshots, immediate withdrawal and independent acquisition sources', async () => {
  assertPinnedDshRevision(runtimeSettings)
  const root = await realpath(await mkdtemp(join(tmpdir(), 'community-expert-market-'))), secret = randomUUID()
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
    await admin.getByLabel('Example tasks (optional, 2–3 lines)', { exact: true }).fill('Plan a launch\nReview a campaign')
    await admin.getByRole('dialog').getByText('expert-research', { exact: true }).first().click()
    await admin.getByRole('button', { name: 'Save expert', exact: true }).click()
    await admin.getByRole('button', { name: 'Publish expert Commerce expert', exact: true }).waitFor()
    const created = await api('experts')
    expect((await admin.request.post(origin + '/admin/api/experts', { headers: { origin }, data: { action: 'publish', id: created.experts[0].id, published: true, revision: created.revision } })).status()).toBe(400)
    expect((await member.request.post(origin + '/admin/api/experts', { headers: { origin }, data: { action: 'publish', id: created.experts[0].id, published: true, revision: created.revision, confirmed: true } })).status()).toBe(403)
    const first = created.experts[0], preset = `phalanx-expert-${first.id}`
    await member.getByRole('button', { name: 'Platform App Center', exact: true }).click()
    await member.getByRole('tab', { name: 'Experts', exact: true }).click()
    await member.getByText('No experts yet', { exact: true }).waitFor()
    await admin.getByText('Members granted this expert can use all its entries and platform credentials, including entries not granted separately.', { exact: true }).waitFor()
    await admin.getByRole('button', { name: 'Publish expert Commerce expert', exact: true }).click()
    await admin.getByRole('button', { name: 'Unpublish expert Commerce expert', exact: true }).waitFor()
    await member.getByRole('button', { name: 'Reload experts', exact: true }).click()
    await member.getByText('Plan a launch', { exact: true }).waitFor()
    await member.getByText('Summoning gives you access to all expert entries and platform credentials throughout your instance, including entries not granted separately.', { exact: true }).waitFor()
    const market = () => member.request.get(origin + '/market/api/experts').then(response => response.json())
    expect(JSON.stringify(await market())).not.toContain('EXPERT_MARKETING_PERSONA')
    expect((await member.request.post(origin + '/market/api/experts', { headers: { origin }, data: { action: 'summon', name: first.id, extra: true } })).status()).toBe(400)
    expect((await member.request.post(origin + '/market/api/experts', { headers: { origin: 'https://wrong.invalid' }, data: { action: 'summon', name: first.id } })).status()).toBe(403)
    await member.getByRole('button', { name: 'Summon expert', exact: true }).click()
    await member.getByRole('button', { name: 'Dismiss expert', exact: true }).waitFor()
    expect((await market()).pending).toBe(true)
    await member.getByRole('region', { name: 'Experts', exact: true }).getByRole('link', { name: 'Restart DSH instance', exact: true }).waitFor()
    expect((await roster()).presets.some(row => row.id === preset)).toBe(false)
    const restart = async () => expect((await member.request.post(origin + '/recovery/restart', { headers: { origin }, data: { confirmed: true } })).status()).toBe(200)
    await restart()
    expect((await roster()).presets.find(row => row.id === preset)).toMatchObject({ name: 'Commerce expert' })
    expect((await market()).pending).toBe(false)
    const session = async (agentPreset: string) => (await rpc.remoteRpc<{ sessionId: string }>(origin, cookie, 'session/create', { request: { cwd: runtime.container ? '/dsh-phalanx/workspace' : join(root, 'users/member/workspace'), agentPreset } })).sessionId
    const activate = async (preset: string, marker: string) => {
      const id = await session(preset)
      await rpc.remoteRpc(origin, cookie, 'session/prompt', { request: { requestId: randomUUID(), sessionId: id, mode: 'queue', content: [{ type: 'text', text: marker }] } })
      await expect.poll(() => captured.has(marker), { timeout: 30000 }).toBe(true)
      return id
    }
    const expertSession = await activate(preset, 'FIRST_SUMMONED')
    const execution = async (sessionId: string, command = 'sh ./retained-expert-cli') => {
      const response = await member.request.post(communityEntryUrl(origin, cookie) + 'skills-fixture', { headers: { origin }, data: { operation: 'tool', sessionId, name: 'bash', args: { command, description: 'Run expert delegated command', timeoutMs: 20000 } } })
      expect(response.status(), await response.text()).toBe(200); return JSON.stringify(await response.json())
    }
    expect(await execution(expertSession, 'cp "$(command -v expert-cli)" ./retained-expert-cli')).toContain('"exitCode":0')
    expect(await execution(expertSession)).toContain('EXPERT_EXECUTION_OK')
    await member.reload(); await member.getByRole('button', { name: 'Platform App Center', exact: true }).click(); await member.getByRole('tab', { name: 'Experts', exact: true }).click()
    await member.getByRole('button', { name: 'Dismiss expert', exact: true }).click()
    await member.getByRole('button', { name: 'Summon expert', exact: true }).waitFor()
    expect(await execution(expertSession)).toContain('DSH_PHALANX_EXECUTION[unauthorized]')
    expect((await roster()).presets.some(row => row.id === preset)).toBe(true)
    await restart(); expect((await roster()).presets.some(row => row.id === preset)).toBe(false)
    const select = async (id: string) => expect((await member.request.post(origin + '/market/api/experts', { headers: { origin }, data: { action: 'summon', name: id } })).status()).toBe(200)
    const publish = async (id: string, published: boolean) => api('experts', { action: 'publish', id, published, revision: (await api('experts')).revision, confirmed: true })
    await select(first.id)
    const library = await api('experts')
    await api('experts', { revision: library.revision, expert: { name: 'Writer expert', description: 'Writing', icon: 'W', persona: 'WRITER_PERSONA', skills: ['expert-research'], skillPacks: [] } })
    const second = (await api('experts')).experts.find((row: { id: string }) => row.id !== first.id), secondPreset = `phalanx-expert-${second.id}`
    await publish(second.id, true); await select(second.id); await restart()
    for (const id of [preset, secondPreset]) expect((await roster()).presets.some(row => row.id === id)).toBe(true)
    const retainedSession = await activate(secondPreset, 'SECOND_SUMMONED')
    await publish(first.id, false)
    expect(await execution(retainedSession)).toContain('EXPERT_EXECUTION_OK')
    await publish(first.id, true)
    expect((await market()).experts.find((row: { id: string }) => row.id === first.id).status).toBe('available')
    const groupPath = `groups/${memberAccount.groupId}/experts`
    await api(groupPath, { names: [first.id], revision: (await api(groupPath)).revision, confirmed: true })
    await member.reload(); await member.getByRole('button', { name: 'Platform App Center', exact: true }).click(); await member.getByRole('tab', { name: 'Experts', exact: true }).click()
    expect(await member.getByRole('button', { name: 'Owned expert', exact: true }).isDisabled()).toBe(true)
    expect((await member.request.post(origin + '/market/api/experts', { headers: { origin }, data: { action: 'dismiss', name: first.id } })).status()).toBe(403)
    await api(groupPath, { names: [], revision: (await api(groupPath)).revision, confirmed: true })
    await publish(second.id, false)
    expect(await execution(retainedSession)).toContain('DSH_PHALANX_EXECUTION[unauthorized]')
    await api(skillGrantPath, { action: 'save', names: ['shared-reference', 'expert-research'], revision: (await api(skillGrantPath)).revision, confirmed: true })
    expect(await execution(retainedSession)).toContain('EXPERT_EXECUTION_OK')
    // Deleting the sole expert source withdraws an already activated execution gateway immediately.
    await api(skillGrantPath, { action: 'save', names: ['shared-reference'], revision: (await api(skillGrantPath)).revision, confirmed: true })
    await publish(second.id, true); await select(second.id); await restart()
    const deletingSession = await activate(secondPreset, 'DELETING_EXPERT_SOURCE')
    expect(await execution(deletingSession, 'cp "$(command -v expert-cli)" ./delete-retained-expert-cli')).toContain('"exitCode":0')
    expect(await execution(deletingSession, 'sh ./delete-retained-expert-cli')).toContain('EXPERT_EXECUTION_OK')
    const deletion = await api('experts?impact=' + second.id)
    await api('experts', { action: 'remove', id: second.id, revision: deletion.revision, confirmed: true })
    expect(await execution(deletingSession, 'sh ./delete-retained-expert-cli')).toContain('DSH_PHALANX_EXECUTION[unauthorized]')
    expect((await market()).experts.some((row: { id: string }) => row.id === second.id)).toBe(false)
    await restart(); expect((await roster()).presets.some(row => row.id === secondPreset)).toBe(false)
    expect(credentialExposed).toBe(false)
    await member.reload()
    await member.getByRole('button', { name: 'Platform App Center', exact: true }).click(); await member.getByRole('tab', { name: 'Experts', exact: true }).click()
    await openNativeSettings(member)
    await member.getByRole('button', { name: 'English', exact: true }).click()
    await member.getByRole('menuitem', { name: '中文', exact: true }).click(); await member.keyboard.press('Escape')
    await member.getByRole('tab', { name: '专家', exact: true }).click()
    await member.getByRole('button', { name: '重新加载专家', exact: true }).click()
    await member.getByRole('button', { name: '召唤专家', exact: true }).waitFor()
    await expect.poll(() => member.getByRole('heading', { name: 'Writer expert', exact: true }).count()).toBe(0)
    await member.getByText('召唤后即可在整个实例中使用专家的全部条目及平台凭据，包括未单独授权给你的条目。', { exact: true }).waitFor()
    await member.getByRole('button', { name: '收起侧边栏', exact: true }).click()
    await member.setViewportSize({ width: 390, height: 844 })
    await expect.poll(() => member.getByRole('region', { name: 'Platform apps', exact: true }).count()).toBe(0)
    const panel = member.getByRole('tabpanel')
    await expect.poll(() => panel.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(0)
    await member.getByRole('heading', { name: 'Commerce expert', exact: true }).scrollIntoViewIfNeeded()
    const evidence = process.env.DSH_PHALANX_E2E_EVIDENCE_DIR
    if (evidence) { await mkdir(evidence, { recursive: true }); await member.screenshot({ path: join(evidence, 'expert-market-zh-mobile.png') }) }
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
