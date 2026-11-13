import { generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto'
import { nativeInstallProof, NATIVE_INSTALL_LIFETIME_MS, type NativeInstallAuthorization, type NativePlatformActionPath } from '../dsh/native-plugin-install.js'
import type { CommunityUserInstance } from '../ports/community-runtime.js'

/** Only the platform process retains this key; member artifacts receive the public half. */
export class NativeInstallAuthority {
  readonly publicKey: string
  readonly #privateKey: KeyObject
  constructor(
    private readonly now: () => number = Date.now,
    private readonly nonce: () => string = randomUUID,
  ) {
    const pair = generateKeyPairSync('ed25519')
    this.#privateKey = pair.privateKey
    this.publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  }
  authorize(instance: Pick<CommunityUserInstance, 'userId' | 'resourceKey'>, body: string, path?: NativePlatformActionPath): NativeInstallAuthorization {
    if (!instance.userId || !instance.resourceKey) throw new TypeError('A captured member launch is required for platform installation')
    const current = this.now()
    if (!Number.isSafeInteger(current) || current > Number.MAX_SAFE_INTEGER - NATIVE_INSTALL_LIFETIME_MS)
      throw new TypeError('The platform installation clock is unavailable')
    const proof = nativeInstallProof(instance.userId, instance.resourceKey, body, current + NATIVE_INSTALL_LIFETIME_MS, this.nonce(), path)
    return { proof, signature: sign(null, Buffer.from(proof), this.#privateKey).toString('base64url') }
  }
}
