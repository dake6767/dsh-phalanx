import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { hasToolResult, latestHumanText, streamGatedText, streamText, streamToolCall } from '../support/real-dsh-model.js'

/** Official Messages SSE fixture with deterministic release/disconnect handshakes. */
export async function startCommunityModel(port = 0) {
  let markCancelled!: () => void
  const cancelled = new Promise<void>(resolve => { markCancelled = resolve })
  const pending: (() => void)[] = []
  const requests: Record<string, unknown>[] = []
  let readImageCall: string | undefined
  let spawnCall: string | undefined
  let spawnIssued = false
  const release = () => { for (const resume of pending.splice(0)) resume() }
  const server = createServer((request, response) => {
    request.on('error', () => {}); response.on('error', () => {})
    void (async () => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array))
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { max_tokens?: number }
    if (request.url !== '/anthropic/v1/messages' || request.headers['x-api-key'] !== 'community-provider-fixture-key') {
      response.writeHead(401); response.end('Unexpected fixture credential'); return
    }
    requests.push(body)
    response.setHeader('content-type', 'text/event-stream; charset=utf-8')
    const text = latestHumanText(body)
    if (body.max_tokens === 64 || text.startsWith('Generate the session title from this JSON array of human messages:')) { streamText(response, 'COMMUNITY_TITLE'); return }
    // One model-driven image read per task; the refusal and the success differ only in the tool result.
    if (text.includes('READ_IMAGE_TASK') && readImageCall === undefined) {
      readImageCall = `read-image-${requests.length}`
      streamToolCall(response, readImageCall, 'read_image', { file_path: 'probe.png' }); return
    }
    if (readImageCall !== undefined && hasToolResult(body, readImageCall, false)) { streamText(response, 'IMAGE_READ_OK'); readImageCall = undefined; return }
    if (readImageCall !== undefined && hasToolResult(body, readImageCall, true)) { streamText(response, 'IMAGE_READ_BLOCKED'); readImageCall = undefined; return }
    if (text.includes('IMAGE_TASK')) { streamText(response, 'IMAGE_SEEN'); return }
    if (text.includes('CHILD_IMAGE_TASK')) { streamText(response, 'CHILD_SEEN_IMAGE'); return }
    if (spawnCall !== undefined && hasToolResult(body, spawnCall, false)) { streamText(response, 'PARENT_DONE'); spawnCall = undefined; return }
    if (text.includes('SPAWN_SUBAGENT_TASK') && !spawnIssued) {
      spawnIssued = true
      spawnCall = `spawn-${requests.length}`
      streamToolCall(response, spawnCall, 'subagent', { description: 'Child probe', prompt: 'CHILD_TASK' }); return
    }
    if (text.includes('CHILD_TASK')) { streamText(response, 'CHILD_READY'); return }
    // A subagent completion notice starts another parent turn; answer it without the gated fixture handshake.
    if (spawnIssued && !text.includes('CANCEL_MODEL_TASK')) { streamText(response, 'PARENT_FOLLOWUP'); return }
    let resume!: () => void
    const gate = new Promise<void>(resolve => { resume = resolve; pending.push(resolve) })
    const cancel = text.includes('CANCEL_MODEL_TASK')
    response.once('close', () => { if (!response.writableFinished && cancel) markCancelled(); resume() })
    await streamGatedText(response, cancel ? 'CANCEL_STARTED' : 'COMMUNITY_', gate, cancel ? 'UNEXPECTED_FINISH' : 'MODEL_READY')
  })().catch(() => response.destroy()) })
  await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve))
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, cancelled, release, requests,
    close: async () => { release(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) } }
}
