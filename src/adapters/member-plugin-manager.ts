import { DSH_BUNDLE_LIST, DSH_BUNDLE_INSTALL, DSH_BUNDLE_REMOVE } from '../dsh/plugin-manager-protocol.js'
import type { MemberNativePluginManagerPort, NativePluginApplication, NativePluginInstallPhase } from '../ports/member-native-plugins.js'
import type { CommunityRuntimeConfig } from '../domain/community-config.js'
import type { CommunityUserInstance } from '../ports/community-runtime.js'
import { BusinessRuleError } from '../domain/business-error.js'
import { dshPluginRpc } from './dsh-plugin-rpc.js'
import { receiveMemberPluginArchive, isRetainedMemberPluginArchive } from './member-plugin-archive.js'

/** Native operations use the official manager; expiring downloads never become profile dependencies. */
export class NativeMemberPluginManager implements MemberNativePluginManagerPort {
  constructor(private readonly runtime?: Pick<CommunityRuntimeConfig, 'container'>) {}
  async list(instance: CommunityUserInstance, origin: URL, signal: AbortSignal) {
    const rows = (await this.rpc(instance, origin, DSH_BUNDLE_LIST, {}, signal, 10000)) as Array<{
      name?: string
      version?: string
      installed?: boolean
      source?: string
    }>
    if (!Array.isArray(rows)) throw this.failure()
    return rows.flatMap(row =>
      row.installed === true && typeof row.name === 'string'
        ? [
            {
              packageName: row.name,
              ...(typeof row.version === 'string' ? { version: row.version } : {}),
              ...(isRetainedMemberPluginArchive(row.source) ? { retainedArchive: true as const } : {}),
            },
          ]
        : [],
    )
  }
  async install(
    instance: CommunityUserInstance,
    origin: URL,
    archive: { readonly url: string; readonly integrity: string },
    options: { readonly registry: string; readonly requestId: string; readonly progress?: (phase: NativePluginInstallPhase) => void },
    signal: AbortSignal,
  ): Promise<NativePluginApplication> {
    if (!this.runtime?.container || !instance.containerName) throw this.failure('runtime-unavailable')
    options.progress?.('downloading')
    let path: string
    try {
      path = await receiveMemberPluginArchive(this.runtime.container, instance.containerName, archive.url, archive.integrity, signal)
    } catch {
      signal.throwIfAborted()
      throw this.failure('download-failed')
    }
    options.progress?.('installing')
    const result = await this.rpc(
      instance,
      origin,
      DSH_BUNDLE_INSTALL,
      { spec: path, options: { registry: options.registry, requestId: options.requestId } },
      signal,
      300000,
    )
    return this.application(result)
  }
  async remove(instance: CommunityUserInstance, origin: URL, packageName: string, signal: AbortSignal): Promise<NativePluginApplication> {
    return this.application(await this.rpc(instance, origin, DSH_BUNDLE_REMOVE, { name: packageName }, signal, 120000))
  }
  private application(value: unknown): NativePluginApplication {
    const result = value as { application?: string; packageResult?: { kind?: string }; error?: { code?: string } } | null
    if (result?.application === 'applied' || result?.application === 'restart-required') return result.application
    const reason = result?.packageResult?.kind ?? result?.error?.code
    throw this.failure(typeof reason === 'string' && /^[a-z][a-z0-9-]{0,79}$/u.test(reason) ? reason : 'native-operation-failed')
  }
  private async rpc(instance: CommunityUserInstance, origin: URL, method: string, args: object, signal: AbortSignal, timeout: number) {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(timeout)])
    try {
      return await dshPluginRpc(instance, origin, method, args, deadline)
    } catch {
      signal.throwIfAborted()
      throw this.failure('native-connection-failed')
    }
  }
  private failure(reason = 'native-operation-failed') {
    return new BusinessRuleError(
      'conflict',
      `The native plugin operation failed (${reason}). Check the native plugin page before retrying.`,
      'plugin-install-failed',
      { reason },
    )
  }
}
