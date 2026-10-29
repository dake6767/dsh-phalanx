import { createServer } from 'node:http'

// A local Messages protocol fixture. It performs no inference or outbound I/O.
const port = Number(process.argv[2] ?? 18081)
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid development model port')
const server = createServer(async (request, response) => {
  request.on('error', () => {})
  response.on('error', () => {})
  if (request.method === 'GET' && request.url === '/health') {
    response.end('ready')
    return
  }
  if (request.method !== 'POST' || request.url !== '/anthropic/v1/messages') {
    response.writeHead(404)
    response.end()
    return
  }
  let size = 0
  try {
    for await (const chunk of request) {
      size += chunk.length
      if (size > 2 * 1024 * 1024) {
        response.writeHead(413)
        response.end()
        return
      }
    }
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
    const event = value => response.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`)
    event({
      type: 'message_start',
      message: {
        id: 'development-message',
        type: 'message',
        role: 'assistant',
        model: 'development-model',
        content: [],
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    })
    event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    event({
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'text_delta',
        text: 'Local development model is ready. This is a fixed test response. Configure a real model in Administration to use inference and tools.',
      },
    })
    event({ type: 'content_block_stop', index: 0 })
    event({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } })
    event({ type: 'message_stop' })
    response.end()
  } catch {
    response.destroy()
  }
})
server.listen(port, '127.0.0.1', () => {
  console.log(`Development model: http://127.0.0.1:${server.address().port}`)
})
process.on('SIGTERM', () => {
  server.closeAllConnections()
  server.close()
})
