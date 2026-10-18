import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { suiteCatalogSignedPayload, type SuiteCatalogDocument, type SuiteCatalogDocumentEntry } from '../../src/domain/suite-catalog-document.js'
import type { TrustedSuiteCatalogKey } from '../../src/domain/suite-catalog-signature.js'

export interface CatalogSigningKey extends TrustedSuiteCatalogKey {
  readonly privateKey: KeyObject
}

/** A fresh Ed25519 key per test, so tests never depend on a fixed private key. */
export function createCatalogSigningKey(keyId = 'test-catalog-key'): CatalogSigningKey {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return { keyId, privateKey, publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString() }
}

export interface SignedCatalogFixture {
  readonly document: SuiteCatalogDocument
  /** Exact bytes served to the platform; normalization is the platform's concern. */
  readonly bytes: Buffer
}

export function signCatalog(entries: readonly SuiteCatalogDocumentEntry[], key: CatalogSigningKey, publishedAt = '2026-10-18T00:00:00.000Z'): SignedCatalogFixture {
  const unsigned = { format: 1 as const, publishedAt, entries }
  const signature = sign(null, suiteCatalogSignedPayload(unsigned), key.privateKey).toString('base64')
  const document: SuiteCatalogDocument = { ...unsigned, signature: { keyId: key.keyId, signature } }
  return { document, bytes: Buffer.from(JSON.stringify(document), 'utf8') }
}
