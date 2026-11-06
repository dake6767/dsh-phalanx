import { modelAuthority } from './support/account-state.js'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, expect, it } from 'vitest'
import { SharedCommunityModelUpstream } from '../src/adapters/community-model-upstream.js'
import { MODEL_GATEWAY_PATH } from '../src/dsh/model-protocol.js'
import { createCommunityModelGateway } from '../src/inbound/community-model-gateway.js'
import type { SharedModelState } from '../src/domain/shared-models.js'

const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
const listen = async (server: Server) => {
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

it('routes identical model names independently and preserves an admitted stream when supply changes', async () => {
  const seen: { path: string; key: string; model: string }[] = []
  let finish!: () => void
  const upstream = await listen(
    createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        const body = JSON.parse(Buffer.concat(chunks).toString()) as { model: string }
        seen.push({ path: request.url!, key: request.headers['x-api-key'] as string, model: body.model })
        response.setHeader('content-type', 'text/event-stream')
        response.write('data: started\n\n')
        if (request.url === '/coding/v1/messages') finish = () => response.end('data: finished\n\n')
        else response.end('data: second-provider\n\n')
      })()
    }),
  )
  let state: SharedModelState = {
    revision: 1,
    defaultModelId: 'first-model',
    providers: [
      {
        id: 'first',
        name: 'First',
        baseUrl: `${upstream}/coding`,
        apiFormat: 'anthropic-messages',
        apiKey: 'first-key',
        enabled: true,
        models: [{ id: 'first-model', name: 'same-name', enabled: true, input: 'text' }],
      },
      {
        id: 'second',
        name: 'Second',
        baseUrl: `${upstream}/other`,
        apiFormat: 'anthropic-messages',
        apiKey: 'second-key',
        enabled: true,
        models: [{ id: 'second-model', name: 'same-name', enabled: true, input: 'text' }],
      },
    ],
  }
  const handle = createCommunityModelGateway({
    authorization: modelAuthority(async () => 'member'),
    connections: { track: () => {}, untrack: () => {} },
    upstream: new SharedCommunityModelUpstream({ read: () => state }),
  })
  const origin = await listen(
    createServer((request, response) => {
      void handle(request, response)
    }),
  )
  const call = (model: string) =>
    fetch(origin + MODEL_GATEWAY_PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, stream: true }) })
  const admitted = await call('first-model')
  const reader = admitted.body!.getReader()
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('started')
  state = { ...state, revision: 2, defaultModelId: 'second-model', providers: state.providers.filter(provider => provider.id !== 'first') }
  const denied = await call('first-model')
  expect(denied.status).toBe(403)
  expect(await denied.text()).toContain('Select an enabled shared model')
  finish()
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('finished')
  expect((await reader.read()).done).toBe(true)
  expect(await (await call('second-model')).text()).toContain('second-provider')
  expect(seen).toEqual([
    { path: '/coding/v1/messages', key: 'first-key', model: 'same-name' },
    { path: '/other/v1/messages', key: 'second-key', model: 'same-name' },
  ])
})

it('accepts the already parsed Messages object and serializes the routed bytes once', async () => {
  let captured = ''
  const upstream = await listen(
    createServer((request, response) => {
      void (async () => {
        for await (const chunk of request) captured += String(chunk)
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end('{}')
      })()
    }),
  )
  const state: SharedModelState = {
    revision: 1,
    defaultModelId: 'logical-id',
    providers: [
      {
        id: 'provider',
        name: 'Provider',
        baseUrl: upstream,
        apiFormat: 'anthropic-messages',
        apiKey: 'fixture',
        enabled: true,
        models: [{ id: 'logical-id', name: 'upstream-name', enabled: true, input: 'text' }],
      },
    ],
  }
  const transport = new SharedCommunityModelUpstream({ read: () => state })
  const response = await transport.send(
    { model: 'logical-id', messages: [{ role: 'user', content: 'hello' }], stream: true, temperature: 0 },
    'text/event-stream',
    'anthropic-messages',
    new AbortController().signal,
  )
  await response.text()
  expect(captured).toBe('{"model":"upstream-name","messages":[{"role":"user","content":"hello"}],"stream":true,"temperature":0}')
})

