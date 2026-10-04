import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { expect } from 'vitest'

export const DSH_REVISION = '5badb15009ae1756c3afe0ae0cef1faafc290ccc'
export const CONTAINER_HOME = '/dsh-phalanx/home'
export const CONTAINER_DSH_CLI = '/opt/dsh/apps/cli/lib/bin.js'

export interface RealDshRuntimeTestSettings {
  readonly dshRoot: string | undefined
  readonly containerImage: string | undefined
  readonly containerRuntimeCli: string
  readonly containerGatewayPort: number
  readonly overlay: string
}

export function assertPinnedDshRevision(settings: RealDshRuntimeTestSettings): void {
  if (settings.containerImage !== undefined) {
    const labeled = execFileSync(settings.containerRuntimeCli, [
      'image', 'inspect', settings.containerImage, '--format', '{{index .Config.Labels "dsh.revision"}}',
    ], { encoding: 'utf8' }).trim()
    expect(labeled).toBe(DSH_REVISION)
    return
  }
  if (settings.dshRoot === undefined) return
  expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: settings.dshRoot, encoding: 'utf8' }).trim()).toBe(DSH_REVISION)
}

export function runtimeSection(dataRoot: string, modelOrigin: string, settings: RealDshRuntimeTestSettings) {
  const base = {
    dataRoot,
    patches: [settings.overlay],
    defaultModel: {
      provider: 'deepseek-official',
      model: 'deepseek-chat',
      upstream: { baseUrl: modelOrigin },
    },
    environment: { DSH_TELEMETRY_DISABLED: '1' },
  }
  if (settings.containerImage !== undefined) {
    return {
      ...base,
      command: 'node',
      args: [CONTAINER_DSH_CLI, '--profile', 'web'],
      container: {
        runtime: settings.containerRuntimeCli,
        image: settings.containerImage,
        internalPort: 4180,
        gatewayPort: settings.containerGatewayPort,
      },
    }
  }
  if (settings.dshRoot === undefined) throw new Error('DSH_PHALANX_DSH_ROOT is required')
  return {
    ...base,
    command: process.execPath,
    args: [join(settings.dshRoot, 'apps', 'cli', 'lib', 'bin.js'), '--profile', 'web'],
  }
}

export function instanceWorkspacePath(hostWorkspace: string, containerMode: boolean): string {
  return containerMode ? join(CONTAINER_HOME, 'Documents', 'deepseek-harness', 'default-workspace') : hostWorkspace
}

export function defaultWorkspacePath(dataRoot: string, userId: string): string {
  return join(dataRoot, 'users', userId, 'home', 'Documents', 'deepseek-harness', 'default-workspace')
}
