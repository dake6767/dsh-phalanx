import type { CommunityRuntimeConfig } from '../domain/community-config.js'
import { receiveMemberPluginArchive } from './member-plugin-archive.js'
import { DSH_BUNDLE_LIST, DSH_BUNDLE_INSTALL } from '../dsh/plugin-manager-protocol.js'
import type { MemberPluginManagerPort } from '../ports/plugin-market.js'
import type { CommunityUserInstance } from '../ports/community-runtime.js'
import { BusinessRuleError } from '../domain/business-error.js'
import { dshPluginRpc } from './dsh-plugin-rpc.js'

/** Installs into the member profile using the official native plugin manager. */
export class NativeMemberPluginManager implements MemberPluginManagerPort {
  constructor(private readonly runtime: CommunityRuntimeConfig) {}
  async list(instance: CommunityUserInstance, origin: URL, signal: AbortSignal) {
    const rows = await this.rpc(instance, origin, DSH_BUNDLE_LIST, {}, signal, 10000) as Array<{ name?: string, version?: string, installed?: boolean }>
    if (!Array.isArray(rows)) throw this.failure()
    return rows.flatMap(row => row.installed && typeof row.name === 'string' && typeof row.version === 'string' ? [{ packageName: row.name, version: row.version }] : [])
  }
  async install(instance: CommunityUserInstance, origin: URL, archiveUrl: string, integrity: string, signal: AbortSignal): Promise<'applied' | 'restart-required'> {
    if (!this.runtime.container || !instance.containerName) throw this.failure()
    let path: string
    try { path = await receiveMemberPluginArchive(this.runtime.container, instance.containerName, archiveUrl, integrity, signal) }
    catch { signal.throwIfAborted(); throw this.failure() }
    const result = await this.rpc(instance, origin, DSH_BUNDLE_INSTALL, { spec: path }, signal, 120000) as { application?: string }
    if (result?.application !== 'applied' && result?.application !== 'restart-required') throw this.failure()
    return result.application
  }
  private async rpc(instance: CommunityUserInstance, origin: URL, method: string, args: object, signal: AbortSignal, timeout: number) {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(timeout)])
    try { return await dshPluginRpc(instance, origin, method, args, deadline) }
    catch { signal.throwIfAborted(); throw this.failure() }
  }
  private failure() { return new BusinessRuleError('conflict', 'The plugin could not be installed. Check the native plugin page before retrying.', 'plugin-install-failed') }
}
