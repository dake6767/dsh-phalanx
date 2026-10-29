/** Explicit administration projection; connection credentials and local key paths never cross this boundary. */
export interface CommunitySystemStatusView {
  readonly database: { readonly kind: 'builtin' | 'external'; readonly address: string; readonly serverVersion: string; readonly state: 'connected' }
  readonly masterKey: {
    readonly fingerprint: string
    readonly backup: { readonly username: string; readonly spaceId: string; readonly confirmedAt: string } | null
  }
}
