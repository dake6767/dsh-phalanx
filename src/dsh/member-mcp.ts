import { join } from 'node:path'
import { SHARED_MCP_REQUEST_CEILING_MS } from '../domain/mcp-service.js'
import type { McpService } from '../domain/mcp-service.js'
export const memberMcpDependenciesMount = '/dsh-phalanx/mcp-dependencies'
export const memberMcpMount = '/dsh-phalanx/member-mcp'
export const memberMcpPackage = '@deepseek-ai/dsh-mcp-client'
export const memberMcpContainerModule = `/opt/dsh/node_modules/${memberMcpPackage}/lib/index.js`

/** Frozen official MCP client entries contain only member gateway access. */
export function memberMcpInvocation(service: McpService, diagnostic = false, wrapperDirectory = memberMcpMount) {
  if (service.run?.location !== 'member' || !service.prepared) throw Error('Member MCP dependencies are unavailable')
  return { command: 'node', args: [join(wrapperDirectory, 'filter.mjs'), JSON.stringify({
    directory: service.prepared.directory, command: service.run.command, args: service.run.args, env: service.run.env, pathDirectories: service.prepared.dependencies?.flatMap(row => row.pathDirectories.map(path => `${row.mountedPath}/${path}`)), legacy: !service.prepared.dependencies, compatibility: !service.prepared.dependencies || !!service.dependencyName && !!service.run.runtimeDependencies?.includes(service.dependencyName),
    disabledTools: diagnostic ? [] : service.disabledTools ?? [], ...(diagnostic ? { timeoutMs: 30000 } : {}),
  })] }
}
export function memberMcpEntries(services: readonly McpService[], module: string, directory = memberMcpMount): string {
  return JSON.stringify(services.map(service => ({ id: `phalanx-mcp-${service.name}`, name: module, config: service.run?.location === 'member' ? {
    transport: 'stdio', serverName: service.name, failOnStartupError: true, ...memberMcpInvocation(service, false, directory),
  } : service.run?.location === 'shared' ? {
    transport: 'stdio', serverName: service.name, failOnStartupError: true, command: 'node',
    toolCallTimeoutMs: SHARED_MCP_REQUEST_CEILING_MS,
    args: [join(directory, 'shared-client.mjs'), JSON.stringify({ module, path: '/mcp/' + service.name + '?generation=' + service.generation })],
    env: {
      PHALANX_MCP_GATEWAY_URL: { __jsExpr: 'process.env.DSH_PHALANX_MODEL_GATEWAY_URL' },
      PHALANX_MCP_GATEWAY_TOKEN: { __jsExpr: 'process.env.DSH_PHALANX_MODEL_GATEWAY_ACCESS_TOKEN' },
    },
  } : {
    transport: 'streamable-http', serverName: service.name, failOnStartupError: true,
    url: { __jsExpr: `new URL(${JSON.stringify('/mcp/' + service.name + '?generation=' + service.generation)}, process.env.DSH_PHALANX_MODEL_GATEWAY_URL).href` },
    headers: { Authorization: { __jsExpr: "'Bearer ' + process.env.DSH_PHALANX_MODEL_GATEWAY_ACCESS_TOKEN" } },
  } })))
}
export function memberMcpOverlay(directory: string, module = memberMcpContainerModule): string {
  return JSON.stringify([{ insert: [
    { id: 'phalanx-mcp-include', name: '@deepseek-ai/cordis-plugin-include', config: { path: join(directory, 'initial.json') } },
    { id: 'phalanx-mcp-watch', name: join(directory, 'watch.mjs'), config: { path: join(directory, 'entries.json'), module } },
  ] }])
}

/** The readonly Include starts empty so personal namespaces yield before platform clients start.
 * Only public DSH composition, loader and writer-lock APIs are used in the member process. */
