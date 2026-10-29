import type { PlatformSecretContext, PlatformSecretEnvelope } from '../domain/platform-secret.js'

/** The envelope operations protected storage needs; the platform's single key owner implements them. */
export interface PlatformSecretCipher {
  encrypt(context: PlatformSecretContext, value: string): PlatformSecretEnvelope
  decrypt(context: PlatformSecretContext, envelope: PlatformSecretEnvelope): string
}

/**
 * The encrypted values of one table. Each value is bound to its table, record and
 * field as associated data, so a value copied to another position fails to decrypt.
 * Stores compose record and field exactly as before; stored ciphertext depends on it.
 */
export interface ProtectedTable {
  readonly table: string
  context(recordId: string, field: string): PlatformSecretContext
  encrypt(cipher: PlatformSecretCipher, recordId: string, field: string, value: string): PlatformSecretEnvelope
  decrypt(cipher: PlatformSecretCipher, recordId: string, field: string, envelope: PlatformSecretEnvelope): string
}

export function protectedTable(table: string): ProtectedTable {
  if (!/^[a-z][a-z0-9_]*$/u.test(table)) throw Error('Protected table needs a platform table name')
  const context = (recordId: string, field: string): PlatformSecretContext => ({ table, recordId, field })
  return {
    table,
    context,
    encrypt: (cipher, recordId, field, value) => cipher.encrypt(context(recordId, field), value),
    decrypt: (cipher, recordId, field, envelope) => cipher.decrypt(context(recordId, field), envelope),
  }
}
