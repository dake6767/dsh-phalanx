/** Deployment-owned one-time credential; its raw value never leaves the file adapter. */
export interface BootstrapCredentialPort {
  verify(value: string): boolean
  consume(): void
}
