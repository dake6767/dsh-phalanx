import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { CommunityProviderProtocol } from '../../src/domain/admin-contract.js'

/** One recorded upstream request; credentials are asserted, never reused. */
export interface RecordedModelRequest {
  readonly protocol: CommunityProviderProtocol
  readonly path: string
  readonly apiKey?: string
  readonly authorization?: string
  readonly anthropicVersion?: string
  readonly body: Record<string, unknown>
}

const endpoints: Readonly<Record<CommunityProviderProtocol, { suffix: string; marker: string; stream: string; json: string }>> = {
  'anthropic-messages': {
    suffix: '/v1/messages',
    marker: 'PROTOCOL_MESSAGES_READY',
    stream:
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_fixture","usage":{"input_tokens":10,"output_tokens":0,"cache_read_input_tokens":2,"cache_creation_input_tokens":3}}}\n\n' +
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"PROTOCOL_MESSAGES_READY"}}\n\n' +
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5,"input_tokens":null,"cache_read_input_tokens":2,"cache_creation_input_tokens":3}}\n\n' +
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    json: JSON.stringify({
      id: 'msg_fixture',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'PROTOCOL_MESSAGES_READY' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 3 },
    }),
  },
  'openai-completions': {
    suffix: '/chat/completions',
    marker: 'PROTOCOL_CHAT_READY',
    stream:
      'data: {"id":"chatcmpl_fixture","object":"chat.completion.chunk","created":1700000000,"model":"deepseek-flash","choices":[{"index":0,"delta":{"role":"assistant","content":"PROTOCOL_CHAT_READY"},"finish_reason":null}],"usage":null}\n\n' +
      'data: {"id":"chatcmpl_fixture","object":"chat.completion.chunk","created":1700000000,"model":"deepseek-flash","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":null}\n\n' +
      'data: {"id":"chatcmpl_fixture","object":"chat.completion.chunk","created":1700000000,"model":"deepseek-flash","choices":[],"usage":{"prompt_tokens":9,"completion_tokens":4,"total_tokens":13,"prompt_tokens_details":{"cached_tokens":2}}}\n\n' +
      'data: [DONE]\n\n',
    json: JSON.stringify({
      id: 'chatcmpl_fixture',
      object: 'chat.completion',
      created: 1700000000,
      model: 'deepseek-flash',
      choices: [{ index: 0, message: { role: 'assistant', content: 'PROTOCOL_CHAT_READY' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13, prompt_tokens_details: { cached_tokens: 2 } },
    }),
  },
  'openai-responses': {
    suffix: '/responses',
    marker: 'PROTOCOL_RESPONSES_READY',
    stream:
      'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_fixture","status":"in_progress","model":"deepseek-flash"}}\n\n' +
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_fixture","status":"in_progress","role":"assistant","content":[]}}\n\n' +
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"msg_fixture","output_index":0,"content_index":0,"delta":"PROTOCOL_RESPONSES_READY"}\n\n' +
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","id":"msg_fixture","status":"completed","role":"assistant","content":[{"type":"output_text","text":"PROTOCOL_RESPONSES_READY","annotations":[]}]}}\n\n' +
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_fixture","status":"completed","model":"deepseek-flash","usage":{"input_tokens":11,"output_tokens":6,"total_tokens":17,"input_tokens_details":{"cached_tokens":4}}}}\n\n',
    json: JSON.stringify({
      id: 'resp_fixture',
      object: 'response',
      status: 'completed',
      model: 'deepseek-flash',
      output: [
        {
          type: 'message',
          id: 'msg_fixture',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'PROTOCOL_RESPONSES_READY', annotations: [] }],
        },
      ],
      usage: { input_tokens: 11, output_tokens: 6, total_tokens: 17, input_tokens_details: { cached_tokens: 4 } },
    }),
  },
}

/** Fake upstream for the previewed protocols; records routing facts and replays deterministic responses. */
export async function startSharedModelProtocols() {
  const requests: RecordedModelRequest[] = []
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array))
      const url = request.url ?? '/'
      const protocol = (Object.keys(endpoints) as CommunityProviderProtocol[]).find(key => url.endsWith(endpoints[key].suffix))
      if (protocol === undefined) {
        response.writeHead(404).end('Unknown fixture protocol path')
        return
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      requests.push({
        protocol,
        path: url,
        ...(typeof request.headers['x-api-key'] === 'string' ? { apiKey: request.headers['x-api-key'] } : {}),
        ...(typeof request.headers.authorization === 'string' ? { authorization: request.headers.authorization } : {}),
        ...(typeof request.headers['anthropic-version'] === 'string' ? { anthropicVersion: request.headers['anthropic-version'] } : {}),
        body,
      })
      const fixture = endpoints[protocol]
      if (body.stream === false) {
        response.setHeader('content-type', 'application/json')
        response.end(fixture.json)
        return
      }
      response.setHeader('content-type', 'text/event-stream; charset=utf-8')
      response.end(fixture.stream)
    })().catch(() => response.destroy())
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    marker: (protocol: CommunityProviderProtocol) => endpoints[protocol].marker,
    suffix: (protocol: CommunityProviderProtocol) => endpoints[protocol].suffix,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}
