/** Stable storage position authenticated together with each encrypted value. */
export interface PlatformSecretContext {
  readonly table: string
  readonly recordId: string
  readonly field: string
}
export interface PlatformSecretEnvelope {
  readonly key_id: string
  readonly nonce: string
  readonly ciphertext: string
}
export interface PlatformSecretRegistry {
  readonly version: 1
  readonly masterFingerprint: string
  readonly keys: readonly PlatformSecretEnvelope[]
}
