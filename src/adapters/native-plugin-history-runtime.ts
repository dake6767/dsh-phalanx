import type { CommunityRuntimePort, CommunityUserInstance } from '../ports/community-runtime.js'
import type { NativePluginHistoryRuntime } from '../ports/native-plugin-history.js'
import { DSH_BUNDLE_LIST, nativeOptionalBundles } from '../dsh/plugin-manager-protocol.js'
import { dshPluginRpc } from './dsh-plugin-rpc.js'
import { retainedMemberPluginArchiveIntegrity } from './member-plugin-archive.js'

/** History refreshes inspect the current native instance rather than trusting a callback's claims. */
export class NativePluginHistoryRuntimeAdapter implements NativePluginHistoryRuntime {
  constructor(
    private readonly runtime: () => CommunityRuntimePort,
    private readonly publicOrigin: () => URL,
  ) {}
  current(username: string, includeDraining = false) {
    const status = this.runtime().status(username)
    return status.state === 'ready' || (includeDraining && status.state === 'draining') ? status.instance : undefined
  }
  async inspect(instance: CommunityUserInstance, signal: AbortSignal) {
    return (await this.inspectInventory(instance, signal)).optional
  }
  async inspectInventory(instance: CommunityUserInstance, signal: AbortSignal) {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(10_000)])
    try {
      const rows = await dshPluginRpc(instance, this.publicOrigin(), DSH_BUNDLE_LIST, {}, deadline)
      const optional = nativeOptionalBundles(rows)
      const installed = new Map<string, { version?: string; integrity?: string | null }>()
      for (const row of rows as { name?: unknown; installed?: unknown; version?: unknown; source?: unknown }[]) {
        if (typeof row.name !== 'string' || typeof row.installed !== 'boolean') return { optional }
        if (!row.installed) continue
        installed.set(row.name, {
          ...(typeof row.version === 'string' ? { version: row.version } : {}),
          ...(typeof row.source === 'string' ? { integrity: retainedMemberPluginArchiveIntegrity(row.source) ?? null } : {}),
        })
      }
      return { optional, installed }
    } catch (error) {
      deadline.throwIfAborted()
      throw error
    }
  }
}
