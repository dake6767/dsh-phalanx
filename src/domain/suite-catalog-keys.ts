import type { TrustedSuiteCatalogKey } from './suite-catalog-signature.js'

/**
 * Trusted online catalog signing keys, compiled into the platform.
 * The placeholder key below has no private key in the repository; ticket 09 replaces it with the
 * official key before release. Rotating keys means shipping a platform version that trusts both
 * the old and the new key first.
 */
export const officialSuiteCatalogKeys: readonly TrustedSuiteCatalogKey[] = [
  { keyId: 'official-placeholder-2026-10', publicKey: '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA14NoM6jm44FLn1ZLvTVZtpJBJBSV+o6xVK1N5F9w8Rs=\n-----END PUBLIC KEY-----\n' },
]
