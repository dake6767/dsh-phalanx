// Validation: T2; real credentials: none; actual Linux rootless DSH. Missing inputs must fail the T2 report gate.
import { setAppCenterVisibility } from './support/app-center-visibility.js'
import { once } from 'node:events'
import { mkdtemp, realpath } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { CommunityRuntimeDriver } from '../src/adapters/community-runtime-driver.js'
import { sendCommunityPrompt, signInCommunity, startCommunitySession } from './fixtures/community-native-browser.js'
import { removeCommunityFixture } from './fixtures/owned-cleanup.js'
import { skillZip, validSkill } from './fixtures/skills/archive.js'
import { candidateApplication } from './support/candidate-application.js'
import { modelAccessToken, openTestAccounts } from './support/community-application.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { streamText } from './support/real-dsh-model.js'
import { assertPinnedDshRevision, runtimeSection } from './support/real-dsh-runtime.js'

it('hides paused entry points while retaining their data and native member reasoning choices', async () => {
  assertPinnedDshRevision(runtimeSettings)
  const root = await realpath(await mkdtemp(join(tmpdir(), 'launch-visibility-')))
  const requests: { tools: { name: string }[]; thinking?: { type: string; budget_tokens?: number } }[] = []
  const model = createServer(async (request, response) => {
    let text = ''
    for await (const chunk of request) text += chunk
    const body = JSON.parse(text)
    if (body.tools?.length) requests.push(body)
    response.setHeader('content-type', 'text/event-stream')
    streamText(response, 'VISIBILITY_READY')
  })
  model.listen(0, '127.0.0.1')
  await once(model, 'listening')
  const runtime = runtimeSection(root, `http://127.0.0.1:${(model.address() as { port: number }).port}`, runtimeSettings)
  const app = candidateApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'launch-visibility-fixture-secret-long', runtime })
  const store = await openTestAccounts(root)
  await store.createFirstAdmin({ username: 'admin', email: '', password: 'password' })
  const account = await store.create({ username: 'member', email: '', password: 'password' })
  await store.close()
  const browser = await chromium.launch({ headless: true })
  try {
    const origin = await app.start(),
      admin = await browser.newPage({ locale: 'en' }),
      member = await browser.newPage({ locale: 'en' })
    admin.setDefaultTimeout(30000)
    member.setDefaultTimeout(30000)
    await signInCommunity(admin, origin, 'admin', 'password', true)
    await setAppCenterVisibility(admin.request, origin)
    const api = async (path: string, data?: object) => {
      const response = data
        ? await admin.request.post(origin + '/admin/api/' + path, { headers: { origin }, data })
        : await admin.request.get(origin + '/admin/api/' + path)
      expect(response.ok(), await response.text()).toBe(true)
      return response.json()
    }
    const provider = {
      name: 'Visibility fixture',
      baseUrl: runtime.defaultModel.upstream.baseUrl + '/anthropic',
      apiFormat: 'anthropic-messages',
      apiKey: 'fictional-visibility-key',
      enabled: true,
      models: [{ name: 'visibility-model', enabled: true, reasoning: true }],
    }
    const settings = await api('models', { revision: (await api('models')).revision, action: 'save-provider', provider })
    const saved = settings.providers[0]
    await api('models', { revision: settings.revision, action: 'set-default', defaultModelId: saved.models[0].id })
    await api('experts', {
      revision: (await api('experts')).revision,
      expert: { name: 'Retained expert', description: 'Retained data', icon: '', persona: 'Keep this expert.', skills: [], skillPacks: [] },
    })
    const experts = await api('experts')
    await signInCommunity(member, origin, 'member', 'password')
    const token = await modelAccessToken(root, 'member', account.spaceId)
    // Installed containers use the private gateway listener for member-token routes.
    const gatewayOrigin = runtimeSettings.containerImage === undefined ? origin : `http://127.0.0.1:${runtimeSettings.containerGatewayPort}`
    const submitted = await admin.request.post(gatewayOrigin + '/contributions?action=submit', {
      headers: {
        'x-api-key': token,
        'x-contribution-declaration': Buffer.from(JSON.stringify({ purpose: 'Retain existing contribution' })).toString('base64url'),
      },
      data: skillZip([{ path: 'SKILL.md', content: validSkill }]),
    })
    expect(submitted.ok(), await submitted.text()).toBe(true)
    const contributions = await api('contributions')
    expect(contributions.contributions).toHaveLength(1)
    await startCommunitySession(member)
    const selector = member.getByRole('button', { name: /current visibility-model(?:,|$)/u })
    await selector.click()
    await member.getByRole('menuitem', { name: /^Effort/u }).click()
    await member.getByRole('menuitemradio', { name: /^Low$/iu }).click()
    await sendCommunityPrompt(member, 'VERIFY_VISIBLE_REASONING')
    await expect.poll(() => requests.length, { timeout: 30000 }).toBeGreaterThan(0)
    expect(requests.at(-1)?.thinking).toMatchObject({ type: 'enabled', budget_tokens: 2048 })
    expect(requests.flatMap(row => row.tools.map(tool => tool.name))).not.toContain('submit_contribution')
    await expect.poll(async () => (await api('usage-models')).items.length).toBeGreaterThan(0)
    const usage = await api('usage-models')
    for (const label of ['Expert library', 'Usage records']) expect(await admin.getByRole('link', { name: label, exact: true }).count()).toBe(0)
    for (const path of ['experts', 'usage-records']) {
      const response = await admin.request.get(origin + '/admin/' + path, { maxRedirects: 0 })
      expect(response.status()).toBe(302)
      expect(response.headers().location).toBe('/admin')
    }
    for (const path of ['skills', 'plugins']) {
      await admin.goto(origin + '/admin/' + path + '?tab=contributions')
      await admin.getByRole('heading', { name: path === 'skills' ? 'Skill library' : 'Plugin library', exact: true }).waitFor()
      expect(await admin.getByRole('tab', { name: 'Member contributions', exact: true }).count()).toBe(0)
      expect(await admin.getByRole('button', { name: 'Review contribution', exact: true }).count()).toBe(0)
    }
    await admin.goto(origin + '/admin/settings?tab=retention')
    await admin.getByRole('heading', { name: 'System settings', exact: true }).waitFor()
    expect(await admin.getByRole('tab', { name: 'Usage record retention', exact: true }).count()).toBe(0)
    expect(await admin.getByLabel('Retention days', { exact: true }).count()).toBe(0)
    await admin.goto(origin + '/admin/accounts')
    await admin.getByRole('button', { name: 'Edit member', exact: true }).click()
    expect(await admin.getByRole('link', { name: 'View usage records', exact: true }).count()).toBe(0)
    await admin.getByRole('button', { name: 'Cancel', exact: true }).click()
    await admin.goto(origin + '/admin/groups')
    await admin.getByRole('row').filter({ hasText: 'Default group' }).getByRole('button', { name: 'Details', exact: true }).click()
    expect(await admin.getByRole('tab', { name: 'Expert grants', exact: true }).count()).toBe(0)
    const state = await api('models')
    await api('models', {
      revision: state.revision,
      action: 'save-provider',
      provider: { ...provider, id: saved.id, models: [{ ...saved.models[0], enabled: true, reasoning: false }] },
    })
    await selector.click()
    await expect.poll(() => member.getByRole('menuitem', { name: /^Effort/u }).count(), { timeout: 30000 }).toBe(0)
    await member.keyboard.press('Escape')
    await member.getByRole('button', { name: 'Platform App Center', exact: true }).click()
    expect(await member.getByRole('tab', { name: 'Experts', exact: true }).count()).toBe(0)
    await member.getByRole('tab', { name: 'Skills', exact: true }).click()
    expect(await member.getByText('My contributions', { exact: true }).count()).toBe(0)
    expect(await member.getByText('Contribute to platform', { exact: true }).count()).toBe(0)
    expect((await api('experts')).experts).toEqual(experts.experts)
    expect(await api('contributions')).toEqual(contributions)
    expect(await api('usage-models')).toEqual(usage)
  } finally {
    await browser.close()
    await app.stop()
    await new CommunityRuntimeDriver(runtime).rebuild()
    model.closeAllConnections()
    await new Promise<void>(resolve => model.close(() => resolve()))
    await removeCommunityFixture(root)
  }
}, 240000)
