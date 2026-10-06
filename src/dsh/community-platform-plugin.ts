import { join } from 'node:path'

export const platformPluginDirectory = 'platform-plugin'
export const platformPluginContainerPath = '/dsh-phalanx/platform-plugin'
export const platformPluginPatch = 'overlay.yml'
export const platformPluginRows = 'plugins.yml'

/** Public WebServer index tap; manifest fetches must carry the space login. */
export const platformPluginModule = `
export const name = 'phalanx-platform'
export const inject = ['webServer']
export function apply(ctx) {
  const notice = process.env.DSH_PHALANX_UPGRADE_NOTICE === 'choose-shared-model'
    ? '<aside id="phalanx-upgrade-notice" role="status" style="position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:10000;background:#fff7dd;padding:8px 12px;border:1px solid #dec888;border-radius:8px;font:13px system-ui;color:#423718">Your previous personal model settings were backed up. Select an enabled shared model in affected conversations.</aside>' : ''
  ctx.effect(() => ctx.webServer.tapIndex(html => html.replace(
    /(<link\\b[^>]*\\brel=)(["'])manifest\\2/gi,
    '$1$2manifest$2 crossorigin="use-credentials"',
  ).replace('</body>', notice + '</body>')))
}
`

export function platformPluginOverlay(directory: string): string {
  return JSON.stringify([{ insert: [{ id: 'phalanx-platform-layer', name: '@deepseek-ai/cordis-plugin-include', config: { path: join(directory, platformPluginRows) } }] },
    { id: 'phalanx-platform-layer', disabled: false }])
}

export function platformPluginInclude(directory: string): string {
  return JSON.stringify([{ id: 'phalanx-platform', name: join(directory, 'plugin.mjs') }])
}
