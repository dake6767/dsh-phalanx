import type { TrustedSuiteCatalogKey } from './suite-catalog-signature.js'

/** Official catalog keys. Ship both old and new public keys before rotating the signing secret. */
export const officialSuiteCatalogKeys: readonly TrustedSuiteCatalogKey[] = [
  {
    keyId: 'official-1d3e959e7923e4f4',
    publicKey: '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAnV7oFCy2bXlvKFNcfAS74MYSLQ+sZlxLWYBL4ddWiAw=\n-----END PUBLIC KEY-----\n',
  },
]
