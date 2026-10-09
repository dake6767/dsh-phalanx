import { DSH_BUNDLE_LIST } from '../dsh/plugin-manager-protocol.js'
import type { MemberPluginManagerPort } from '../ports/plugin-market.js'
import type { CommunityUserInstance } from '../ports/community-runtime.js'
import { BusinessRuleError } from '../domain/business-error.js'
import { dshPluginRpc } from './dsh-plugin-rpc.js'

/** Observes native member copies through the official plugin manager. */
export class NativeMemberPluginManager implements MemberPluginManagerPort {
  async list(instance: CommunityUserInstance, origin: URL, signal: AbortSignal) {
    const rows = await this.rpc(instance, origin, DSH_BUNDLE_LIST, {}, signal, 10000) as Array<{ name?: string, version?: string, installed?: boolean }>
    if (!Array.isArray(rows)) throw this.failure()
    return rows.flatMap(row => row.installed && typeof row.name === 'string' && typeof row.version === 'string' ? [{ packageName: row.name, version: row.version }] : [])
  }
  private async rpc(instance: CommunityUserInstance, origin: URL, method: string, args: object, signal: AbortSignal, timeout: number) {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(timeout)])
    try { return await dshPluginRpc(instance, origin, method, args, deadline) }
    catch { signal.throwIfAborted(); throw this.failure() }
  }
  private failure() { return new BusinessRuleError('conflict', 'The plugin could not be installed. Check the native plugin page before retrying.', 'plugin-install-failed') }
}
