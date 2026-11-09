import { expect, it, vi } from 'vitest'
import { expertConversationHandler, expertConversationPlugin } from '../src/dsh/expert-conversation.js'

it('creates a fresh expert conversation and applies only its session selection', async () => {
  const created: unknown[] = [],
    selected: unknown[] = []
  const handle = expertConversationHandler({
    create: async input => {
      created.push(input)
      return { sessionId: 'fresh', agentPreset: input.agentPreset }
    },
    select: async (id, selection) => {
      selected.push([id, selection])
    },
  })
  const request = (value: object) =>
    new Request('https://example.test/api/phalanx.expert-conversation', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(value),
    })
  const plan = { workspaceId: 'workspace', agentPreset: 'phalanx-expert-writer', model: { provider: 'phalanx-shared', model: 'chat' }, reasoningEffort: 'high' }
  expect(await (await handle(request(plan))).json()).toEqual({ sessionId: 'fresh' })
  expect(created).toEqual([{ workspaceId: 'workspace', agentPreset: 'phalanx-expert-writer' }])
  expect(selected).toEqual([['fresh', { provider: 'phalanx-shared', model: 'chat', reasoningEffort: 'high' }]])
  for (const value of [
    { ...plan, sessionId: 'existing' },
    { ...plan, agentPreset: 'standard' },
    { ...plan, reasoningEffort: 'max' },
    { ...plan, model: { ...plan.model, baseURL: 'https://other.test' } },
  ])
    expect((await handle(request(value))).status).toBe(400)
  expect(created).toHaveLength(1)
  expect(selected).toHaveLength(1)
})

it('runs the serialized native boundary against runtime model metadata without saving member defaults', async () => {
  let fetch!: (request: Request) => Promise<Response>
  let supportsReasoning = true
  const select = vi.fn(),
    saveSelection = vi.fn()
  const create = vi.fn(async (input: { agentPreset: string }) => ({ sessionId: 'fresh', agentPreset: input.agentPreset }))
  const scope = {
    effect: vi.fn(),
    connection: {
      fetch: {
        register: (route: { fetch: typeof fetch }) => {
          fetch = route.fetch
        },
      },
    },
    sessionController: { create, resolveAgent: async () => ({ agent: { model: { select } } }) },
    llm: {
      resolveModelInfo: async () => (supportsReasoning ? { reasoning: { efforts: [{ id: 'high' }] } } : {}),
      resolveCallConfig: vi.fn(async () => ({})),
    },
    agentDefaultModel: { saveSelection },
  }
  new Function('ctx', expertConversationPlugin)({ inject: (_services: string[], apply: (value: typeof scope) => void) => apply(scope) })
  const request = () =>
    new Request('https://example.test/api/phalanx.expert-conversation', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId: 'workspace',
        agentPreset: 'phalanx-expert-writer',
        model: { provider: 'phalanx-shared', model: 'chat' },
        reasoningEffort: 'high',
      }),
    })
  expect((await fetch(request())).status).toBe(200)
  expect(select).toHaveBeenLastCalledWith({ provider: 'phalanx-shared', model: 'chat', reasoningEffort: 'high' })
  supportsReasoning = false
  expect((await fetch(request())).status).toBe(200)
  expect(select).toHaveBeenLastCalledWith({ provider: 'phalanx-shared', model: 'chat' })
  expect(saveSelection).not.toHaveBeenCalled()
})
