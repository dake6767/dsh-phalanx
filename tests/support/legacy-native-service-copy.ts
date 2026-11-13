import { expect } from 'vitest'
import type { PluginInstallationsPort } from '../../src/ports/plugin-installations.js'
import { openCommunityHttpEntry } from './community-http-entry.js'
import { createRealDshRpc } from './real-dsh-rpc.js'

export async function assertLegacyNativeServiceCopy({
  origin,
  nextAccount,
  packageName,
  integrity,
  records,
  entry,
  groupSession,
  preinstall,
  api,
}: {
  origin: string
  nextAccount: { spaceId: string }
  packageName: string
  integrity: string
  records: PluginInstallationsPort
  entry: { cookie: string }
  groupSession: string
  preinstall: (packages: string[]) => Promise<unknown>
  api: (path: string, body: object) => Promise<unknown>
}) {
  const rpc = createRealDshRpc()
  // Keep the installed archive and the enabled same-digest catalog definition.
  // The predecessor's delivery receipt has no service origin.
  const oldReceipt = { packageName, source: 'selected' as const, version: '0.1.3', integrity }
  await records.save(nextAccount.spaceId, oldReceipt)
  const nextCookie = entry.cookie
  const legacyState = {
    settings: { ai: { protocol: 'openai', baseUrl: 'https://personal.example/v1', model: 'legacy-personal-model' } },
    workspace: { openFiles: [], activeFile: '' },
  }
  const legacyLoad = (session: string) => rpc.remoteRpc<{ revision: number; data: object }>(origin, session, 'qiaomuCoverDesign/load', {})
  const saved = await rpc.remoteRpc<{ revision: number }>(origin, nextCookie, 'qiaomuCoverDesign/save', {
    request: { revision: (await legacyLoad(nextCookie)).revision, data: legacyState },
  })
  await preinstall([])
  await api('plugins/publication', { action: 'publish', packageName, published: true, confirmed: true })
  const restartLegacy = await fetch(origin + '/recovery/restart', {
    method: 'POST',
    headers: { cookie: nextCookie, origin, 'content-type': 'application/json' },
    body: JSON.stringify({ confirmed: true }),
  })
  expect(restartLegacy.status).toBe(200)
  const legacy = (await openCommunityHttpEntry(origin, groupSession, 180000)).cookie
  const legacySetup = await fetch(origin + '/market/api/plugins/setup', {
    method: 'POST',
    headers: { cookie: legacy, origin, 'content-type': 'application/json' },
    body: JSON.stringify({ packageName, action: 'retry-settings' }),
  })
  expect(legacySetup.status).toBe(200)
  expect((await legacyLoad(legacy)).data).toEqual(legacyState)
  expect((await legacyLoad(legacy)).revision).toBe(saved.revision)
  expect((await records.get(nextAccount.spaceId)).find(row => row.packageName === packageName)).toEqual(oldReceipt)
  const legacyView = await fetch(origin + '/market/api/plugins/setup', { headers: { cookie: legacy } })
  expect(legacyView.status).toBe(200)
  expect((await legacyView.json()).nativeServices).toBeUndefined()
}
