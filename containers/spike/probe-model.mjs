// Deterministic Anthropic Messages fixture for the container sandbox spike.
// Standalone: no dependencies. Mirrors the SSE shapes used by the dsh-phalanx E2E
// deterministic model so the pinned DSH revision drives a real bash tool call.
import { createServer } from 'node:http'

const PORT = Number(process.env.SPIKE_MODEL_PORT ?? '8787')
const KEY = process.env.SPIKE_MODEL_KEY ?? 'spike-fixture-key'

const INSIDE_COMMAND = "printf 'SPIKE_INSIDE_FILE\\n' > inside.txt && cat inside.txt"
const OUTSIDE_COMMAND = "printf 'SPIKE_OUTSIDE_FILE\\n' > /etc/spike-denied.txt && cat /etc/spike-denied.txt"

const server = createServer((request, response) => {
  void (async () => {
    const chunks = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    if (!request.url?.endsWith('/v1/messages') || request.headers['x-api-key'] !== KEY) {
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ type: 'error', error: { message: 'unexpected spike fixture request' } }))
      return
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const serialized = JSON.stringify(body)
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const marker = serialized.includes('INSIDE_TASK') ? 'INSIDE' : serialized.includes('OUTSIDE_TASK') ? 'OUTSIDE' : undefined
    const isToolFollowUp = serialized.includes('"tool_result"') || serialized.includes('tool_use_id')
    console.log(`spike fixture request: marker=${marker ?? 'none'} toolFollowUp=${String(isToolFollowUp)} max_tokens=${String(body.max_tokens)}`)
    if (body.max_tokens === 64) {
      streamText(response, 'SPIKE_TITLE')
    } else if (marker !== undefined && isToolFollowUp) {
      streamText(response, `SPIKE_${marker}_DONE`)
    } else if (marker !== undefined) {
      streamToolCall(response, `spike-${marker.toLowerCase()}-tool`, 'bash', {
        command: marker === 'INSIDE' ? INSIDE_COMMAND : OUTSIDE_COMMAND,
        description: `Spike ${marker.toLowerCase()}-workspace write probe`,
      })
    } else {
      streamText(response, 'SPIKE_FALLBACK')
    }
  })().catch(error => response.destroy(error instanceof Error ? error : undefined))
})

const sseEvent = event => `data: ${JSON.stringify(event)}\n\n`

function streamText(response, text) {
  response.write(sseEvent({ type: 'message_start', message: { usage: { input_tokens: 3, output_tokens: 0 } } }))
  response.write(sseEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
  response.write(sseEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }))
  response.write(sseEvent({ type: 'content_block_stop', index: 0 }))
  response.write(sseEvent({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 20 } }))
  response.end(sseEvent({ type: 'message_stop' }))
}

function streamToolCall(response, id, name, input) {
  response.write(sseEvent({ type: 'message_start', message: { usage: { input_tokens: 3, output_tokens: 0 } } }))
  response.write(sseEvent({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } }))
  response.write(sseEvent({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }))
  response.write(sseEvent({ type: 'content_block_stop', index: 0 }))
  response.write(sseEvent({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } }))
  response.end(sseEvent({ type: 'message_stop' }))
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`spike fixture model listening on 127.0.0.1:${PORT}`)
})
