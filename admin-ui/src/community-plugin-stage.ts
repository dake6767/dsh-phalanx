import type { CommunityPluginStage, CommunityPluginView } from '../../src/domain/admin-contract'

export const pluginStageLabels = {
  resolving: 'Resolving package',
  downloading: 'Downloading package',
  installing: 'Installing dependencies',
  prechecking: 'Checking offline compatibility',
  available: 'Available',
  failed: 'Precheck failed',
  ready: 'Precheck passed',
} as const satisfies Record<CommunityPluginStage | 'ready', string>

/** GitHub versions name their commit: `0.1.15-settings.4 (a1b2c3d)`. */
export function pluginVersionLabel(version: string, sourceCommit?: string): string {
  return sourceCommit ? `${version} (${sourceCommit.slice(0, 7)})` : version
}
export function pluginSourceLabel(plugin: Pick<CommunityPluginView, 'source' | 'repository'>, t: (key: 'Uploaded archive' | 'npm registry') => string): string {
  return plugin.source === 'github' ? `GitHub ${plugin.repository ?? ''}` : t(plugin.source === 'upload' ? 'Uploaded archive' : 'npm registry')
}