it('routes each supplier protocol to its upstream endpoint and authentication header', async () => {
  const seen: { path: string; authorization: string | undefined; apiKey: string | undefined; anthropicVersion: string | undefined; body: unknown }[] = []
  const upstream = await listen(
    createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array))
        seen.push({
          path: request.url!,
          authorization: request.headers.authorization,
          apiKey: request.headers['x-api-key'] as string | undefined,
          anthropicVersion: request.headers['anthropic-version'] as string | undefined,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
        })
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ forwarded: request.url }))
      })()
    }),
  )
  const state: SharedModelState = {
    revision: 1,
    defaultModelId: 'messages-model',
    providers: [
      {
        id: 'messages',
        name: 'Messages',
        baseUrl: `${upstream}/messages`,
        apiFormat: 'anthropic-messages',
        apiKey: 'messages-key',
        enabled: true,
        models: [{ id: 'messages-model', name: 'upstream-messages', enabled: true, input: 'text' }],
      },
      {
        id: 'completions',
        name: 'Completions',
        baseUrl: `${upstream}/v1`,
        apiFormat: 'openai-completions',
        apiKey: 'completions-key',
        enabled: true,
        models: [{ id: 'completions-model', name: 'upstream-completions', enabled: true, input: 'text' }],
      },
      {
        id: 'responses',
        name: 'Responses',
        baseUrl: `${upstream}/prefix`,
        apiFormat: 'openai-responses',
        apiKey: 'responses-key',
        enabled: true,
        models: [{ id: 'responses-model', name: 'upstream-responses', enabled: true, input: 'text' }],
      },
    ],
  }
  const handle = createCommunityModelGateway({
    authorization: modelAuthority(async () => 'member'),
    connections: { track: () => {}, untrack: () => {} },
    upstream: new SharedCommunityModelUpstream({ read: () => state }),
  })
  const origin = await listen(
    createServer((request, response) => {
      void handle(request, response)
    }),
  )
  const call = async (path: string, body: object, headers: Record<string, string> = {}) =>
    await fetch(`${origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
  const messages = { model: 'messages-model', max_tokens: 8, messages: [{ role: 'user', content: 'hello' }], stream: true }
  const completions = { model: 'completions-model', max_tokens: 8, messages: [{ role: 'user', content: 'hello' }], stream: true }
  const responses = { model: 'responses-model', max_output_tokens: 8, input: 'hello', stream: true }
  expect((await call('/_dsh-phalanx/model/v1/messages', messages)).status).toBe(200)
  expect((await call('/_dsh-phalanx/model/chat/completions', completions)).status).toBe(200)
  expect((await call('/_dsh-phalanx/model/responses', responses)).status).toBe(200)
  expect(seen).toEqual([
    {
      path: '/messages/v1/messages',
      apiKey: 'messages-key',
      authorization: undefined,
      anthropicVersion: '2023-06-01',
      body: { ...messages, model: 'upstream-messages' },
    },
    {
      path: '/v1/chat/completions',
      authorization: 'Bearer completions-key',
      apiKey: undefined,
      anthropicVersion: undefined,
      body: { ...completions, model: 'upstream-completions' },
    },
    {
      path: '/prefix/responses',
      authorization: 'Bearer responses-key',
      apiKey: undefined,
      anthropicVersion: undefined,
      body: { ...responses, model: 'upstream-responses' },
    },
  ])
})

it('accepts a bearer member token on OpenAI protocol routes and refuses a supplier protocol mismatch', async () => {
  let upstreamCalls = 0
  const upstream = await listen(
    createServer((_request, response) => {
      upstreamCalls++
      response.setHeader('content-type', 'text/event-stream')
      response.end('data: {"usage":{"prompt_tokens":1,"completion_tokens":1,"prompt_tokens_details":{"cached_tokens":0}}}\n\ndata: [DONE]\n\n')
    }),
  )
  const state: SharedModelState = {
    revision: 1,
    defaultModelId: 'messages-model',
    providers: [
      {
        id: 'messages',
        name: 'Messages',
        baseUrl: upstream,
        apiFormat: 'anthropic-messages',
        apiKey: 'messages-key',
        enabled: true,
        models: [{ id: 'messages-model', name: 'upstream-messages', enabled: true, input: 'text' }],
      },
      {
        id: 'completions',
        name: 'Completions',
        baseUrl: upstream,
        apiFormat: 'openai-completions',
        apiKey: 'completions-key',
        enabled: true,
        models: [{ id: 'completions-model', name: 'upstream-completions', enabled: true, input: 'text' }],
      },
    ],
  }
  const { CommunityModelAccessError } = await import('../src/domain/community-model.js')
  const handle = createCommunityModelGateway({
    authorization: modelAuthority(async header => {
      if (header !== 'member-token') throw new CommunityModelAccessError('unauthenticated')
      return 'member'
    }),
    connections: { track: () => {}, untrack: () => {} },
    upstream: new SharedCommunityModelUpstream({ read: () => state }),
  })
  const origin = await listen(
    createServer((request, response) => {
      void handle(request, response)
    }),
  )
  const call = (path: string, headers: Record<string, string>, model = 'completions-model') =>
    fetch(`${origin}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ model, messages: [] }),
    })
  expect((await call('/_dsh-phalanx/model/chat/completions', { authorization: 'Bearer member-token' })).status).toBe(200)
  expect((await call('/_dsh-phalanx/model/chat/completions', { 'x-api-key': 'member-token' })).status).toBe(200)
  expect((await call('/_dsh-phalanx/model/chat/completions', { authorization: 'Bearer wrong-token' })).status).toBe(401)
  const before = upstreamCalls
  // The model belongs to an Anthropic Messages supplier, so a Chat Completions request must not reach any upstream.
  expect((await call('/_dsh-phalanx/model/chat/completions', { 'x-api-key': 'member-token' }, 'messages-model')).status).toBe(403)
  expect(upstreamCalls).toBe(before)
  expect((await call('/_dsh-phalanx/model/unknown', { 'x-api-key': 'member-token' })).status).toBe(404)
})
