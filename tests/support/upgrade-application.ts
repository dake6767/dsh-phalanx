import { join } from 'node:path'
import type { CommunityConfig } from '../../src/domain/community-config.js'
import type { CommunityApplication } from '../../src/ports/community-application.js'
import { createCommunityApplication } from '../../src/composition/community-application.js'
import { startPlatformCli } from './platform-cli.js'

/** The old release always runs its public command with its own bundled Node. */
export function upgradeApplication(config: CommunityConfig, installedRoot?: string): CommunityApplication {
  if (installedRoot === undefined) return createCommunityApplication(config)
  let cli: Awaited<ReturnType<typeof startPlatformCli>> | undefined
  return {
    start: async () => {
      const runtime = config.runtime, container = runtime.container
      if (container === undefined) throw new Error('Installed upgrade acceptance requires Linux containers')
      cli = await startPlatformCli(join(installedRoot, 'start'), [], {
        DSH_PHALANX_HOST: config.listen.host, DSH_PHALANX_PORT: String(config.listen.port), DSH_PHALANX_DATA_ROOT: runtime.dataRoot,
        DSH_PHALANX_SESSION_SECRET: config.sessionSecret, DSH_PHALANX_RUNTIME_COMMAND: runtime.command,
        DSH_PHALANX_RUNTIME_ARGS_JSON: JSON.stringify(runtime.args), DSH_PHALANX_RUNTIME_PATCHES_JSON: JSON.stringify(runtime.patches ?? []),
        DSH_PHALANX_CONTAINER_RUNTIME: container.runtime, DSH_PHALANX_CONTAINER_IMAGE: container.image,
        DSH_PHALANX_CONTAINER_INTERNAL_PORT: String(container.internalPort), DSH_PHALANX_CONTAINER_GATEWAY_PORT: String(container.gatewayPort),
        ...(config.network === undefined ? {} : { DSH_PHALANX_HOST_PUBLIC_ADDRESSES: config.network.hostPublicAddresses.join(',') }),
        DSH_PHALANX_ALLOWED_MODEL_PROVIDER: runtime.defaultModel.provider, DSH_PHALANX_ALLOWED_MODEL: runtime.defaultModel.model,
        DSH_PHALANX_MODEL_UPSTREAM_BASE_URL: runtime.defaultModel.upstream.baseUrl,
        ...(config.modelGateway === undefined ? {} : { DSH_PHALANX_MODEL_UPSTREAM_API_KEY: config.modelGateway.upstreamApiKey }),
        ...Object.fromEntries(Object.entries({
          DSH_PHALANX_PUBLIC_ORIGIN: config.listen.publicOrigin, DSH_PHALANX_ADMIN_UI_ROOT: config.adminUiRoot,
          DSH_PHALANX_IDLE_RECLAIM_SECONDS: config.idleReclaimSeconds?.toString(),
          DSH_PHALANX_USER_DATA_ROOT: runtime.userDataRoot, DSH_PHALANX_USER_DATA_MOUNT: runtime.userDataMount,
          DSH_PHALANX_RUNTIME_ENV_JSON: runtime.environment === undefined ? undefined : JSON.stringify(runtime.environment),
          DSH_PHALANX_CONTAINER_ARGS_JSON: container.extraArgs === undefined ? undefined : JSON.stringify(container.extraArgs),
        }).filter((row): row is [string, string] => row[1] !== undefined)),
      })
      return cli.origin
    },
    stop: async () => { await cli?.stop() },
  }
}
