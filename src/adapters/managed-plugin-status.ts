import type { CommunityUserInstance } from '../ports/community-runtime.js'
import { dshPluginRpc } from './dsh-plugin-rpc.js'
import { DSH_PLUGIN_LIST } from '../dsh/plugin-precheck.js'

/** One deadline covers token exchange and inventory; shutdown owns both requests. */
export async function managedPluginFailures(instance: CommunityUserInstance, origin: URL, prefixes: Readonly<Record<string, string>>, signal: AbortSignal): Promise<string[]> {
  const names = Object.keys(prefixes)
  if (!names.length) return []
  const controller = new AbortController()
  const abort = () => controller.abort(signal.reason)
  signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort()
  const deadline = setTimeout(() => controller.abort(new Error('Plugin inventory timed out')), 10000)
  try {
    const rows = await dshPluginRpc(instance, origin, DSH_PLUGIN_LIST, {}, controller.signal) as Array<{ moduleName?: string, fiberPhase?: string }>
    if (!Array.isArray(rows)) throw new Error('Inventory unavailable')
    return names.filter(name => { const matching = rows.filter(row => row.moduleName?.startsWith(prefixes[name]!)); return !matching.length || matching.some(row => row.fiberPhase !== 'active') })
  } catch { signal.throwIfAborted(); return names }
  finally { clearTimeout(deadline); signal.removeEventListener('abort', abort) }
}