export const memberMcpWatcher = `
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { AsyncLocalStorage } from 'node:async_hooks'
export const name = 'phalanx-mcp-watch'
export const inject = ['loader', 'hmr', 'systemPrompt', 'profileContext']
export async function apply(ctx, config) {
  // Resolve through the CLI and web app dependency graphs in source and installed runtimes.
  const require = createRequire(process.argv[1])
  const webRequire = createRequire(require.resolve('@deepseek-ai/dsh-web-app'))
  const { readPluginInventory } = await import(pathToFileURL(webRequire.resolve('@deepseek-ai/dsh-host-plugin-inventory')))
  const { withFileLock, writeFileAtomic } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-atomic-write')))
  const { loadProfileDirectory, loadOptionalPatches, composeEntries, readProfilePatches, reconcileProfilePatches } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')))
  const configRequire = createRequire(webRequire.resolve('@deepseek-ai/dsh-plugin-manager'))
  const { parseDocument, isSeq, isMap, isScalar } = configRequire('yaml')
  const profile = ctx.profileContext, patch = join(profile.home, 'cordis.patch.yml'), lock = join(profile.dir, 'package.json')
  const marker = ' phalanx-mcp-yield:'
  const identity = (id, module) => marker + JSON.stringify([id, module])
  const flatten = rows => rows.flatMap(row => [row, ...(row.group && Array.isArray(row.config) ? flatten(row.config) : [])])
  const rebuilding = new AsyncLocalStorage()
  let applied, retryConfiguration
  let failedIds = new Set()
  const refresh = async () => {
    let acquired = false
    try {
      return await withFileLock(lock, async () => {
        acquired = true
        const next = await readFile(config.path, 'utf8'), desired = JSON.parse(next)
        const names = new Set(desired.map(row => row.config.serverName))
        let before
        try { before = await readFile(patch, 'utf8') } catch (error) { if (error.code !== 'ENOENT') throw error; before = '[]' }
        if (Buffer.byteLength(before) > 1024 * 1024) throw new Error('MCP coordination patch exceeds 1 MiB')
        const document = parseDocument(before, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] })
        if (document.errors.length || !isSeq(document.contents)) throw new Error('MCP coordination requires a valid patch sequence')
        let touched = false
        const owned = new Set()
        document.contents.items = document.contents.items.filter((row, index) => {
          if (!isMap(row)) return true
          const id = row.get('id', true)
          if (!isScalar(id) || !id.comment?.startsWith(marker)) return true
          touched = true
          if (row.items.length === 3 && typeof id.value === 'string' && typeof row.get('name') === 'string' && row.get('disabled') === true && id.comment === identity(id.value, row.get('name'))) { owned.add(index); return false }
          delete id.comment
          return true
        })
        const loaded = loadProfileDirectory('dsh', profile.dir, profile.installAnchor)
        const homePatches = (loadOptionalPatches('dsh', patch) ?? []).filter((_row, index) => !owned.has(index))
        const candidates = flatten(composeEntries([...loaded.layers.map(layer => layer.patches), loaded.patches, homePatches, profile.overlays]))
        for (const row of candidates) {
          if (row.name !== config.module && row.name !== pathToFileURL(config.module).href && row.name !== '@deepseek-ai/dsh-mcp-client') continue
          if (!names.has(row.config?.serverName) || row.disabled === true) continue
          const override = document.createNode({ id: row.id, name: row.name, disabled: true })
          override.get('id', true).comment = identity(row.id, row.name)
          document.contents.add(override); touched = true
        }
        const after = touched ? String(document) : before
        const include = [...ctx.loader.entries()].find(entry => entry.options.id === 'phalanx-mcp-include')
        if (!include?.subtree) throw new Error('Platform MCP Include is unavailable')
        const changed = (applied !== next && retryConfiguration !== next) || after !== before
        // Release old platform namespaces before restoring personal entries or changing names.
        if (changed) {
          applied = retryConfiguration = undefined
          failedIds = new Set()
          const stopping = [...include.subtree.entries()].flatMap(entry => entry.fiber ? [entry.fiber] : [])
          await include.subtree.root.update([])
          // Drain disposers even when a removed entry had an earlier activation error.
          await Promise.allSettled(stopping.map(fiber => fiber.await()))
        }
        if (after !== before) await writeFileAtomic(patch, after, { mode: 0o600 })
        await reconcileProfilePatches(ctx.root, readProfilePatches('dsh', profile), 'dsh')
        if (!changed && failedIds.size) {
          // Preserve healthy clients and their in-flight calls while retrying failed entries.
          const stopping = [...include.subtree.entries()].filter(entry => failedIds.has(entry.options.id)).flatMap(entry => entry.fiber ? [entry.fiber] : [])
          await include.subtree.root.update(desired.filter(row => !failedIds.has(row.id)))
          await Promise.allSettled(stopping.map(fiber => fiber.await()))
        }
        if (changed || failedIds.size) await include.subtree.root.update(desired)
        await ctx.loader.await()
        // Loader.await() settles errors; verify public fibers before caching this projection.
        const mounted = new Map([...include.subtree.entries()].map(entry => [entry.options.id, entry]))
        const active = new Set((await readPluginInventory(ctx)).entries.filter(row => row.fiberPhase === 'active').map(row => row.entryId))
        const started = await Promise.allSettled(desired.map(async row => {
          const entry = mounted.get(row.id), fiber = entry?.fiber
          if (!fiber) throw new Error('Platform MCP entry did not mount')
          await fiber.await()
          if (!active.has(entry.id)) throw new Error('Platform MCP entry is not active')
        }))
        failedIds = new Set(desired.filter((_row, index) => started[index].status === 'rejected').map(row => row.id))
        if (!failedIds.size) { applied = next; retryConfiguration = undefined }
        else { applied = undefined; retryConfiguration = next; ctx.logger.warn('Platform MCP initialization incomplete; failed entries will retry on the next turn') }
        return true
      }, { waitMs: 0 })
    } catch (error) {
      // Plugin Manager takes this lock before HMR; never wait for it while owning HMR.
      if (!acquired && error.message === 'atomic-write: timed out waiting for the writer lock at ' + lock + '.lock') return false
      throw error
    }
  }
  ctx.on('app-boot/config-reload', () => { applied = retryConfiguration = undefined })
  await ctx.hmr.watchConfig(config.path, refresh)
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    if (rebuilding.getStore()) return next()
    const deadline = Date.now() + 30000
    while (!await ctx.hmr.runExclusive(refresh)) {
      if (Date.now() >= deadline) throw new Error('MCP configuration is busy; retry this turn')
      await delay(20)
    }
    return rebuilding.run(true, () => ctx.systemPrompt.assemble(context))
  })
}
`
