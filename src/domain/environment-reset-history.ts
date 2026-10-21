/** Records initiation, never a claim that environment recovery completed. */
export interface EnvironmentResetRequest { readonly at: number, readonly username: string, readonly role: 'admin' | 'member' }
export interface EnvironmentResetHistory { readonly lastMemberAcceptedAt?: number, readonly recent: EnvironmentResetRequest }
