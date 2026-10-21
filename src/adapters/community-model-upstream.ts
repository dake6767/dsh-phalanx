import { modelUpstreamUrl, modelUpstreamHeaders } from '../dsh/model-protocol.js'
import type { CommunityModelUpstreamPort } from '../ports/community-model-upstream.js'
import type { SharedModelStorePort } from '../ports/shared-models.js'
import { enabledSharedModels } from '../domain/shared-models.js'
import { CommunityModelRouteError } from '../domain/community-model.js'
import { messagesUpstreamUrl } from '../dsh/model-protocol.js'

/** Static deployer credential is supplied only to this outgoing transport. */
export class StaticCommunityModelUpstream implements CommunityModelUpstreamPort {
  private readonly url: URL
  constructor(baseUrl: string, private readonly apiKey: string) { this.url = modelUpstreamUrl(baseUrl) }
  async sendMessages(body: Readonly<Record<string, unknown>>, accept: string, signal: AbortSignal): Promise<Response> {
    return await fetch(this.url, { method: 'POST', redirect: 'error', signal, body: JSON.stringify(body),
      headers: modelUpstreamHeaders(this.apiKey, accept) })
  }
}

/** Select a detached provider snapshot at request admission, preserving in-flight calls. */
export class SharedCommunityModelUpstream implements CommunityModelUpstreamPort {
  constructor(private readonly store: Pick<SharedModelStorePort, 'read'>) {}
  async sendMessages(body: Readonly<Record<string, unknown>>, accept: string, signal: AbortSignal): Promise<Response> {
    const state = this.store.read()
    const selected = enabledSharedModels(state).find(row => row.model.id === body.model)
    if (selected === undefined) throw new CommunityModelRouteError(state.providers.length === 0 ? 'unconfigured' : 'unavailable')
    return await fetch(messagesUpstreamUrl(selected.provider.baseUrl), { method: 'POST', redirect: 'error', signal,
      body: JSON.stringify({ ...body, model: selected.model.name }), headers: modelUpstreamHeaders(selected.provider.apiKey, accept) })
  }
}
