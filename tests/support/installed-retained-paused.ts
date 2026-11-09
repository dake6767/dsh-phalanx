import { randomUUID } from 'node:crypto'
import type { CommunityContributionsView, CommunityExpertGroup, CommunityExpertLibrary, CommunityExpertMarket } from '../../src/domain/admin-contract.js'
import { expect } from 'vitest'
import { skillZip } from '../fixtures/skills/archive.js'
import { retainedContributionSnapshot } from './installed-retained-contributions.js'
import { installedShellArgument } from './installed-storage-layout.js'
import { cookieHeader, createBrowserDshRpc } from './real-dsh-rpc.js'
import { instanceWorkspacePath } from './real-dsh-runtime.js'

type Api = Parameters<typeof retainedContributionSnapshot>[0]
type Remote = (command: string, timeout?: number) => Promise<string>
const podman = 'sudo -u dsh-phalanx env XDG_RUNTIME_DIR=/run/user/$(id -u dsh-phalanx) podman'

async function snapshot(api: Api) {
  const market = async () => {
    const response = await api.member.request.get(api.origin + '/market/api/experts')
    expect(response.status()).toBe(200)
    return (await response.json()) as CommunityExpertMarket
  }
  await expect
    .poll(
      async () => {
        const state = await market()
        return state.pending || state.experts.some(row => row.checking)
      },
      { timeout: 300000 },
    )
    .toBe(false)
  const experts = (await api.get<CommunityExpertLibrary>('experts')).experts
  expect(experts).toHaveLength(2)
  for (const expert of experts) {
    expect(expert.missing).toEqual([])
    expect(expert.failures).toEqual([])
    expect(expert.checking ?? []).toEqual([])
  }
  const selections = (await market()).experts
  expect(selections.map(row => row.status).sort()).toEqual(['granted', 'summoned'])
  const contributions = await api.get<CommunityContributionsView>('contributions')
  expect(contributions.contributions).toHaveLength(1)
  expect(contributions.contributions[0]).toMatchObject({ name: 'retained-contribution', status: 'pending', contributor: { username: 'member' } })
  return { experts, grants: await api.get<CommunityExpertGroup>(`groups/${api.groupId}/experts`), selections, contributions }
}

export type PausedUpgradeState = Awaited<ReturnType<typeof snapshot>>

async function executeExperts(api: Api, before: PausedUpgradeState, phase: string, expertReplies: Record<string, boolean>) {
  const rpc = createBrowserDshRpc(api.member.context()),
    cookie = await cookieHeader(api.member.context(), api.origin)
  const roster = await rpc.remoteRpc<{ presets: { id: string; broken?: string }[] }>(api.origin, cookie, 'agentPresets/list', {})
  for (const expert of before.experts) {
    const preset = 'phalanx-expert-' + expert.id
    expect(roster.presets.find(row => row.id === preset)).toEqual(expect.objectContaining({ id: preset }))
    expect(roster.presets.find(row => row.id === preset)?.broken).toBeUndefined()
    const start = await api.member.request.post(api.origin + '/market/api/experts', {
      headers: { origin: api.origin },
      data: { name: expert.id, action: 'start' },
    })
    expect(start.status()).toBe(200)
    expect(await start.json()).toMatchObject({ agentPreset: preset })
    const { sessionId } = await rpc.remoteRpc<{ sessionId: string }>(api.origin, cookie, 'session/create', {
      request: { cwd: instanceWorkspacePath('', true), agentPreset: preset },
    })
    const marker = 'RETAINED_EXPERT_' + phase + '_' + randomUUID()
    await rpc.remoteRpc(api.origin, cookie, 'session/prompt', {
      request: { requestId: randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text: marker }] },
    })
    await expect.poll(() => expertReplies[marker], { timeout: 300000 }).toBe(true)
    await expect
      .poll(
        async () =>
          (await rpc.remoteRpc<{ items: { sessionId: string; running: boolean }[] }>(api.origin, cookie, 'session/list', { _request: {} })).items.find(
            row => row.sessionId === sessionId,
          )?.running,
        { timeout: 300000 },
      )
      .toBe(false)
  }
}

/** Seed both grant and summon ownership, plus an actual member ZIP submission, before upgrading. */
export async function seedPausedUpgradeState(input: Api & { remote: Remote; expertReplies: Record<string, boolean> }) {
  const { remote, expertReplies } = input
  for (const name of ['Retained granted expert', 'Retained summoned expert']) {
    expect(
      (
        await input.post('experts', {
          revision: (await input.get<CommunityExpertLibrary>('experts')).revision,
          expert: {
            name,
            description: 'Retained upgrade expert',
            icon: '',
            persona: 'Keep this expert through upgrades.',
            skills: ['retained-skill'],
            skillPacks: [],
            mcp: [],
          },
        })
      ).status(),
    ).toBe(200)
  }
  const library = await input.get<CommunityExpertLibrary>('experts')
  const granted = library.experts.find(row => row.name === 'Retained granted expert')!,
    summoned = library.experts.find(row => row.name === 'Retained summoned expert')!
  const path = `groups/${input.groupId}/experts`,
    grants = await input.get<CommunityExpertGroup>(path)
  expect((await input.post(path, { names: [granted.id], revision: grants.revision, confirmed: true })).status()).toBe(200)
  expect(
    (
      await input.post('experts', {
        action: 'publish',
        id: summoned.id,
        published: true,
        revision: (await input.get<CommunityExpertLibrary>('experts')).revision,
        confirmed: true,
      })
    ).status(),
  ).toBe(200)
  expect(
    (
      await input.member.request.post(input.origin + '/market/api/experts', {
        headers: { origin: input.origin },
        data: { name: summoned.id, action: 'summon' },
      })
    ).status(),
  ).toBe(200)
  expect((await input.member.request.post(input.origin + '/recovery/restart', { headers: { origin: input.origin }, data: { confirmed: true } })).status()).toBe(
    200,
  )
  const containers = (await remote(podman + " ps --filter label=dsh-phalanx.user=member --format '{{.ID}}'")).trim().split(/\s+/u)
  expect(containers).toHaveLength(1)
  expect(containers[0]).toMatch(/^[a-f0-9]{12,64}$/u)
  const archive = skillZip([
    { path: 'SKILL.md', content: '---\nname: retained-contribution\ndescription: Retained member contribution\n---\nKeep this contribution through upgrades.' },
  ]).toString('base64')
  // The member token stays inside its owning container and is never returned to the harness.
  const program = `const response = await fetch(new URL('/contributions?action=submit', process.env.DSH_PHALANX_MODEL_GATEWAY_URL), {method:'POST',headers:{'x-api-key':process.env.DSH_PHALANX_MODEL_GATEWAY_ACCESS_TOKEN,'content-type':'application/zip','x-contribution-declaration':Buffer.from(JSON.stringify({purpose:'Retain existing member contribution'})).toString('base64url')},body:Buffer.from('${archive}','base64')}); console.log(response.status); if(response.status !== 200) process.exitCode=1;`
  expect((await remote(podman + ' exec ' + containers[0] + ' node --input-type=module -e ' + installedShellArgument(program))).trim()).toBe('200')
  const before = await snapshot(input)
  await executeExperts(input, before, 'before', expertReplies)
  return before
}

/** No writes or re-seeding: compare the original IDs and definitions, then run each existing preset. */
export async function assertPausedUpgradeState(input: Api & { before: PausedUpgradeState; phase: string; expertReplies: Record<string, boolean> }) {
  expect(await snapshot(input)).toEqual(input.before)
  await executeExperts(input, input.before, input.phase, input.expertReplies)
}
