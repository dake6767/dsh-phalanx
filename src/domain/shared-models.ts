import type { CommunityModelInput, CommunityModelSettings, CommunityProviderInput } from './admin-contract.js'

/**
 * Capabilities the platform knows about an upstream model identifier.
 * The table is the single owner of the known model facts: the default model
 * catalog and the shared model input defaults both read it.
 */
export interface KnownModel {
  readonly input: CommunityModelInput
  /** Extra fields the platform's default model catalog supplies to DSH. */
  readonly defaultModel?: Readonly<Record<string, string>>
}

const KNOWN_MODELS: Readonly<Record<string, KnownModel>> = {
  'deepseek-flash': { input: 'text+image', defaultModel: { name: 'DeepSeek-V41-Flash', systemPromptUpdate: 'in-history' } },
  'deepseek-v4-pro': {
    input: 'text',
    defaultModel: {
      name: 'DeepSeek-V4-Pro',
      description: 'Stronger agentic coding, knowledge, and difficult reasoning; suited to complex or quality-critical tasks at higher cost.',
    },
  },
}

/** Look up the capability record of an upstream model identifier an administrator typed. */
export function knownModel(identifier: string): KnownModel | undefined { return KNOWN_MODELS[identifier] }

/**
 * Input declaration an administrator gets by default for a model identifier.
 * Known vision models start with images enabled; everything else starts text-only.
 */
export function knownModelInput(identifier: string): CommunityModelInput { return knownModel(identifier)?.input ?? 'text' }

export interface SharedProvider extends Omit<CommunityProviderInput, 'id' | 'apiKey' | 'models'> {
  readonly id: string
  readonly apiKey: string
  readonly models: readonly { readonly id: string, readonly name: string, readonly enabled: boolean, readonly input: CommunityModelInput }[]
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
/**
 * Fill the input declaration of every stored model. Missing declarations are
 * upgraded from the known model table, so loading an older store adds image
 * input to known vision models and leaves everything else text-only. The
 * result is stable across repeated loads.
 */
export function normalizeSharedModelState(state: SharedModelState): SharedModelState {
  return { ...state, providers: state.providers.map(provider => ({ ...provider,
    models: provider.models.map(model => ({ ...model, input: model.input === 'text' || model.input === 'text+image'
      ? model.input : knownModelInput(model.name) })) })) }
}
