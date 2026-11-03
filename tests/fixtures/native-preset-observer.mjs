// Acceptance observation through the public Session and tool service contracts.
export const name = 'native-preset-acceptance-observer'
export const inject = ['webServer', 'sessionController', 'tools']
export function apply(ctx) {
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/preset-fixture',
      handler: async (request, response) => {
        try {
          let raw = ''
          for await (const chunk of request) raw += chunk
          const input = JSON.parse(raw)
          let value
          if (input.operation === 'inspect') {
            const state = await ctx.sessionController.inspect(input.sessionId)
            value = { events: state.events, meta: state.meta }
          } else {
            const result = await ctx.sessionController.resolveAgent(input.sessionId)
            if (result.error) value = { resumed: false, code: result.error.code, message: result.error.message }
            else if (input.operation === 'resume') value = { resumed: true }
            else if (input.operation === 'tool')
              value = await ctx.tools.execute({
                callId: 'preset-fixture-tool',
                name: 'bash',
                arguments: { command: "printf 'PRESET_EXPERT_TOOL_OK\\n'", description: 'Verify independent expert tools', timeoutMs: 10000 },
                agent: result.agent,
                signal: AbortSignal.timeout(15000),
              })
            else throw new Error('Unknown fixture operation')
          }
          response.setHeader('content-type', 'application/json')
          response.end(JSON.stringify(value))
        } catch (error) {
          response.statusCode = 500
          response.end(JSON.stringify({ error: String(error) }))
        }
      },
    }),
  )
}
