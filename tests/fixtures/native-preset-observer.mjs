import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { setTimeout, clearTimeout } from 'node:timers'

// Acceptance observation through the public Session and tool service contracts.
export const name = 'native-preset-acceptance-observer'
export const inject = ['webServer', 'sessionController', 'tools', 'hmr', 'profileContext']
export function apply(ctx) {
  const captured = new Map()
  ctx.effect(() => () => {
    for (const toolSet of captured.values()) toolSet.dispose()
  })
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
            const page = await ctx.sessionController.events(
              { address: { kind: 'session', sessionId: input.sessionId }, maxMessages: 100 },
              AbortSignal.timeout(15000),
            )
            value = { events: page.records }
          } else {
            const result = await ctx.sessionController.resolveAgent(input.sessionId)
            if (result.error) value = { resumed: false, code: result.error.code, message: result.error.message }
            else if (input.operation === 'resume') value = { resumed: true }
            else if (input.operation === 'catalog') value = { names: result.agent.ctx.tools.schemas(result.agent).map(tool => tool.name) }
            else if (input.operation === 'capture-tools' || input.operation === 'refresh-tools') {
              const agent = result.agent
              const toolSet = await ctx.tools.resolve({ agent, modelSelection: agent.model.current(), signal: AbortSignal.timeout(15000) })
              value = { names: ctx.tools.schemas(agent, toolSet).map(tool => tool.name) }
              if (input.operation === 'capture-tools') {
                captured.get(input.sessionId)?.dispose()
                captured.set(input.sessionId, toolSet)
              } else toolSet.dispose()
            } else if (input.operation === 'execute-captured') {
              const toolSet = captured.get(input.sessionId)
              if (!toolSet) throw new Error('Missing captured admission')
              const restore = result.agent.ctx.on('tools/pre-execute', async () => ({ kind: 'allow' }), { prepend: true })
              try {
                value = (
                  await ctx.tools.execute({
                    agent: result.agent,
                    toolSet,
                    signal: AbortSignal.timeout(15000),
                    calls: [{ type: 'tool_call', id: 'captured-mcp', name: 'mcp__p-admission__probe', arguments: '{}' }],
                  })
                ).results[0].result
              } finally {
                restore()
                toolSet.dispose()
                captured.delete(input.sessionId)
              }
            } else if (input.operation === 'writer-lock-resolve') {
              const require = createRequire(process.argv[1])
              const { withFileLock } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-atomic-write')).href)
              const gate = Promise.withResolvers(),
                held = Promise.withResolvers(),
                observed = Promise.withResolvers()
              let released = false
              const release = () => {
                released = true
                gate.resolve()
              }
              const locked = withFileLock(
                join(ctx.profileContext.dir, 'package.json'),
                async () => {
                  held.resolve()
                  await gate.promise
                },
                { waitMs: 0 },
              )
              await held.promise
              const signal = AbortSignal.timeout(20000)
              const remove = ctx.on(
                'phalanx/before-tools-resolve',
                context => {
                  if (context.signal === signal) observed.resolve()
                },
                { global: true },
              )
              // Watchdog frees owned resources if the two locks are acquired in reverse order.
              const watchdog = setTimeout(release, 15000)
              const resolving = ctx.tools.resolve({ agent: result.agent, modelSelection: result.agent.model.current(), signal })
              void resolving.catch(() => {})
              try {
                await observed.promise
                await ctx.hmr.runExclusive(async () => {
                  value = { hmrReleasedBeforeWriter: !released }
                  release()
                })
                const toolSet = await resolving
                toolSet.dispose()
              } finally {
                clearTimeout(watchdog)
                remove()
                release()
                await locked
              }
            } else if (input.operation === 'cancel-resolve') {
              const gate = Promise.withResolvers(),
                entered = Promise.withResolvers(),
                observed = Promise.withResolvers()
              let released = false
              const release = () => {
                released = true
                gate.resolve()
              }
              const blocking = ctx.hmr.runExclusive(async () => {
                entered.resolve()
                await gate.promise
              })
              await entered.promise
              const controller = new globalThis.AbortController(),
                reason = new Error('Acceptance resolve cancellation')
              const remove = ctx.on(
                'phalanx/before-tools-resolve',
                context => {
                  if (context.signal === controller.signal) observed.resolve()
                },
                { global: true },
              )
              // Deadlock watchdog only; assertions concern event ordering, not duration.
              const watchdog = setTimeout(release, 15000)
              const resolving = ctx.tools.resolve({ agent: result.agent, modelSelection: result.agent.model.current(), signal: controller.signal })
              void resolving.catch(() => {})
              try {
                await observed.promise
                controller.abort(reason)
                try {
                  const toolSet = await resolving
                  toolSet.dispose()
                  value = { cancelledWhileBlocked: false }
                } catch (error) {
                  value = {
                    cancelledWhileBlocked: !released,
                    expectedReason: error === reason || (error instanceof AggregateError && error.errors.includes(reason)),
                  }
                }
              } finally {
                clearTimeout(watchdog)
                remove()
                release()
                await blocking
                await ctx.hmr.runExclusive(async () => {})
              }
            } else if (input.operation === 'fetch-guard') {
              const agent = result.agent
              let attempted = false
              const remove = agent.ctx.tools.register({
                name: 'web_fetch',
                description: 'Acceptance transport probe',
                parameters: {},
                output: { schema: { type: 'string' }, render: (_args, text) => [{ type: 'text', text }] },
                execute: async () => {
                  attempted = true
                  return (await fetch(input.url)).text()
                },
              })
              const restore = agent.ctx.on('tools/pre-execute', async () => ({ kind: 'allow' }), { prepend: true })
              try {
                const ptc = input.ptc === true
                const outcome = (
                  await ctx.tools.execute({
                    calls: [
                      {
                        type: 'tool_call',
                        id: 'fetch-policy-probe',
                        name: ptc ? 'run_code' : 'web_fetch',
                        arguments: ptc ? JSON.stringify({ code: 'await tools.web_fetch({})', description: 'Verify deployment fetch policy' }) : '{}',
                      },
                    ],
                    agent,
                    signal: AbortSignal.timeout(15000),
                  })
                ).results[0].result
                value = { outcome, attempted }
              } finally {
                restore()
                remove()
              }
            } else if (input.operation === 'tool')
              value = (
                await ctx.tools.execute({
                  calls: [
                    {
                      type: 'tool_call',
                      id: 'preset-fixture-tool',
                      name: 'bash',
                      arguments: JSON.stringify({
                        command: "printf 'PRESET_EXPERT_TOOL_OK\\n'",
                        description: 'Verify independent expert tools',
                        timeoutMs: 10000,
                      }),
                    },
                  ],
                  agent: result.agent,
                  signal: AbortSignal.timeout(15000),
                })
              ).results[0].result
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
