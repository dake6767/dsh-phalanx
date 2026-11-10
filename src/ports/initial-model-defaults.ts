import type { CommunityProviderProtocol } from '../domain/admin-contract.js'

export interface InitialModelValues {
  readonly name?: string
  readonly baseUrl?: string
  readonly apiFormat?: CommunityProviderProtocol
  readonly model?: string
  readonly apiKey?: string
}
export type InitialModelDefaults = { readonly status: 'absent' | 'invalid' } | { readonly status: 'ready'; readonly values: InitialModelValues }
export interface InitialModelDefaultsPort {
  read(): InitialModelDefaults
}
export interface SharedModelPublicationPort {
  retry(revision: number): Promise<void>
}
