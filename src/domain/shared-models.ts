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
  'deepseek-flash': { input: 'text+image', defaultModel: { name: 'DeepSeek-V4.1-Flash', systemPromptUpdate: 'in-history' } },
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

/** The single guard for a declared model input kind, shared by validation and migration. */
export function isModelInput(value: unknown): value is CommunityModelInput { return value === 'text' || value === 'text+image' }

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
 * Fill the input declaration of every stored model. Missing or unrecognized
 * declarations are upgraded from the known model table, so loading an older
 * store adds image input to known vision models and leaves everything else
 * text-only. The result is stable across repeated loads.
 */
export function normalizeSharedModelState(state: SharedModelState): SharedModelState {
  return { ...state, providers: state.providers.map(provider => ({ ...provider,
    models: provider.models.map(model => ({ ...model,
      // Only a missing declaration is upgraded from the known table; a corrupt present value stays text-only.
      input: model.input === undefined ? knownModelInput(model.name) : isModelInput(model.input) ? model.input : 'text' })) })) }
}

/** The one DeepSeek API credential the platform retrieval gateway may use. */
export interface SharedWebToolsCredential {
  readonly apiKey: string
}

/** Only the host the caller allows may receive the administrator's retrieval key. */
function providerUsesHost(provider: SharedProvider, host: string): boolean {
  try { return new URL(provider.baseUrl).hostname === host }
  catch { return false }
}

/**
 * Deterministic retrieval credential: the current default model's enabled
 * provider on the allowed host, else the first enabled provider on that host,
 * else no credential. The allowed host stays with the retrieval seam owner so
 * this selector never names an upstream itself.
 * @param state - published shared model configuration.
 * @param host - upstream host allowed to receive this credential.
 * @returns the provider key, or undefined when no eligible provider exists.
 */
export function webToolsCredential(state: SharedModelState, host: string): SharedWebToolsCredential | undefined {
  const eligible = state.providers.filter(provider => provider.enabled && provider.apiKey.length > 0 && providerUsesHost(provider, host))
  const defaultProvider = state.defaultModelId === null
    ? undefined
    : eligible.find(provider => provider.models.some(model => model.enabled && model.id === state.defaultModelId))
  const selected = defaultProvider ?? eligible[0]
  return selected === undefined ? undefined : { apiKey: selected.apiKey }
}

