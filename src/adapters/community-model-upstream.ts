import { modelUpstreamHeaders, modelUpstreamUrl, sharedModelUpstreamHeaders, sharedModelUpstreamUrl } from '../dsh/model-protocol.js'
import type { CommunityModelUpstreamPort } from '../ports/community-model-upstream.js'
import type { SharedModelStorePort } from '../ports/shared-models.js'
import type { CommunityProviderProtocol } from '../domain/admin-contract.js'
import { enabledSharedModels } from '../domain/shared-models.js'
import { CommunityModelRouteError } from '../domain/community-model.js'

/** Static deployer credential is supplied only to this outgoing transport. */
export class StaticCommunityModelUpstream implements CommunityModelUpstreamPort {
  private readonly url: URL
  constructor(
    baseUrl: string,
    private readonly apiKey: string,
  ) {
    this.url = modelUpstreamUrl(baseUrl)
  }
  async send(body: Readonly<Record<string, unknown>>, accept: string, protocol: CommunityProviderProtocol, signal: AbortSignal): Promise<Response> {
    // The retired default route always carried the Messages shape.
    if (protocol !== 'anthropic-messages') throw new CommunityModelRouteError('unavailable')
    return await fetch(this.url, { method: 'POST', redirect: 'error', signal, body: JSON.stringify(body), headers: modelUpstreamHeaders(this.apiKey, accept) })
  }
}

/** Select a detached provider snapshot at request admission, preserving in-flight calls. */
export class SharedCommunityModelUpstream implements CommunityModelUpstreamPort {
  constructor(private readonly store: Pick<SharedModelStorePort, 'read'>) {}
  async send(body: Readonly<Record<string, unknown>>, accept: string, protocol: CommunityProviderProtocol, signal: AbortSignal): Promise<Response> {
    const state = this.store.read()
    const selected = enabledSharedModels(state).find(row => row.model.id === body.model)
    if (selected === undefined) throw new CommunityModelRouteError(state.providers.length === 0 ? 'unconfigured' : 'unavailable')
    // The request shape is decided by the DSH provider `api`; a supplier configured for another protocol cannot serve it.
    if (selected.provider.apiFormat !== protocol) throw new CommunityModelRouteError('unavailable')
    return await fetch(sharedModelUpstreamUrl(selected.provider.baseUrl, protocol), {
      method: 'POST',
      redirect: 'error',
      signal,
      body: JSON.stringify({ ...body, model: selected.model.name }),
      headers: sharedModelUpstreamHeaders(protocol, selected.provider.apiKey, accept),
    })
  }
}
