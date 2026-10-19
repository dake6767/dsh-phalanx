import type { ExpertFailure } from '../domain/expert.js'
import type { CommunityUserInstance } from '../ports/community-runtime.js'
import { dshPluginRpc } from './dsh-plugin-rpc.js'

/** Registration/broken state comes from the official preset roster after readiness. */
export async function expertPresetFailures(instance: CommunityUserInstance, origin: URL, expected: readonly { id: string, preset: string }[], signal: AbortSignal): Promise<ExpertFailure[]> {
  if (!expected.length) return []
  try {
    const result = await dshPluginRpc(instance, origin, 'agentPresets/list', {}, AbortSignal.any([signal, AbortSignal.timeout(10000)])) as { presets: { id: string, broken?: string }[] }
    if (!Array.isArray(result.presets)) throw new Error('Expert roster unavailable')
    return expected.flatMap(row => { const preset = result.presets.find(preset => preset.id === row.preset); return !preset || preset.broken ? [{ id: row.id, entries: ['preset'] }] : [] })
  } catch { signal.throwIfAborted(); return expected.map(row => ({ id: row.id, entries: ['preset'] })) }
}
