import { fileURLToPath } from 'node:url'
import { realDshTestPorts } from './real-dsh-ports.js'
import type { RealDshRuntimeTestSettings } from './real-dsh-runtime.js'

export const runtimeSettings: RealDshRuntimeTestSettings = {
  dshRoot: process.env.DSH_PHALANX_DSH_ROOT,
  containerImage: process.env.DSH_PHALANX_CONTAINER_IMAGE,
  containerRuntimeCli: process.env.DSH_PHALANX_CONTAINER_RUNTIME ?? 'podman',
  containerGatewayPort: realDshTestPorts(Number(process.env.DSH_PHALANX_E2E_PORT_BASE ?? '3180')).gateway,
  overlay: fileURLToPath(new URL('../fixtures/dsh-test.overlay.yml', import.meta.url)),
}
