import type { NativePluginInstallTransport, NativeServiceSettingsTransport } from '../ports/member-native-plugins.js'
import { DSH_BUNDLE_INSTALL } from '../dsh/plugin-manager-protocol.js'
import { dshCookieHeader, launchExchangeCookies } from '../dsh/launch-token.js'
import { rpcRequestBody, rpcResponseValue } from '../dsh/session-protocol.js'
import {
  NATIVE_INSTALL_PROOF_HEADER,
  NATIVE_INSTALL_SIGNATURE_HEADER,
  NATIVE_PLATFORM_INSTALL_PATH,
  NATIVE_PLATFORM_SETTINGS_PATH,
  NATIVE_PLATFORM_SETTINGS_METHOD,
  type NativePlatformActionPath,
} from '../dsh/native-plugin-install.js'
import { dshPluginRequest } from './dsh-plugin-rpc.js'
import { NativeInstallAuthority } from './native-install-authority.js'

/** The captured launch is the only signing target; this capability is never exposed to a member gateway. */
export class SignedNativeInstallTransport implements NativePluginInstallTransport, NativeServiceSettingsTransport {
  constructor(private readonly authority: NativeInstallAuthority) {}
  async install(...[instance, origin, input, signal]: Parameters<NativePluginInstallTransport['install']>): Promise<unknown> {
    return await this.invoke(
      instance,
      origin,
      NATIVE_PLATFORM_INSTALL_PATH,
      DSH_BUNDLE_INSTALL,
      {
        spec: input.spec,
        options: { registry: input.registry, requestId: input.requestId },
        ...(input.replacement ? { replacement: input.replacement } : {}),
        ...(input.cache ? { cache: input.cache } : {}),
      },
      signal,
    )
  }
  async syncSettings(...[instance, origin, input, signal]: Parameters<NativeServiceSettingsTransport['syncSettings']>) {
    const result = await this.invoke<Awaited<ReturnType<NativeServiceSettingsTransport['syncSettings']>>>(
      instance,
      origin,
      NATIVE_PLATFORM_SETTINGS_PATH,
      NATIVE_PLATFORM_SETTINGS_METHOD,
      input,
      signal,
    )
    const fingerprint = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
    if (
      input.phase === 'preview' &&
      result?.status === 'prepared' &&
      fingerprint(result.fingerprint) &&
      (result.observed === null || fingerprint(result.observed)) &&
      ((typeof result.revision === 'string' && result.revision.length > 0 && result.revision.length <= 256) ||
        (typeof result.revision === 'number' && Number.isSafeInteger(result.revision) && result.revision >= 0))
    )
      return { status: result.status, fingerprint: result.fingerprint, observed: result.observed, revision: result.revision } as const
    if (result?.status === 'applied' && fingerprint(result.fingerprint) && typeof result.refresh === 'boolean')
      return { status: result.status, fingerprint: result.fingerprint, refresh: result.refresh } as const
    if (result?.status === 'conflict' || result?.status === 'unsupported') return { status: result.status } as const
    return { status: 'failed' } as const
  }
  private async invoke<T>(
    instance: Parameters<NativePluginInstallTransport['install']>[0],
    origin: URL,
    path: NativePlatformActionPath,
    method: string,
    args: object,
    signal: AbortSignal,
  ): Promise<T> {
    const exchange = await dshPluginRequest(new URL(instance.launchUrl), { host: origin.host }, signal)
    const cookies = launchExchangeCookies(exchange.status, exchange.cookies)
    const body = rpcRequestBody('platform-plugin-operation', method, args)
    const authorization = this.authority.authorize(instance, body, path)
    const result = await dshPluginRequest(
      new URL(path, instance.origin),
      {
        host: origin.host,
        origin: origin.origin,
        cookie: dshCookieHeader(cookies),
        'content-type': 'application/json',
        [NATIVE_INSTALL_PROOF_HEADER]: authorization.proof,
        [NATIVE_INSTALL_SIGNATURE_HEADER]: authorization.signature,
      },
      signal,
      body,
    )
    if (result.status !== 200) throw new Error('Platform plugin operation unavailable')
    return rpcResponseValue(result.body, method)
  }
}
