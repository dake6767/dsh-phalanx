import type { APIResponse, Page } from 'playwright'
import { expect } from 'vitest'
import { signInCommunity } from '../fixtures/community-native-browser.js'
import { skillZip } from '../fixtures/skills/archive.js'
import { retainedExecutionTrial, withAdministratorSkill } from './installed-upgrade-trial.js'
import { installedInstanceAcceptance } from './upgrade-instance-combination.js'

/** Retained configure assertions shared by formal and optional online transports. */
export async function configureRetainedUpgrade(input: {
  admin: Page
  member: Page
  origin: string
  get: (path: string) => ReturnType<APIResponse['json']>
  post: (path: string, data: object, timeout?: number) => Promise<APIResponse>
  instances: ReturnType<typeof installedInstanceAcceptance>
  executionTrialTimeout: number
  trialEvidence: string | undefined
  redact: (text: string) => string
  upstream: string
}) {
  const { admin, member, origin, get, post, instances, executionTrialTimeout, trialEvidence, redact, upstream } = input

  await instances.configureCatalog(upstream + '/catalog.json')
  expect(
    (await admin.request.post(origin + '/login', { headers: { origin }, form: { username: 'admin', password: 'password' }, maxRedirects: 0 })).status(),
  ).toBe(303)
  const settings = await get('models')
  expect(
    (
      await post('models', {
        revision: settings.revision,
        action: 'save-provider',
        provider: {
          name: 'Upgrade fixture',
          baseUrl: upstream + '/anthropic',
          apiFormat: 'anthropic-messages',
          apiKey: 'fictional-model-key',
          enabled: true,
          models: [{ name: 'fixture-model', enabled: true }],
        },
      })
    ).status(),
  ).toBe(200)
  const account = await post('accounts', { username: 'member', password: 'password', email: '' })
  expect(account.status()).toBe(201)
  const { groupId } = await account.json()
  for (const name of ['p-managed', 'p-selected']) {
    expect(
      (
        await post('mcp', {
          action: 'save',
          service: {
            name,
            description: 'Manual retained service',
            url: upstream + '/mcp',
            credential: 'fictional-upgrade-mcp-key',
            headers: [{ name: 'Authorization', value: 'Bearer {credential}' }],
            disabledTools: [],
          },
        })
      ).status(),
    ).toBe(200)
    expect((await (await post('mcp/test', { name })).json()).testStatus).toBe('passed')
    expect((await post('mcp', { action: 'publish', name, published: true })).status()).toBe(200)
  }
  expect((await post(`groups/${groupId}/mcp`, { names: ['p-managed'] })).status()).toBe(200)
  await signInCommunity(member, origin, 'member', 'password')
  expect((await member.request.post(origin + '/market/api/mcp', { headers: { origin }, data: { name: 'p-selected', action: 'enable' } })).status()).toBe(200)
  const memberEntry = new URL(member.url()).pathname
  expect(
    (
      await post('runtime-dependencies', {
        action: 'create',
        input: {
          name: 'retained-tools',
          prepareCommand: 'mkdir bin; printf "#!/bin/sh\\necho retained\\n" > bin/retained; chmod +x bin/retained',
          pathDirectories: ['bin'],
          checkCommand: 'retained',
        },
      })
    ).status(),
  ).toBe(202)
  await expect.poll(async () => (await get('runtime-dependencies?name=retained-tools')).stage, { timeout: 300000 }).toBe('ready')
  const upload = await admin.request.post(origin + '/admin/api/skills/upload', {
    headers: { origin, 'content-type': 'application/zip' },
    data: skillZip([{ path: 'SKILL.md', content: '---\nname: retained-skill\ndescription: Existing manual skill\n---\nKeep this manual skill.' }]),
  })
  expect(upload.status()).toBe(200)
  const preview = await upload.json()
  expect((await post('skills/change', { action: 'confirm', token: preview.token, revision: preview.revision })).status()).toBe(200)
  const detail = await get('skills/detail?name=retained-skill')
  expect(
    (await post('skills/change', { action: 'runtime-dependencies', name: detail.name, names: ['retained-tools'], revision: detail.revision })).status(),
  ).toBe(200)
  expect(
    (
      await post('skills/execution?name=retained-skill', {
        enabled: true,
        commands: [{ command: 'retained', blocked: [] }],
        variables: [],
        runtimeDependencies: ['retained-tools'],
      })
    ).status(),
  ).toBe(200)
  await expect.poll(async () => (await get('skills/execution?name=retained-skill')).preparation?.stage, { timeout: 300000 }).toBe('ready')
  expect((await post('usage-settings', { retentionDays: 13 })).status()).toBe(200)
  const trialApi = { get, post: (path: string, input: object) => post(path, input, executionTrialTimeout) }
  await withAdministratorSkill(trialApi, 'retained-skill', () => retainedExecutionTrial(trialApi, 'baseline', trialEvidence, redact))
  for (const kind of ['managed', 'selected']) {
    const packs = await get('skill-packs')
    expect(
      (
        await post('skill-packs', {
          action: 'save',
          revision: packs.revision,
          pack: {
            name: 'retained-pack-' + kind,
            description: 'Retained workflow',
            skills: ['retained-skill'],
            instructions: 'Keep the existing workflow.',
            published: kind === 'selected',
          },
        })
      ).status(),
    ).toBe(200)
  }
  const grantPath = `groups/${groupId}/skills`,
    grant = await get(grantPath)
  expect(
    (
      await post(grantPath, { action: 'save', names: ['retained-skill'], packs: ['retained-pack-managed'], revision: grant.revision, confirmed: true })
    ).status(),
  ).toBe(200)
  expect(
    (
      await member.request.post(origin + '/market/api/skill-packs', { headers: { origin }, data: { name: 'retained-pack-selected', action: 'install' } })
    ).status(),
  ).toBe(200)
  return { memberEntry, groupId: groupId as string }
}
