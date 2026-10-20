// Validation: T2; real credentials: none; installed platform with actual rootless DSH skill loads.
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser } from 'playwright'
import { expect, it } from 'vitest'
import { candidateApplication } from './support/candidate-application.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { assertPinnedDshRevision, runtimeSection, defaultWorkspacePath, instanceWorkspacePath } from './support/real-dsh-runtime.js'
import { cookieHeader, createBrowserDshRpc } from './support/real-dsh-rpc.js'
import { streamText } from './support/real-dsh-model.js'
import { communityEntryUrl } from './support/community-space.js'
import { signInCommunity } from './fixtures/community-native-browser.js'
import { skillZip } from './fixtures/skills/archive.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import { FileSkillArtifacts } from '../src/adapters/skill-artifacts.js'
import { FileSkillDistribution } from '../src/adapters/skill-distribution.js'
import type { CommunityApplication } from '../src/ports/community-application.js'

it('reports platform skill loads without counting personal overrides or interrupting sessions when reporting fails', async () => {
  assertPinnedDshRevision(runtimeSettings)
  const longName = 'reported-' + 'a'.repeat(120)
  const root = await mkdtemp(join(tmpdir(), 'usage-skills-'))
  const model = createServer((request, response) => { request.resume(); response.setHeader('content-type', 'text/event-stream'); streamText(response, 'SKILL_SESSION_READY') })
  model.listen(0, '127.0.0.1'); await once(model, 'listening')
  const modelOrigin = `http://127.0.0.1:${(model.address() as { port: number }).port}`
  const runtime = runtimeSection(join(root, 'platform'), modelOrigin, runtimeSettings), container = 'container' in runtime
  const home = join(runtime.dataRoot, 'users/member/home'), overlay = join(root, 'observer.json')
  await writeFile(overlay, JSON.stringify([{ insert: [{ id: 'reported-skills-observer', name: container ? '/dsh-phalanx/home/observer.mjs' : join(home, 'observer.mjs') }] }]))
  runtime.patches.push(overlay)
  let app: CommunityApplication | undefined, browser: Browser | undefined, failure: unknown
  const cleanup = async () => {
    const errors: unknown[] = [], artifacts = new FileSkillArtifacts(join(runtime.dataRoot, 'skills/artifacts'), [])
    for (const action of [() => browser?.close(), () => app?.stop(), () => new CommunityRuntimeDriver(runtime).rebuild(),
      () => new FileSkillDistribution(join(runtime.dataRoot, 'skills/members'), artifacts).synchronize([]), () => artifacts.collect([]),
      async () => { model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve())) }, () => rm(root, { recursive: true, force: true })]) {
      try { await action() } catch (error) { errors.push(error) }
    }
    if (errors.length) throw new AggregateError(failure === undefined ? errors : [failure, ...errors], 'Skill report fixture cleanup failed')
  }
  try {
    app = candidateApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'reported-skills-acceptance-fixture-secret', runtime })
    browser = await chromium.launch({ headless: true })
    const origin = await app.start(), admin = await browser.newPage({ locale: 'en' }); admin.setDefaultTimeout(30000)
    if (process.env.DSH_PHALANX_E2E_CPU_THROTTLE) await (await admin.context().newCDPSession(admin)).send('Emulation.setCPUThrottlingRate', { rate: 4 })
    expect((await admin.request.post(origin + '/bootstrap', { headers: { origin }, form: { credential: readBootstrapCredential(runtime.dataRoot)!.credential, username: 'admin', password: 'password' }, maxRedirects: 0 })).status()).toBe(303)
    const api = async (path: string, data?: object) => {
      const response = data ? await admin.request.post(origin + '/admin/api/' + path, { headers: { origin }, data }) : await admin.request.get(origin + '/admin/api/' + path)
      expect(response.ok(), await response.text()).toBe(true); return response.json()
    }
    await api('models', { revision: (await api('models')).revision, action: 'save-provider', provider: { name: 'Skill fixture', baseUrl: modelOrigin + '/anthropic', apiFormat: 'anthropic-messages', apiKey: 'fictional-skill-model-key', enabled: true, models: [{ name: 'fixture', enabled: true }] } })
    const account = await api('accounts', { username: 'member', password: 'password', email: '' })
    await mkdir(home, { recursive: true, mode: 0o700 }); await copyFile('tests/fixtures/skill-observer.mjs', join(home, 'observer.mjs'))
    const upload = async (name: string) => {
      const response = await admin.request.post(origin + '/admin/api/skills/upload', { headers: { origin, 'content-type': 'application/zip' }, data: skillZip([{ path: 'SKILL.md', content: `---\nname: ${name}\ndescription: ${name}\n---\nPRIVATE_SKILL_CONTENT` }]) })
      expect(response.ok(), await response.text()).toBe(true); const preview = await response.json()
      await api('skills/change', { action: 'confirm', token: preview.token, revision: preview.revision })
    }
    for (const name of [longName, 'reported-selected', 'reported-expert', 'reported-unheld']) await upload(name)
    const groupPath = `groups/${account.groupId}/skills`
    await api(groupPath, { action: 'save', names: [longName], revision: (await api(groupPath)).revision, confirmed: true })
    const selected = await api('skills/detail?name=reported-selected')
    await api('skills/change', { action: 'publish', name: selected.name, published: true, revision: selected.revision })
    await api('experts', { revision: (await api('experts')).revision, expert: { name: 'Reporting expert', description: 'Skill reporting', icon: 'R', persona: 'Use the supplied skill.', skills: ['reported-expert'], skillPacks: [] } })
    const expert = (await api('experts')).experts[0], expertPath = `groups/${account.groupId}/experts`
    await api(expertPath, { names: [expert.id], revision: (await api(expertPath)).revision, confirmed: true })
    const member = await browser.newPage({ locale: 'en' }); member.setDefaultTimeout(30000)
    await signInCommunity(member, origin, 'member', 'password')
    expect((await member.request.post(origin + '/market/api/skills', { headers: { origin }, data: { name: 'reported-selected', action: 'install' } })).ok()).toBe(true)
    const cookie = await cookieHeader(member.context(), origin), rpc = createBrowserDshRpc(member.context())
    const session = async (agentPreset?: string) => (await rpc.remoteRpc<{ sessionId: string }>(origin, cookie, 'session/create', { request: { cwd: instanceWorkspacePath(defaultWorkspacePath(runtime.dataRoot, 'member'), container), ...(agentPreset ? { agentPreset } : {}) } })).sessionId
    const observe = async (data: object) => {
      const response = await member.request.post(communityEntryUrl(origin, cookie) + 'skills-fixture', { headers: { origin }, data })
      expect(response.ok(), await response.text()).toBe(true); return response.json()
    }
    const load = async (sessionId: string, name: string) => observe({ operation: 'tool', sessionId, name: 'skill', args: { name } })
    const first = await session()
    expect(await load(first, longName)).toMatchObject({ isError: false, value: { name: longName, provider: 'phalanx-skills' } })
    expect(await load(first, 'reported-selected')).toMatchObject({ isError: false, value: { name: 'reported-selected', provider: 'phalanx-skills' } })
    expect(await load(await session(`phalanx-expert-${expert.id}`), 'reported-expert')).toMatchObject({ isError: false, value: { name: 'reported-expert', provider: `phalanx-expert-${expert.id}` } })
    const totals = async () => (await api('usage-reported')).items as { username: string; skill: string; count: number; day: number }[]
    const counts = async () => Object.fromEntries((await totals()).map(row => [row.skill, row.count]))
    await expect.poll(counts, { timeout: 20000 }).toEqual({ 'reported-expert': 1, [longName]: 1, 'reported-selected': 1 })
    expect(JSON.stringify(await api('usage-reported'))).not.toMatch(/PRIVATE_SKILL_CONTENT|phalanx-expert|provider|Reporting expert/)
    expect(await observe({ operation: 'report', report: { username: 'other', day: 0, provider: 'forged', items: [{ name: 'reported-unheld', count: 100 }, { name: 'nonexistent', count: 100 }] } })).toEqual({ status: 200 })
    expect(await counts()).toEqual({ 'reported-expert': 1, [longName]: 1, 'reported-selected': 1 })
    const owned = join(home, '.agents/skills', longName); await mkdir(owned, { recursive: true })
    await writeFile(join(owned, 'SKILL.md'), `---\nname: ${longName}\ndescription: MEMBER_OVERRIDE\n---\nPrivate member content`)
    const overridden = await session()
    await expect.poll(async () => (await observe({ operation: 'get', sessionId: overridden, name: longName }))?.description).toBe('MEMBER_OVERRIDE')
    expect(await load(overridden, longName)).toMatchObject({ isError: false, value: { provider: 'filesystem' } })
    const original = await observe({ operation: 'inventory' })
    await observe({ operation: 'report-endpoint', mode: 'failure' })
    expect(await load(first, 'reported-selected')).toMatchObject({ isError: false })
    await rpc.remoteRpc(origin, cookie, 'session/prompt', { request: { requestId: randomUUID(), sessionId: first, mode: 'queue', content: [{ type: 'text', text: 'CONTINUE_WITHOUT_REPORTS' }] } })
    await expect.poll(async () => (await observe({ operation: 'events', sessionId: first })).some((event: { type: string; data: { reason?: { kind?: string } } }) => event.type === 'turn/end' && event.data.reason?.kind === 'completed'), { timeout: 30000 }).toBe(true)
    await expect.poll(async () => (await observe({ operation: 'inventory' })).failedReports, { timeout: 20000 }).toBe(1)
    await observe({ operation: 'report-endpoint', mode: 'restore' })
    expect(await load(first, 'reported-selected')).toMatchObject({ isError: false })
    await expect.poll(counts, { timeout: 20000 }).toEqual({ 'reported-expert': 1, [longName]: 1, 'reported-selected': 2 })
    expect(await observe({ operation: 'inventory' })).toMatchObject({ instance: original.instance, failedReports: 1 })
    await admin.goto(origin + '/admin/usage-records')
    await admin.getByRole('tab', { name: 'Self-reported usage', exact: true }).click()
    await admin.getByText('Reported by member instances. The platform cannot verify these counts.', { exact: true }).waitFor()
    const grid = admin.getByRole('grid', { name: 'Self-reported skill loads', exact: true })
    for (const name of [longName, 'reported-selected', 'reported-expert']) await grid.getByText(name, { exact: true }).waitFor()
    await admin.getByText('Plugin-local tools and member-container MCP are excluded. Plugin upstreams and remote or shared MCP retain gateway records.', { exact: true }).waitFor()
  } catch (error) { failure = error; throw error }
  finally { await cleanup() }
}, 300000)
