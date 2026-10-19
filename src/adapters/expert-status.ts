import { DSH_EXPERT_PRESETS_LIST, unavailableExpertPresets } from '../dsh/expert-preset.js'
import type { ExpertFailure } from '../domain/expert.js'
import type { CommunityUserInstance } from '../ports/community-runtime.js'
import { dshPluginRpc } from './dsh-plugin-rpc.js'

/** Registration/broken state comes from the official preset roster after readiness. */
export async function expertPresetFailures(instance: CommunityUserInstance, origin: URL, expected: readonly { id: string, preset: string }[], signal: AbortSignal): Promise<ExpertFailure[]> {
  if (!expected.length) return []
  try {
    const result = await dshPluginRpc(instance, origin, DSH_EXPERT_PRESETS_LIST, {}, AbortSignal.any([signal, AbortSignal.timeout(10000)]))
    const unavailable = new Set(unavailableExpertPresets(result, expected.map(row => row.preset)))
    return expected.filter(row => unavailable.has(row.preset)).map(row => ({ id: row.id, entries: ['preset'] }))
  } catch { signal.throwIfAborted(); return expected.map(row => ({ id: row.id, entries: ['preset'] })) }
}
