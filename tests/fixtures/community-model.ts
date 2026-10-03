import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { latestHumanText, streamGatedText, streamText } from '../support/real-dsh-model.js'

/** Official Messages SSE fixture with deterministic release/disconnect handshakes. */
export async function startCommunityModel() {
  let markCancelled!: () => void
  const cancelled = new Promise<void>(resolve => { markCancelled = resolve })
  const pending: (() => void)[] = []
  const release = () => { for (const resume of pending.splice(0)) resume() }
  const server = createServer((request, response) => {
    request.on('error', () => {}); response.on('error', () => {})
    void (async () => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array))
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { max_tokens?: number }
    if (request.url !== '/anthropic/v1/messages' || request.headers['x-api-key'] !== 'community-provider-fixture-key') {
      response.writeHead(401); response.end('Unexpected fixture credential'); return
    }
    response.setHeader('content-type', 'text/event-stream; charset=utf-8')
    if (body.max_tokens === 64) { streamText(response, 'COMMUNITY_TITLE'); return }
    let resume!: () => void
    const gate = new Promise<void>(resolve => { resume = resolve; pending.push(resolve) })
    const cancel = latestHumanText(body).includes('CANCEL_MODEL_TASK')
    response.once('close', () => { if (!response.writableFinished && cancel) markCancelled(); resume() })
    await streamGatedText(response, cancel ? 'CANCEL_STARTED' : 'COMMUNITY_', gate, cancel ? 'UNEXPECTED_FINISH' : 'MODEL_READY')
  })().catch(() => response.destroy()) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, cancelled, release,
    close: async () => { release(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) } }
}
