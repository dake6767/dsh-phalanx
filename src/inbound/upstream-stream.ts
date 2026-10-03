import type { IncomingMessage, ServerResponse } from 'node:http'

/** Bind an upstream request to the downstream connection's lifetime. */
export function downstreamAbort(request: IncomingMessage, response: ServerResponse): {
  controller: AbortController, cleanup(): void
} {
  const controller = new AbortController()
  const cancel = (): void => { if (!response.writableFinished) controller.abort() }
  request.once('aborted', cancel)
  response.once('close', cancel)
  return {
    controller,
    cleanup: () => {
      request.off('aborted', cancel)
      response.off('close', cancel)
    },
  }
}

/** Preserve streaming backpressure and abort an idle upstream when requested. */
export async function pipeUpstreamBody(
  response: ServerResponse,
  body: ReadableStream<Uint8Array> | null,
  controller: AbortController,
  idleMs?: number,
  observe?: (chunk: Uint8Array) => void,
): Promise<void> {
  if (body === null) { response.end(); return }
  let idleTimer: NodeJS.Timeout | undefined
  const resetIdle = (): void => {
    if (idleMs === undefined) return
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => { controller.abort() }, idleMs)
  }
  resetIdle()
  try {
    for await (const chunk of body) {
      resetIdle()
      if (response.destroyed) break
      observe?.(chunk)
      await writeWithBackpressure(response, Buffer.from(chunk), controller.signal)
    }
    if (!response.destroyed) response.end()
  } catch (error) {
    if (!response.destroyed) response.destroy(error instanceof Error ? error : undefined)
  } finally {
    if (idleTimer !== undefined) clearTimeout(idleTimer)
  }
}

function writeWithBackpressure(response: ServerResponse, chunk: Buffer, signal: AbortSignal): Promise<void> {
  if (response.destroyed || signal.aborted) return Promise.reject(new Error('downstream closed'))
  if (response.write(chunk)) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      response.off('drain', onDrain)
      response.off('close', onClose)
      signal.removeEventListener('abort', onClose)
    }
    const onDrain = (): void => { cleanup(); resolve() }
    const onClose = (): void => { cleanup(); reject(new Error('downstream closed')) }
    response.once('drain', onDrain)
    response.once('close', onClose)
    signal.addEventListener('abort', onClose, { once: true })
    if (response.destroyed || signal.aborted) onClose()
  })
}
