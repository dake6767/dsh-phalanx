import type { NativePluginInstallTransport } from '../ports/member-native-plugins.js'
import { DSH_BUNDLE_INSTALL } from '../dsh/plugin-manager-protocol.js'
import { dshCookieHeader, launchExchangeCookies } from '../dsh/launch-token.js'
import { rpcRequestBody, rpcResponseValue } from '../dsh/session-protocol.js'
import { NATIVE_INSTALL_PROOF_HEADER, NATIVE_INSTALL_SIGNATURE_HEADER, NATIVE_PLATFORM_INSTALL_PATH } from '../dsh/native-plugin-install.js'
import { dshPluginRequest } from './dsh-plugin-rpc.js'
import { NativeInstallAuthority } from './native-install-authority.js'

/** The captured launch is the only signing target; this capability is never exposed to a member gateway. */
export class SignedNativeInstallTransport implements NativePluginInstallTransport {
  constructor(private readonly authority: NativeInstallAuthority) {}
  async install(...[instance, origin, input, signal]: Parameters<NativePluginInstallTransport['install']>): Promise<unknown> {
    const exchange = await dshPluginRequest(new URL(instance.launchUrl), { host: origin.host }, signal)
    const cookies = launchExchangeCookies(exchange.status, exchange.cookies)
    const body = rpcRequestBody('platform-plugin-operation', DSH_BUNDLE_INSTALL, {
      spec: input.spec,
      options: { registry: input.registry, requestId: input.requestId },
      ...(input.replacement ? { replacement: input.replacement } : {}),
    })
    const authorization = this.authority.authorize(instance, body)
    const result = await dshPluginRequest(
      new URL(NATIVE_PLATFORM_INSTALL_PATH, instance.origin),
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
    if (result.status !== 200) throw new Error('Platform plugin installation unavailable')
    return rpcResponseValue(result.body, DSH_BUNDLE_INSTALL)
  }
}
