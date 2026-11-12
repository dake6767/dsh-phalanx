import { DSH_BUNDLE_LIST, DSH_BUNDLE_REMOVE } from '../dsh/plugin-manager-protocol.js'
import type {
  NativePluginInstallTransport,
  MemberNativePluginManagerPort,
  NativePluginApplication,
  NativePluginInstallPhase,
  NativePluginReplacement,
} from '../ports/member-native-plugins.js'
import type { CommunityRuntimeConfig } from '../domain/community-config.js'
import type { CommunityUserInstance } from '../ports/community-runtime.js'
import { BusinessRuleError } from '../domain/business-error.js'
import { dshPluginRpc } from './dsh-plugin-rpc.js'
import { receiveMemberPluginArchive, retainedMemberPluginArchiveIntegrity, verifyMemberPluginArchive } from './member-plugin-archive.js'

/** Native operations use the official manager; expiring downloads never become profile dependencies. */
export class NativeMemberPluginManager implements MemberNativePluginManagerPort {
  constructor(
    private readonly runtime?: Pick<CommunityRuntimeConfig, 'container'>,
    private readonly installation?: NativePluginInstallTransport,
  ) {}
  async list(instance: CommunityUserInstance, origin: URL, signal: AbortSignal) {
    const rows = (await this.rpc(instance, origin, DSH_BUNDLE_LIST, {}, signal, 10000)) as Array<{
      name?: string
      version?: string
      installed?: boolean
      source?: string
      enabled?: boolean
      removable?: boolean
      error?: unknown
    }>
    if (!Array.isArray(rows)) throw this.failure()
    return rows.flatMap(row => {
      const archiveIntegrity = retainedMemberPluginArchiveIntegrity(row.source)
      return row.installed === true && typeof row.name === 'string'
        ? [
            {
              packageName: row.name,
              ...(typeof row.version === 'string' ? { version: row.version } : {}),
              ...(archiveIntegrity ? { retainedArchive: true as const } : {}),
              ...(archiveIntegrity && row.removable === true && !row.error && typeof row.enabled === 'boolean'
                ? { archiveIntegrity, enabled: row.enabled }
                : {}),
            },
          ]
        : []
    })
  }
  async verifyArchive(instance: CommunityUserInstance, packageName: string, integrity: string, signal: AbortSignal): Promise<boolean> {
    return (
      !!this.runtime?.container &&
      !!instance.containerName &&
      (await verifyMemberPluginArchive(this.runtime.container, instance.containerName, packageName, integrity, signal))
    )
  }
  async replace(
    instance: CommunityUserInstance,
    origin: URL,
    archive: { readonly url: string; readonly integrity: string; readonly authorizationUrl: string },
    replacement: NativePluginReplacement,
    options: { readonly registry: string; readonly requestId: string; readonly progress?: (phase: NativePluginInstallPhase) => void },
    signal: AbortSignal,
  ): Promise<NativePluginApplication> {
    const path = await this.receive(instance, archive, options.progress, signal)
    signal.throwIfAborted()
    options.progress?.('installing')
    // Once dispatched, a signed repeat observes the same native operation after a lost response.
    const input = {
      spec: path,
      registry: options.registry,
      requestId: options.requestId,
      replacement: { ...replacement, authorizationUrl: archive.authorizationUrl },
    }
    let result: unknown
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        result = await this.installation!.install(instance, origin, input, AbortSignal.timeout(660000))
        break
      } catch {
        if (attempt === 1) throw this.replacementFailure('restore-failed', 'native-connection-failed')
      }
    }
    const outcome = result as { replacement?: string; reason?: string; recovery?: string; restartRequired?: boolean } | undefined
    if (outcome?.replacement) throw this.replacementFailure(outcome.replacement, outcome.reason, outcome.recovery, outcome.restartRequired)
    return this.application(result)
  }
  async install(
    instance: CommunityUserInstance,
    origin: URL,
    archive: { readonly url: string; readonly integrity: string },
    options: { readonly registry: string; readonly requestId: string; readonly progress?: (phase: NativePluginInstallPhase) => void },
    signal: AbortSignal,
  ): Promise<NativePluginApplication> {
    const path = await this.receive(instance, archive, options.progress, signal)
    options.progress?.('installing')
    let result: unknown
    try {
      result = await this.installation!.install(
        instance,
        origin,
        { spec: path, registry: options.registry, requestId: options.requestId },
        AbortSignal.any([signal, AbortSignal.timeout(300000)]),
      )
    } catch {
      signal.throwIfAborted()
      throw this.failure('native-connection-failed')
    }
    return this.application(result)
  }
  async remove(instance: CommunityUserInstance, origin: URL, packageName: string, signal: AbortSignal): Promise<NativePluginApplication> {
    return this.application(await this.rpc(instance, origin, DSH_BUNDLE_REMOVE, { name: packageName }, signal, 120000))
  }
  private async receive(
    instance: CommunityUserInstance,
    archive: { readonly url: string; readonly integrity: string },
    progress: ((phase: NativePluginInstallPhase) => void) | undefined,
    signal: AbortSignal,
  ) {
    if (!this.runtime?.container || !instance.containerName || !this.installation) throw this.failure('runtime-unavailable')
    progress?.('downloading')
    try {
      return await receiveMemberPluginArchive(this.runtime.container, instance.containerName, archive.url, archive.integrity, signal)
    } catch {
      signal.throwIfAborted()
      throw this.failure('download-failed')
    }
  }
  private replacementFailure(outcome: string, reason?: string, recovery?: string, restartRequired?: boolean) {
    const code = outcome === 'changed' ? 'plugin-update-changed' : outcome === 'restored' ? 'plugin-update-restored' : 'plugin-update-restore-failed'
    return new BusinessRuleError('conflict', 'The plugin update could not finish.', code, {
      ...(restartRequired === true ? { restartRequired: true } : {}),
      reason: typeof reason === 'string' && /^[a-z/-]{1,100}$/u.test(reason) ? reason : 'native-state-unavailable',
      ...(typeof recovery === 'string' && /^recovery-[a-zA-Z0-9]{6}$/u.test(recovery) ? { recovery } : {}),
    })
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
