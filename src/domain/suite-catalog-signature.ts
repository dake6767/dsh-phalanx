import { createPublicKey, verify } from 'node:crypto'
import { suiteCatalogAdapters, suiteCatalogSignedPayload, type SuiteCatalogDocument } from './suite-catalog-document.js'

export interface TrustedSuiteCatalogKey {
  readonly keyId: string
  /** Ed25519 public key in PEM (SPKI) form. */
  readonly publicKey: string
}
export type SuiteCatalogSignatureResult = 'ok' | 'unknown-key' | 'invalid-signature'

/** Verifies the Ed25519 signature over the canonical document bytes, before any field is trusted. */
export function verifySuiteCatalogSignature(document: SuiteCatalogDocument, trustedKeys: readonly TrustedSuiteCatalogKey[]): SuiteCatalogSignatureResult {
  const key = trustedKeys.find(row => row.keyId === document.signature.keyId)
  if (!key) return 'unknown-key'
  let signature: Buffer
  try { signature = Buffer.from(document.signature.signature, 'base64') } catch { return 'invalid-signature' }
  if (signature.length !== 64) return 'invalid-signature'
  try {
    if (!verify(null, suiteCatalogSignedPayload(document), createPublicKey(key.publicKey), signature)) return 'invalid-signature'
  } catch { return 'invalid-signature' }
  return 'ok'
}

/** Adapter names this platform implements; a catalog entry may only reference these. */
export function knownSuiteCatalogAdapters(): readonly string[] { return suiteCatalogAdapters }
