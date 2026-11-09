import { featureVisible } from '../domain/release-visibility.js'
import { join } from 'node:path'
import { expertConversationPlugin } from './expert-conversation.js'
import { artifactDownloadPlugin } from './community-artifact-download.js'

export const platformPluginDirectory = 'platform-plugin'
export const platformPluginContainerPath = '/dsh-phalanx/platform-plugin'
export const platformPluginPatch = 'overlay.yml'
export const platformPluginRows = 'plugins.yml'

/** Public WebServer index tap; manifest fetches must carry the space login. */
export const platformPluginModule = `
export const name = 'phalanx-platform'
export const inject = ['webServer', 'connection', 'typertGateway']
export function apply(ctx) {
  ${artifactDownloadPlugin}
  ${expertConversationPlugin}
  ctx.effect(() => ctx.webServer.tapIndex(html => html.replace(
    /(<link\\b[^>]*\\brel=)(["'])manifest\\2/gi,
    '$1$2manifest$2 crossorigin="use-credentials"',
  )))
}
`

export function platformPluginOverlay(directory: string): string {
  return JSON.stringify([
    { id: 'tools', disabled: true },
    { insert: [{ id: 'phalanx-platform-layer', name: '@deepseek-ai/cordis-plugin-include', config: { path: join(directory, platformPluginRows) } }] },
    { id: 'phalanx-platform-layer', disabled: false },
  ])
}

export function platformPluginInclude(directory: string): string {
  return JSON.stringify([
    { id: 'phalanx-tools', name: join(directory, 'tools.mjs') },
    { id: 'phalanx-execution-shell-environment', name: join(directory, 'execution-shell-env.mjs') },
    { id: 'phalanx-platform', name: join(directory, 'plugin.mjs') },
    ...(featureVisible('contributions') ? [{ id: 'phalanx-contribution-tools', name: join(directory, 'contributions.mjs') }] : []),
    { id: 'phalanx-skill-usage', name: join(directory, 'skill-usage.mjs') },
  ])
}
