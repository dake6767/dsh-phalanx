import { DSH_EXPERT_PRESETS_LIST, unavailableExpertPresets } from '../dsh/expert-preset.js'
import type { ExpertFailure } from '../domain/expert.js'
import type { CommunityUserInstance } from '../ports/community-runtime.js'
import { dshPluginRpc, dshPluginRequest } from './dsh-plugin-rpc.js'
import { EXPERT_PLUGIN_STATUS_PATH } from '../dsh/expert-plugins.js'
import { launchExchangeCookies, dshCookieHeader } from '../dsh/launch-token.js'

/** Registration/broken state comes from the official preset roster after readiness. */
export async function expertPresetFailures(instance: CommunityUserInstance, origin: URL, expected: readonly { id: string, preset: string }[], signal: AbortSignal): Promise<ExpertFailure[]> {
  if (!expected.length) return []
  try {
    const result = await dshPluginRpc(instance, origin, DSH_EXPERT_PRESETS_LIST, {}, AbortSignal.any([signal, AbortSignal.timeout(10000)]))
    const unavailable = new Set(unavailableExpertPresets(result, expected.map(row => row.preset)))
    const failures = expected.filter(row => unavailable.has(row.preset)).map(row => ({ id: row.id, entries: ['preset'] }))
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(10000)])
    const exchange = await dshPluginRequest(new URL(instance.launchUrl), { host: origin.host }, deadline)
    const cookie = dshCookieHeader(launchExchangeCookies(exchange.status, exchange.cookies))
    const response = await dshPluginRequest(new URL(EXPERT_PLUGIN_STATUS_PATH, instance.origin), { host: origin.host, origin: origin.origin, cookie }, deadline)
    const rows: unknown = JSON.parse(response.body)
    if (response.status !== 200 || !Array.isArray(rows)) throw Error('Expert plugin status unavailable')
    for (const row of rows) {
      if (!row || typeof row.id !== 'string' || !expected.some(item => item.id === row.id) || !Array.isArray(row.entries) || row.entries.some((entry: unknown) => typeof entry !== 'string' || !entry.startsWith('plugin:') && !entry.startsWith('mcp:'))) throw Error('Invalid expert plugin status')
      if (row.entries.length) failures.push({ id: row.id, entries: row.entries })
    }
    return [...new Set(failures.map(row => row.id))].map(id => ({ id, entries: [...new Set(failures.filter(row => row.id === id).flatMap(row => row.entries))].sort() }))
  } catch { signal.throwIfAborted(); return expected.map(row => ({ id: row.id, entries: ['preset'] })) }
}
