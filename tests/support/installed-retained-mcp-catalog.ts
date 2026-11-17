import { createHash } from 'node:crypto'
import type { APIResponse, Page } from 'playwright'
import { expect } from 'vitest'
import type { CommunityMcpCatalogView, CommunityMcpSettings } from '../../src/domain/mcp-admin-contract.js'
import { defaultSuiteCatalogAsset } from '../../src/domain/suite-catalog-source.js'
import { selectCommunityWorkspace, sendCommunityPrompt, startCommunitySession } from '../fixtures/community-native-browser.js'
import type { createRetainedUpgradeUpstream } from './installed-retained-upstream.js'

interface McpUpgradeApi {
  get(path: string): ReturnType<APIResponse['json']>
  post(path: string, body: object, timeout?: number): Promise<APIResponse>
  groupId: string
}

const retainedTrainService = 'p-retained-12306'

/** Compare saved settings independently of the temporary preparation and catalog-availability views. */
export function retainedMcpSettings(row: CommunityMcpSettings) {
  if (row.name !== retainedTrainService) return row
  const { preparation, catalogTargetUnavailable, ...settings } = row
  void preparation
  void catalogTargetUnavailable
  return settings
}

export async function seedRetainedMcpCatalog(api: McpUpgradeApi) {
  const { get, post, groupId } = api
  const name = retainedTrainService
  const service = async () => ((await get('mcp')) as CommunityMcpSettings[]).find(row => row.name === name)
  const observation = (row: CommunityMcpSettings) => ({
    catalog: row.catalog?.status,
    preparation: row.preparation?.stage,
    connection: row.testStatus,
    tools: row.tools.length,
  })
  const discoveries: ReturnType<typeof observation>[] = []
  const retry = async () => {
    expect((await post('mcp/catalog', { action: 'retry', name })).status()).toBe(202)
  }
  const existing = await service()
  if (existing?.catalog?.status === 'failed') {
    discoveries.push(observation(existing))
    await retry()
  }
  if (!existing)
    expect(
      (
        await post('mcp/catalog', { action: 'import', input: { presetId: '12306', name, credential: '', requestId: 'upgrade-retained-train-import' } })
      ).status(),
    ).toBe(202)
  const settled = async () => {
    await expect.poll(async () => (await service())?.catalog?.status, { timeout: 660_000 }).toMatch(/^(ready|failed)$/u)
    const saved = await service()
    if (!saved) throw Error('The retained 12306 service disappeared during preparation')
    return saved
  }
  let saved = await settled()
  discoveries.push(observation(saved))
  if (discoveries.length === 1 && saved.catalog?.status === 'failed' && saved.preparation?.stage === 'ready') {
    // The previous formal release is immutable. Use its ordinary discovery retry on an already prepared service.
    console.log('Retained 12306 discovery failed after preparation', discoveries[0])
    await retry()
    saved = await settled()
    discoveries.push(observation(saved))
  }
  expect(saved, JSON.stringify(discoveries) + '\n' + (saved.preparation?.log ?? '')).toMatchObject({
    catalog: { id: '12306', version: '1', status: 'ready' },
    credentialConfigured: false,
    testStatus: 'passed',
    tools: expect.arrayContaining([expect.objectContaining({ name: 'get-tickets' })]),
  })
  expect((await post('mcp', { action: 'publish', name, published: true, revision: (await get('mcp?publication=' + name)).revision })).status()).toBe(200)
  expect((await post(`groups/${groupId}/mcp`, { names: ['p-managed', name] })).status()).toBe(200)
  return { name, version: '1', tool: 'get-tickets', granted: true, discoveries }
}

export function signedUpgradeCatalog(input: string | undefined) {
  const match = /^(catalog-[1-9]\d*)@([a-f0-9]{64})$/u.exec(input ?? '')
  if (!match) throw Error('Set DSH_PHALANX_UPGRADE_SIGNED_CATALOG to the verified catalog release tag and SHA-256 (<tag>@<sha256>)')
  const tag = match[1]!
  const sha256 = match[2]!
  const address = defaultSuiteCatalogAsset.replace('/latest/download/', `/download/${tag}/`)
  return { tag, sha256, address }
}

export async function assertRetainedMcpCatalog(
  api: McpUpgradeApi,
  serveCatalog: (bytes: Uint8Array) => void,
  release: ReturnType<typeof signedUpgradeCatalog>,
) {
  const { get, post } = api
  const name = retainedTrainService
  const response = await fetch(release.address, { signal: AbortSignal.timeout(30_000) })
  expect(response.status).toBe(200)
  const bytes = Buffer.from(await response.arrayBuffer())
  const catalogSha256 = createHash('sha256').update(bytes).digest('hex')
  expect(catalogSha256).toBe(release.sha256)
  // The installed candidate verifies the official signature before displaying these entries.
  serveCatalog(bytes)
  const catalog: CommunityMcpCatalogView = await get('mcp/catalog')
  expect(catalog).toMatchObject({
    source: { status: 'ok' },
    entries: expect.arrayContaining([
      expect.objectContaining({
        id: '12306',
        version: '1.0.0',
        contentHash: '0386c85acb35b746c963d2cb7ba03a9de9d6ed599c3df346e5663852115f5b1e',
        imported: 1,
      }),
      expect.objectContaining({
        id: 'amap',
        version: '1.0.0',
        contentHash: '527d030925697992b284f52de65622eb2a190e729242475a0f2f3913d11bd6c6',
      }),
    ]),
  })
  const tested = await post('mcp/test', { name }, 120_000)
  expect(tested.status()).toBe(200)
  const retained = ((await get('mcp')) as CommunityMcpSettings[]).find(row => row.name === name)
  expect(retained).toMatchObject({
    catalog: { id: '12306', version: '1', status: 'ready' },
    published: true,
    credentialConfigured: false,
    testStatus: 'passed',
    tools: expect.arrayContaining([expect.objectContaining({ name: 'get-tickets' })]),
  })
  expect(retained?.catalogTargetUnavailable).toBeUndefined()
  expect(retained?.availableCatalogVersion).toBeUndefined()
  return { name, version: '1', tool: 'get-tickets', catalogAddress: release.address, catalogTag: release.tag, catalogSha256 }
}

/** Exercise the member's credential-backed service and verify the granted tools visible to DSH. */
export async function retainedMcpPrompt(input: {
  member: Page
  origin: string
  workspace: string
  marker: string
  calls: Awaited<ReturnType<typeof createRetainedUpgradeUpstream>>['calls']
  expectTrains: boolean
}) {
  const { member, origin, workspace, marker, calls, expectTrains } = input
  await selectCommunityWorkspace(member.context(), member, origin, workspace, true)
  // Native creation records workspace membership; RPC cwd alone leaves a session ungrouped.
  const sessionId = await startCommunitySession(member)
  await sendCommunityPrompt(member, marker)
  await expect
    .poll(
      () => {
        const call = calls[marker]
        if (!call || !expectTrains) return call
        const trainToolPrefix = `mcp__${retainedTrainService}__`
        expect(call.tools).toContain(trainToolPrefix + 'get-tickets')
        return { ...call, tools: call.tools.filter(name => !name.startsWith(trainToolPrefix)) }
      },
      { timeout: 300000 },
    )
    .toEqual({ failed: false, valid: true, tools: ['mcp__p-managed__echo', 'mcp__p-selected__echo'] })
  await member
    .locator(`[data-conversation-content][data-conversation-session=${JSON.stringify(sessionId)}]:visible`)
    .getByText('UPGRADE_QUERY_DONE', { exact: true })
    .waitFor()
  return sessionId
}
