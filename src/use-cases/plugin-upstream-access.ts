import { combineAcquisitionSources } from '../domain/acquisition-sources.js'
import { PluginUpstreamAccessError, type PluginUpstream } from '../domain/plugin-upstream.js'
import type { UsageMember } from '../domain/usage-record.js'
import type { CommunityAccountRegistration, CommunityAccountStorePort } from '../ports/community-accounts.js'
import type { CommunityModelAccessPort } from '../ports/community-model-access.js'
import type { CommunityRuntimePort } from '../ports/community-runtime.js'
import type { ExpertPluginsPort } from '../ports/experts.js'
import type { PluginGrantsPort } from '../ports/managed-plugins.js'
import type { PluginAuthorizationViewPort, PluginLibraryStorePort } from '../ports/plugin-library.js'
import type { PluginUpstreamsPort } from '../ports/plugin-upstreams.js'
import type { PluginLocalCopies } from './plugin-local-copies.js'

/** Admission is evaluated for every request, independently of running plugin snapshots. */
export class PluginUpstreamAccess {
  constructor(
    private readonly accounts: Pick<CommunityAccountStorePort, 'get' | 'listGroups' | 'withCurrentState'>,
    private readonly tokens: Pick<CommunityModelAccessPort, 'resolve'>,
    private readonly library: Pick<PluginLibraryStorePort, 'list'> & PluginAuthorizationViewPort,
    private readonly grants: Pick<PluginGrantsPort, 'get'> & PluginAuthorizationViewPort,
    private readonly upstreams: Pick<PluginUpstreamsPort, 'list' | 'authorizationRevision'>,
    private readonly revision: string,
    private readonly localCopies?: Pick<PluginLocalCopies, 'enabled' | 'revision'>,
    private readonly runtime?: Pick<CommunityRuntimePort, 'status'>,
    private readonly experts?: ExpertPluginsPort,
  ) {}
  async authorize(
    packageName: string,
    name: string,
    headers: Readonly<Record<string, string | readonly string[] | undefined>>,
    identified?: (member: UsageMember) => void,
  ) {
    const admission = await this.admission(packageName, name, headers, identified)
    return await this.commit(packageName, admission, username => ({ username, upstream: admission.upstream }))
  }
  async register<T>(
    packageName: string,
    name: string,
    headers: Readonly<Record<string, string | readonly string[] | undefined>>,
    register: (
      grant: { readonly username: string; readonly upstream: PluginUpstream },
      onAbort: (cleanup: () => void) => void,
    ) => ReturnType<CommunityAccountRegistration<T>>,
  ) {
    const admission = await this.admission(packageName, name, headers)
    return await this.commit(packageName, admission, (username, onAbort) => register({ username, upstream: admission.upstream }, onAbort))
  }
  private async commit<T>(
    packageName: string,
    admission: Awaited<ReturnType<PluginUpstreamAccess['admission']>>,
    register: (username: string, onAbort: (cleanup: () => void) => void) => ReturnType<CommunityAccountRegistration<T>>,
  ): Promise<T> {
    const undo: (() => void)[] = []
    try {
      const result = await this.accounts.withCurrentState<T>(admission.account.username, (account, onAbort) => {
        const identity = this.tokens.resolve(admission.token)
        const state = this.runtime?.status(admission.account.username)
        if (
          !identity ||
          !account ||
          identity.username !== account.username ||
          identity.spaceId !== account.spaceId ||
          account.disabled ||
          account.spaceId !== admission.account.spaceId ||
          account.sessionEpoch !== admission.account.sessionEpoch ||
          account.groupId !== admission.account.groupId ||
          account.admin !== admission.account.admin ||
          this.policySnapshot(packageName) !== admission.policy ||
          (admission.instance && (!(state?.state === 'ready' || state?.state === 'draining') || state.instance !== admission.instance))
        )
          throw new PluginUpstreamAccessError(403, 'Plugin access changed during admission')
        return register(account.username, cleanup => {
          let active = true
          const once = () => {
            if (active) {
              active = false
              cleanup()
            }
          }
          undo.push(once)
          onAbort(once)
        })
      })
      if (this.policySnapshot(packageName) !== admission.policy) throw new PluginUpstreamAccessError(403, 'Plugin access changed during admission')
      return result
    } catch (error) {
      for (const cleanup of undo.reverse()) cleanup()
      throw error
    }
  }
  private policySnapshot(packageName: string): string {
    const experts = this.experts ? (this.experts.authorizationSnapshot?.() ?? this.experts.version?.()) : null
    if ((this.experts && experts === undefined) || (experts !== null && typeof experts === 'object' && 'then' in experts))
      throw new PluginUpstreamAccessError(403, 'Plugin authorization cannot be observed')
    return JSON.stringify([
      this.library.authorizationRevision(),
      this.upstreamRevision(packageName),
      this.grants.authorizationRevision(),
      this.localCopies?.revision(),
      experts,
    ])
  }
  private upstreamRevision(packageName: string): unknown {
    if (this.upstreams.authorizationRevision) return this.upstreams.authorizationRevision(packageName)
    const value = this.upstreams.list(packageName)
    if ('then' in value) throw new PluginUpstreamAccessError(403, 'Plugin authorization cannot be observed')
    return value
  }
  private async admission(
    packageName: string,
    name: string,
    headers: Readonly<Record<string, string | readonly string[] | undefined>>,
    identified?: (member: UsageMember) => void,
  ) {
    const policy = this.policySnapshot(packageName)
    const upstream = (await this.upstreams.list(packageName)).find(row => row.name === name)
    const templates = new Map(upstream?.headers.filter(row => row.value.includes('{credential}')).map(row => [row.name.toLowerCase(), row.value]) ?? [])
    const candidates = new Set<string>()
    for (const [header, values] of Object.entries(headers)) {
      const key = header.toLowerCase()
      const template = templates.get(key)
      if (key !== 'authorization' && key !== 'x-api-key' && template === undefined) continue
      for (const value of typeof values === 'string' ? [values] : (values ?? [])) {
        const bearer = key === 'authorization' ? /^Bearer\s+(.+)$/iu.exec(value)?.[1] : undefined
        if (bearer) candidates.add(bearer)
        else if (template !== undefined) {
          const marker = template.indexOf('{credential}')
          const before = template.slice(0, marker),
            after = template.slice(marker + 12)
          candidates.add(value.startsWith(before) && value.endsWith(after) ? value.slice(before.length, after ? -after.length : undefined) : value)
        } else candidates.add(value)
      }
    }
    if (candidates.size !== 1) throw new PluginUpstreamAccessError(401, 'A single valid member token is required')
    const token = [...candidates][0]!
    const identity = this.tokens.resolve(token)
    const account = identity && (await this.accounts.get(identity.username))
    if (!identity || !account || identity.spaceId !== account.spaceId) throw new PluginUpstreamAccessError(401, 'Member token is invalid')
    identified?.({ username: account.username, groupId: account.groupId })
    if (account.disabled) throw new PluginUpstreamAccessError(403, 'Account is disabled')
    const plugin = (await this.library.list()).find(row => row.packageName === packageName)
    if (!plugin || plugin.removing || plugin.incompatible || plugin.stage !== 'available' || plugin.current?.runtimeRevision !== this.revision)
      throw new PluginUpstreamAccessError(403, 'Plugin is unavailable or incompatible')
    const running = this.runtime?.status(account.username)
    if (this.runtime && (!running || (running.state !== 'ready' && running.state !== 'draining') || !running.instance.localPluginSnapshot))
      throw new PluginUpstreamAccessError(403, 'Member instance is not ready for plugin credentials')
    if (
      (await this.localCopies?.enabled(account.username, packageName)) ||
      ((running?.state === 'ready' || running?.state === 'draining') && running.instance.localPluginSnapshot?.includes(packageName))
    )
      throw new PluginUpstreamAccessError(403, 'Local copies do not receive platform credentials')
    const group = (await this.accounts.listGroups()).find(row => row.id === account.groupId)
    // Published plugins already admit all members at this gateway, independently of startup selection.
    const acquired = combineAcquisitionSources([
      { source: 'managed', names: !group ? [] : await this.grants.get(group.id) },
      { source: 'selected', names: plugin.published ? [packageName] : [] },
      { source: 'managed', names: (await this.experts?.plugins(account.username))?.map(row => row.packageName) ?? [] },
    ])
    if (!group || !acquired.has(packageName)) throw new PluginUpstreamAccessError(403, 'Member is not authorized for this plugin')
    if (!upstream) throw new PluginUpstreamAccessError(404, 'Plugin upstream was not found')
    if (upstream.secretUnavailable) throw new PluginUpstreamAccessError(503, 'Plugin upstream secret cannot be decrypted; configure it again')
    if (!upstream.credential) throw new PluginUpstreamAccessError(503, 'Plugin upstream credential is not configured')
    return {
      account,
      upstream,
      token,
      policy,
      instance: running?.state === 'ready' || running?.state === 'draining' ? running.instance : undefined,
    }
  }
}
