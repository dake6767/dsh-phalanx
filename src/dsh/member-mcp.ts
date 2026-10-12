import { join } from 'node:path'
export const memberMcpMount = '/dsh-phalanx/member-mcp'
export const memberMcpPackage = '@deepseek-ai/dsh-mcp-client'
export const memberMcpContainerModule = `/opt/dsh/node_modules/${memberMcpPackage}/lib/index.js`

/** Frozen official MCP client entries contain only member gateway access. */
export function memberMcpEntries(services: readonly { name: string, generation: number }[], module: string): string {
  return JSON.stringify(services.map(({ name, generation }) => ({ id: `phalanx-mcp-${name}`, name: module, config: {
    transport: 'streamable-http', serverName: name,
    url: { __jsExpr: `new URL(${JSON.stringify('/mcp/' + name + '?generation=' + generation)}, process.env.DSH_PHALANX_MODEL_GATEWAY_URL).href` },
    headers: { Authorization: { __jsExpr: "'Bearer ' + process.env.DSH_PHALANX_MODEL_GATEWAY_ACCESS_TOKEN" } },
  } })))
}
export function memberMcpOverlay(directory: string): string {
  return JSON.stringify([{ insert: [
    { id: 'phalanx-mcp-include', name: '@deepseek-ai/cordis-plugin-include', config: { path: join(directory, 'entries.json') } },
    { id: 'phalanx-mcp-watch', name: join(directory, 'watch.mjs'), config: { path: join(directory, 'entries.json') } },
  ] }])
}

/** Reassemble each outer prompt after the HMR queue so even an overlapping watcher cannot leave an old tool snapshot. */
export const memberMcpWatcher = `
import { readFileSync } from 'node:fs'
import { AsyncLocalStorage } from 'node:async_hooks'
export const name = 'phalanx-mcp-watch'
export const inject = ['loader', 'hmr', 'systemPrompt']
export async function apply(ctx, config) {
  const rebuilding = new AsyncLocalStorage()
  let applied = readFileSync(config.path, 'utf8')
  const refresh = async () => {
    const next = readFileSync(config.path, 'utf8')
    if (next === applied) return
    const entry = [...ctx.loader.entries()].find(entry => entry.options.id === 'phalanx-mcp-include')
    await entry.subtree.refresh()
    await ctx.loader.await()
    applied = next
  }
  await ctx.hmr.watchConfig(config.path, refresh)
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    if (rebuilding.getStore()) return next()
    await ctx.hmr.runExclusive(refresh)
    return rebuilding.run(true, () => ctx.systemPrompt.assemble(context))
  })
}
`
