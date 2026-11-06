import { join } from 'node:path'
import type { CommunityRuntimeConfig } from '../domain/community-config.js'
import type { CommunityModelGatewayAccess } from '../ports/community-runtime.js'
import { dshHomePath } from '../dsh/profile-layout.js'
import { egressEnvironment } from '../domain/egress-environment.js'
import { modelCatalogJson } from '../domain/model-catalog.js'
import { managedModelsCatalog, managedModelsConfig, managedModelsContainerPath, managedModelsDirectory, managedModelsWatcher } from '../dsh/shared-models.js'
import { SKILL_USAGE_ENDPOINT_ENV, SKILL_USAGE_PATH, SKILL_USAGE_PROVIDERS_ENV } from '../dsh/skill-usage.js'
import { WEB_TOOLS_MEMBER_TOKEN_ENV } from '../dsh/web-tools.js'

/** One environment owner keeps gateway credentials out of launch argv and member artifacts. */
export function memberRuntimeEnvironment(
  config: CommunityRuntimeConfig,
  home: string,
  access: CommunityModelGatewayAccess,
  pluginEnvironment: Readonly<Record<string, string>> | undefined,
  skillProviders: readonly string[],
  modelsDirectory: string = join(config.dataRoot, managedModelsDirectory),
): Record<string, string> {
  const inherited: Record<string, string> = {}
  for (const key of ['PATH', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL']) if (process.env[key] !== undefined) inherited[key] = process.env[key]!
  const environment: Record<string, string> = {
    ...inherited,
    ...config.environment,
    ...pluginEnvironment,
    HOME: home,
    DSH_HOME: dshHomePath(home),
    DSH_AGENTS_HOME: join(home, '.agents'),
    DSH_TELEMETRY_MODE: 'DISABLED',
    DSH_TELEMETRY_DISABLED: '1',
    DSH_PHALANX_WORKSPACE_DOCUMENTS_DIR: join(home, 'Documents'),
    DSH_PHALANX_DEFAULT_MODEL_SECRET_CATALOG: modelCatalogJson(config.defaultModel.model),
    DSH_PHALANX_MODEL_GATEWAY_URL: access.url,
    [SKILL_USAGE_ENDPOINT_ENV]: new URL(SKILL_USAGE_PATH, access.url).href,
    [SKILL_USAGE_PROVIDERS_ENV]: JSON.stringify(skillProviders),
    DSH_PHALANX_MODEL_GATEWAY_ACCESS_TOKEN: access.token,
    [WEB_TOOLS_MEMBER_TOKEN_ENV]: access.token,
  }
  const managed = config.container === undefined ? modelsDirectory : managedModelsContainerPath
  Object.assign(environment, {
    DSH_PHALANX_MANAGED_MODELS_CONFIG: join(managed, managedModelsConfig),
    DSH_PHALANX_MANAGED_MODELS_CATALOG: join(managed, managedModelsCatalog),
    DSH_PHALANX_MANAGED_MODELS_WATCHER: join(managed, managedModelsWatcher),
  })
  if (config.container !== undefined) {
    const proxy = new URL(access.url).origin
    const authenticated = new URL(proxy)
    authenticated.username = 'dsh'
    authenticated.password = access.token
    Object.assign(environment, egressEnvironment(authenticated.href))
  }
  return environment
}
