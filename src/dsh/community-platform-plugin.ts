import { join } from 'node:path'
import { artifactDownloadPlugin } from './community-artifact-download.js'
import { nativePluginPolicy, nativePluginPolicyOverlay } from './native-plugin-policy.js'

export const platformPluginDirectory = 'platform-plugin'
export const platformPluginContainerPath = '/dsh-phalanx/platform-plugin'
export const platformPluginPatch = 'overlay.yml'
export const platformPluginRows = 'plugins.yml'

/** Public WebServer index tap; manifest fetches must carry the space login. */
export const platformPluginModule = `
export const name = 'phalanx-platform'
export const inject = ['webServer', 'connection', 'typertGateway']
export function apply(ctx) {
  ${nativePluginPolicy}
  ${artifactDownloadPlugin}
  ctx.effect(() => ctx.webServer.tapIndex(html => html.replace(
    /(<link\\b[^>]*\\brel=)(["'])manifest\\2/gi,
    '$1$2manifest$2 crossorigin="use-credentials"',
  )))
}
`

export function platformPluginOverlay(directory: string): string {
  return JSON.stringify([
    { insert: [{ id: 'phalanx-platform-layer', name: '@deepseek-ai/cordis-plugin-include', config: { path: join(directory, platformPluginRows) } }] },
    { id: 'phalanx-platform-layer', disabled: false },
    ...nativePluginPolicyOverlay,
  ])
}

export function platformPluginInclude(directory: string): string {
  return JSON.stringify([
    { id: 'phalanx-execution-shell-environment', name: join(directory, 'execution-shell-env.mjs') },
    { id: 'phalanx-platform', name: join(directory, 'plugin.mjs') },
    { id: 'phalanx-contribution-tools', name: join(directory, 'contributions.mjs') },
    { id: 'phalanx-skill-usage', name: join(directory, 'skill-usage.mjs') },
  ])
}
