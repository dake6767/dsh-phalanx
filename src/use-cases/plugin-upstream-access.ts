import { PluginUpstreamAccessError } from '../domain/plugin-upstream.js'
import type { CommunityAccountStorePort } from '../ports/community-accounts.js'
import type { CommunityModelAccessPort } from '../ports/community-model-access.js'
import type { PluginLibraryStorePort } from '../ports/plugin-library.js'
import type { PluginGrantsPort } from '../ports/managed-plugins.js'
import type { PluginUpstreamsPort } from '../ports/plugin-upstreams.js'

/** Admission is evaluated for every request, independently of running plugin snapshots. */
export class PluginUpstreamAccess {
  constructor(private readonly accounts: Pick<CommunityAccountStorePort, 'get' | 'listGroups'>,
    private readonly tokens: Pick<CommunityModelAccessPort, 'resolve'>,
    private readonly library: Pick<PluginLibraryStorePort, 'list'>,
    private readonly grants: Pick<PluginGrantsPort, 'get'>,
    private readonly upstreams: Pick<PluginUpstreamsPort, 'list'>, private readonly revision: string) {}
  authorize(packageName: string, name: string, headers: Readonly<Record<string, string | readonly string[] | undefined>>) {
    const upstream = this.upstreams.list(packageName).find(row => row.name === name)
    const templates = new Map(upstream?.headers.filter(row => row.value.includes('{credential}')).map(row => [row.name.toLowerCase(), row.value]) ?? [])
    const candidates = new Set<string>()
    for (const [header, values] of Object.entries(headers)) {
      const key = header.toLowerCase()
      const template = templates.get(key)
      if (key !== 'authorization' && key !== 'x-api-key' && template === undefined) continue
      for (const value of typeof values === 'string' ? [values] : values ?? []) {
        const bearer = key === 'authorization' ? /^Bearer\s+(.+)$/iu.exec(value)?.[1] : undefined
        if (bearer) candidates.add(bearer)
        else if (template !== undefined) {
          const marker = template.indexOf('{credential}')
          const before = template.slice(0, marker), after = template.slice(marker + 12)
          candidates.add(value.startsWith(before) && value.endsWith(after) ? value.slice(before.length, after ? -after.length : undefined) : value)
        } else candidates.add(value)
      }
    }
    if (candidates.size !== 1) throw new PluginUpstreamAccessError(401, 'A single valid member token is required')
    const identity = this.tokens.resolve([...candidates][0]!)
    const account = identity && this.accounts.get(identity.username)
    if (!identity || !account || identity.spaceId !== account.spaceId) throw new PluginUpstreamAccessError(401, 'Member token is invalid')
    if (account.disabled) throw new PluginUpstreamAccessError(403, 'Account is disabled')
    const plugin = this.library.list().find(row => row.packageName === packageName)
    if (!plugin || plugin.removing || plugin.incompatible || plugin.stage !== 'available' || plugin.current?.runtimeRevision !== this.revision) throw new PluginUpstreamAccessError(403, 'Plugin is unavailable or incompatible')
    const group = this.accounts.listGroups().find(row => row.id === account.groupId)
    if (!group || !(group.kind === 'admin' || this.grants.get(group.id).includes(packageName) || plugin.published)) throw new PluginUpstreamAccessError(403, 'Member is not authorized for this plugin')
    if (!upstream) throw new PluginUpstreamAccessError(404, 'Plugin upstream was not found')
    if (!upstream.credential) throw new PluginUpstreamAccessError(503, 'Plugin upstream credential is not configured')
    return { username: account.username, upstream }
  }
}
