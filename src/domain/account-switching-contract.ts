/** Browser remembered-account display contract. Bearer tokens stay server-side. */
export type SignedInAccountStatus = 'current' | 'available' | 'reauthentication-required' | 'unavailable'

/** Display facts for one remembered entry; the marker references the entry and no token ever leaves. */
export interface SignedInAccountView {
  readonly username: string
  readonly admin: boolean
  readonly status: SignedInAccountStatus
  readonly marker: string
}
