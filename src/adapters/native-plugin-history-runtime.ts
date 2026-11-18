import type { CommunityRuntimePort, CommunityUserInstance } from '../ports/community-runtime.js'
import type { NativePluginHistoryRuntime } from '../ports/native-plugin-history.js'
import { DSH_BUNDLE_LIST, nativeOptionalBundles } from '../dsh/plugin-manager-protocol.js'
import { dshPluginRpc } from './dsh-plugin-rpc.js'

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
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(10_000)])
    try {
      return nativeOptionalBundles(await dshPluginRpc(instance, this.publicOrigin(), DSH_BUNDLE_LIST, {}, deadline))
    } catch (error) {
      deadline.throwIfAborted()
      throw error
    }
  }
}
