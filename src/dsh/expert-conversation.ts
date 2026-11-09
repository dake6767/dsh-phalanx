export interface ExpertConversationHost {
  create(input: { workspaceId: string; agentPreset: string }): Promise<{ sessionId: string; agentPreset?: string }>
  select(sessionId: string, selection: { provider: string; model: string; reasoningEffort?: string }, signal: AbortSignal): Promise<void>
}

/** Authenticated native launch only: no existing session, file path or default-model mutation. */
export function expertConversationHandler(host: ExpertConversationHost) {
  return async (request: Request): Promise<Response> => {
    const failure = {
      reply(status: number) {
        return Response.json({ error: 'Expert conversation is unavailable.' }, { status })
      },
    }
    try {
      if (request.method !== 'POST') return failure.reply(405)
      if (!/^application\/json(?:;|$)/iu.test(request.headers.get('content-type') ?? '')) return failure.reply(400)
      const raw = await request.text()
      if (raw.length > 8192) return failure.reply(400)
      const input = JSON.parse(raw)
      if (
        !input ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        Object.keys(input).some(key => !['workspaceId', 'agentPreset', 'model', 'reasoningEffort'].includes(key)) ||
        typeof input.workspaceId !== 'string' ||
        !input.workspaceId ||
        input.workspaceId.length > 256 ||
        typeof input.agentPreset !== 'string' ||
        !/^phalanx-expert-[a-z0-9-]{1,128}$/u.test(input.agentPreset) ||
        (input.reasoningEffort !== undefined && !['off', 'low', 'medium', 'high'].includes(input.reasoningEffort)) ||
        (input.model !== null &&
          (!input.model ||
            typeof input.model !== 'object' ||
            Array.isArray(input.model) ||
            Object.keys(input.model).some(key => !['provider', 'model'].includes(key)) ||
            typeof input.model.provider !== 'string' ||
            !/^phalanx-/u.test(input.model.provider) ||
            input.model.provider.length > 256 ||
            typeof input.model.model !== 'string' ||
            !input.model.model ||
            input.model.model.length > 256))
      )
        return failure.reply(400)
      request.signal.throwIfAborted()
      const created = await host.create({ workspaceId: input.workspaceId, agentPreset: input.agentPreset })
      request.signal.throwIfAborted()
      if (created.agentPreset !== input.agentPreset) return failure.reply(409)
      if (input.model)
        await host.select(
          created.sessionId,
          { ...input.model, ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }) },
          request.signal,
        )
      return Response.json({ sessionId: created.sessionId }, { headers: { 'cache-control': 'no-store' } })
    } catch {
      return failure.reply(409)
    }
  }
}

/** Native connection fetch applies login authorization before invoking this route. */
export const expertConversationPlugin = `
  ctx.inject(['connection', 'sessionController', 'llm'], scope => {
    const lifetime = new AbortController();
    scope.effect(() => () => lifetime.abort());
    const handler = (${expertConversationHandler.toString()})({
      create: input => scope.sessionController.create(input),
      select: async (sessionId, selection, signal) => {
        const model = await scope.llm.resolveModelInfo(selection.provider, selection.model, signal);
        if (!model.reasoning?.efforts.some(row => row.id === selection.reasoningEffort)) delete selection.reasoningEffort;
        await scope.llm.resolveCallConfig(selection, signal);
        signal.throwIfAborted();
        const result = await scope.sessionController.resolveAgent(sessionId);
        if (result.error) throw result.error;
        signal.throwIfAborted();
        result.agent.model.select(selection);
      },
    });
    scope.connection.fetch.register({ path: '/api/phalanx.expert-conversation', methods: ['POST'], requestBody: 'buffered', fetch: request => handler(new Request(request, { signal: AbortSignal.any([request.signal, lifetime.signal]) })) });
  });
`
