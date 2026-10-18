import { createPublicKey, verify } from 'node:crypto'
import { suiteCatalogSignedPayload } from './suite-catalog-document.js'

export interface TrustedSuiteCatalogKey {
  readonly keyId: string
  /** Ed25519 public key in PEM (SPKI) form. */
  readonly publicKey: string
}
export type SuiteCatalogSignatureResult = 'ok' | 'unknown-key' | 'invalid-signature'

/** Verifies the Ed25519 signature over the received document's canonical bytes, before any field is trusted. */
export function verifySuiteCatalogSignature(document: object, trustedKeys: readonly TrustedSuiteCatalogKey[]): SuiteCatalogSignatureResult {
  const raw = document as Record<string, unknown>
  const envelope = raw.signature
  if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) return 'invalid-signature'
  const { keyId, signature: encoded } = envelope as Record<string, unknown>
  if (typeof keyId !== 'string' || typeof encoded !== 'string') return 'invalid-signature'
  const key = trustedKeys.find(row => row.keyId === keyId)
  if (!key) return 'unknown-key'
  let signature: Buffer
  try { signature = Buffer.from(encoded, 'base64') } catch { return 'invalid-signature' }
  if (signature.length !== 64) return 'invalid-signature'
  try {
    if (!verify(null, suiteCatalogSignedPayload(document), createPublicKey(key.publicKey), signature)) return 'invalid-signature'
  } catch { return 'invalid-signature' }
  return 'ok'
}
