import { enabledSharedModels, type SharedModelState } from '../domain/shared-models.js'
import type { PlatformLocale } from '../domain/platform-language.js'
import { join } from 'node:path'

/** The provider key of a supplier in the generated DSH configuration, derived from its stable identity. */
export const sharedModelProviderKey = (providerId: string) => `phalanx-${providerId}`
/** The single selectable explanation entry kept when no shared model is available. */
export const unconfiguredModelSelection = { provider: 'phalanx-unconfigured', model: 'unconfigured' } as const
/** Resolve the DSH provider and model of a platform model identity through the enabled suppliers that own it. */
export function sharedModelSelection(state: SharedModelState, id: string): { provider: string; model: string } {
  const owner = enabledSharedModels(state).find(row => row.model.id === id)
  return owner === undefined ? { ...unconfiguredModelSelection } : { provider: sharedModelProviderKey(owner.provider.id), model: id }
}

export const managedModelsDirectory = 'managed-models'
export const managedModelsConfig = 'models.json'
export const managedModelsWatcher = 'watch.mjs'
export const managedModelsCatalog = 'catalog.json'
export const managedModelsContainerPath = '/dsh-phalanx/managed-models'
export const managedModelPackages = { adapter: '@deepseek-ai/dsh-llm-pi-ai' }
export const managedModelContainerModules = {
  adapter: '/opt/dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js',
}

/** Public include composition uses only official exported modules and opaque gateway access. */
export function managedModelConfiguration(state: SharedModelState, directory: string, modules: { adapter: string }, locale: PlatformLocale = 'en'): string {
  const rows = configurationRows(state, locale)
  return JSON.stringify([
    { id: 'phalanx-model-watch', name: join(directory, managedModelsWatcher), config: { path: join(directory, managedModelsCatalog) } },
    {
      ...rows[0],
      name: modules.adapter,
      config: {
        providers: Object.fromEntries(
          Object.entries(rows[0]!.config.providers).map(([key, provider]) => [
            key,
            { ...provider, baseURL: { __jsExpr: 'process.env.DSH_PHALANX_MODEL_GATEWAY_URL' } },
          ]),
        ),
      },
    },
  ])
}

export const managedModelOverlay = (directory: string) => `
- id: llm-deepseek
  disabled: true
- id: llm-deepseek-account
  disabled: true
- id: llm-pi-ai
  disabled: true
- id: ui-settings-models
  disabled: true
- id: agent-default-model
  disabled: true
- insert:
    - id: phalanx-managed-models
      name: '@deepseek-ai/cordis-plugin-include'
      config:
        path: ${JSON.stringify(join(directory, managedModelsConfig))}
- id: phalanx-managed-models
  disabled: false
`

/** The watcher lives outside each writable profile and reloads nested entries via HMR. */
export const managedModelWatchModule = `
import { readFileSync } from 'node:fs'
export const name = 'phalanx-model-watch'
export const inject = ['loader', 'hmr']
export async function apply(ctx, config) {
  const read = () => readFileSync(config.path, 'utf8')
  let applied = read()
  let updates = Promise.resolve()
  const rows = () => JSON.parse(read())
  const sharedRow = () => rows().find(row => row.id === 'phalanx-shared-models')
  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ ...rows().find(row => row.id === 'phalanx-default-model').config }),
    saveSelection: async () => { throw new Error('The shared default model is managed by an administrator') },
  })
  const refresh = () => {
    const update = updates.catch(() => {}).then(async () => {
      const current = read()
      if (current === applied) return
      const next = sharedRow()
      for (const provider of Object.values(next.config.providers)) provider.baseURL = process.env.DSH_PHALANX_MODEL_GATEWAY_URL
      const entry = [...ctx.loader.entries()].find(row => row.options.id === next.id)
      await entry.update({ config: next.config })
      applied = current
      ctx.emit('llm/adapters-updated')
    })
    updates = update
    return update
  }
  ctx.on('agent/request', async (_payload, next) => {
    await refresh()
    const request = await next()
    const provider = sharedRow().config.providers[request.provider]
    if (String(request.provider).startsWith('phalanx-') && (provider === undefined || !provider.models.some(model => model.id === request.model))) {
      throw new Error('Select an enabled shared model. The selected model is disabled or deleted.')
    }
    return request
  })
  await ctx.hmr.watchConfig(config.path, refresh)
}
`

/** Startup and live reload share the same public configuration facts. */
export function managedModelCatalog(state: SharedModelState, locale: PlatformLocale = 'en'): string {
  return JSON.stringify(configurationRows(state, locale))
}

function configurationRows(state: SharedModelState, locale: PlatformLocale) {
  return [
    { id: 'phalanx-shared-models', config: { providers: managedProviderEntries(state, locale) } },
    { id: 'phalanx-default-model', config: { ...defaultSelection(state) } },
  ] as const
}

function defaultSelection(state: SharedModelState): { provider: string; model: string } {
  return state.defaultModelId === null ? { ...unconfiguredModelSelection } : sharedModelSelection(state, state.defaultModelId)
}

/** One DSH provider per enabled supplier; the group title is the supplier name and entries carry the model name only. */
export function managedProviderEntries(
  state: SharedModelState,
  locale: PlatformLocale,
): Record<string, { displayName: string; api: string; apiKeyEnv: string; models: ReturnType<typeof publicSharedModels> }> {
  const enabled = state.providers.filter(provider => provider.enabled && provider.apiKey.length > 0 && provider.models.some(model => model.enabled))
  // An enabled supplier without any enabled model leaves nothing selectable; keep the explanation route.
  if (enabled.length === 0)
    return {
      [unconfiguredModelSelection.provider]: {
        displayName: locale === 'zh-CN' ? '共享模型' : 'Shared models',
        api: 'anthropic-messages',
        apiKeyEnv: 'DSH_PHALANX_MODEL_GATEWAY_ACCESS_TOKEN',
        models: publicSharedModels(state, locale),
      },
    }
  return Object.fromEntries(
    enabled.map(provider => [
      sharedModelProviderKey(provider.id),
      {
        displayName: provider.name,
        api: provider.apiFormat,
        apiKeyEnv: 'DSH_PHALANX_MODEL_GATEWAY_ACCESS_TOKEN',
        models: provider.models
          .filter(model => model.enabled)
          .map(model => ({ id: model.id, name: model.name, input: model.input === 'text+image' ? ['text', 'image'] : ['text'] })),
      },
    ]),
  )
}

/** The selectable model entries across every enabled supplier, or the localized explanation entry when none exists. */
export function publicSharedModels(state: SharedModelState, locale: PlatformLocale = 'en') {
  const models = enabledSharedModels(state).map(({ model }) => ({
    id: model.id,
    name: model.name,
    input: model.input === 'text+image' ? ['text', 'image'] : ['text'],
  }))
  // A selectable explanation route lets native first use reach the explicit gateway failure.
  return models.length === 0 ? [{ id: 'unconfigured', name: locale === 'zh-CN' ? '共享模型未配置' : 'Shared models not configured', input: ['text'] }] : models
}
