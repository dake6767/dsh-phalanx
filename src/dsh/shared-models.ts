import { enabledSharedModels, type SharedModelState } from '../domain/shared-models.js'
import { join } from 'node:path'

export const managedModelsDirectory = 'managed-models'
export const managedModelsConfig = 'models.json'
export const managedModelsWatcher = 'watch.mjs'
export const managedModelsCatalog = 'catalog.json'
export const managedModelsContainerPath = '/dsh-phalanx/managed-models'
export const managedModelPackages = { adapter: '@deepseek-ai/dsh-llm-pi-ai', defaultModel: '@deepseek-ai/dsh-agent-default-model' }
export const managedModelContainerModules = {
  adapter: '/opt/dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js',
  defaultModel: '/opt/dsh/node_modules/@deepseek-ai/dsh-agent-default-model/lib/index.js',
}

/** Public include composition uses only official exported modules and opaque gateway access. */
export function managedModelConfiguration(state: SharedModelState, directory: string, modules: { adapter: string, defaultModel: string }): string {
  const rows = configurationRows(state)
  return JSON.stringify([
    { id: 'phalanx-model-watch', name: join(directory, managedModelsWatcher), config: { path: join(directory, managedModelsCatalog) } },
    { ...rows[0], name: modules.adapter, config: { providers: { 'deepseek-official': {
      ...rows[0]!.config.providers['deepseek-official'], baseURL: { __jsExpr: 'process.env.DSH_PHALANX_MODEL_GATEWAY_URL' },
    } } } },
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
  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ ...rows().find(row => row.id === 'phalanx-default-model').config }),
    saveSelection: async () => { throw new Error('The shared default model is managed by an administrator') },
  })
  const refresh = () => {
    const update = updates.catch(() => {}).then(async () => {
      const current = read()
      if (current === applied) return
      const next = JSON.parse(current).find(row => row.id === 'phalanx-shared-models')
      next.config.providers['deepseek-official'].baseURL = process.env.DSH_PHALANX_MODEL_GATEWAY_URL
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
    const models = rows().find(row => row.id === 'phalanx-shared-models').config.providers['deepseek-official'].models
    if (request.provider === 'deepseek-official' && !models.some(model => model.id === request.model)) {
      throw new Error('Select an enabled shared model. The selected model is disabled or deleted.')
    }
    return request
  })
  await ctx.hmr.watchConfig(config.path, refresh)
}
`

/** Startup and live reload share the same public configuration facts. */
export function managedModelCatalog(state: SharedModelState): string {
  return JSON.stringify(configurationRows(state))
}

function configurationRows(state: SharedModelState) {
  return [
    { id: 'phalanx-shared-models', config: { providers: { 'deepseek-official': { displayName: 'Shared models', api: 'anthropic-messages', apiKeyEnv: 'DSH_PHALANX_MODEL_GATEWAY_ACCESS_TOKEN', models: publicSharedModels(state) } } } },
    { id: 'phalanx-default-model', config: { provider: 'deepseek-official', model: state.defaultModelId ?? 'unconfigured' } },
  ] as const
}

function publicSharedModels(state: SharedModelState) {
  const models = enabledSharedModels(state).map(({ provider, model }) => ({ id: model.id, name: `${provider.name} / ${model.name}` }))
  // A selectable explanation route lets native first use reach the explicit gateway failure.
  return models.length === 0 ? [{ id: 'unconfigured', name: 'Shared models not configured' }] : models
}
