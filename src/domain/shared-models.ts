import type { CommunityModelSettings, CommunityProviderInput } from './admin-contract.js'

export interface SharedProvider extends Omit<CommunityProviderInput, 'id' | 'apiKey' | 'models'> {
  readonly id: string
  readonly apiKey: string
  readonly models: readonly { readonly id: string, readonly name: string, readonly enabled: boolean }[]
}
export interface SharedModelState {
  readonly revision: number
  readonly providers: readonly SharedProvider[]
  readonly defaultModelId: string | null
}
export function sharedModelSettings(state: SharedModelState): CommunityModelSettings {
  return { revision: state.revision, defaultModelId: state.defaultModelId,
    providers: state.providers.map(({ apiKey, ...provider }) => ({ ...provider, hasApiKey: apiKey.length > 0 })) }
}
export function enabledSharedModels(state: SharedModelState) {
  return state.providers.filter(provider => provider.enabled && provider.apiKey.length > 0)
    .flatMap(provider => provider.models.filter(model => model.enabled).map(model => ({ provider, model })))
}
