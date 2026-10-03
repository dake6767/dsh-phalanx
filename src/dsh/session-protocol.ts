export const DSH_RPC_PREFIX = '/api/'
export const DSH_REMOTE_MUX_PATH = '/api/remote.mux'
export const SESSION_LIST = 'session/list'

/** Encode one frozen DSH unary RPC request. */
export function rpcRequestBody(rpcId: string, method: string, args: object): string {
  return JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } })
}

/** Decode the frozen unary response; the transport supplies only its JSON body. */
export function rpcResponseValue<T>(body: string, method: string): T {
  const envelope = JSON.parse(body) as { result?: { ok: boolean, value?: T, error?: { message?: string } } }
  if (envelope.result?.ok !== true) {
    throw new Error(`DSH RPC ${method} failed: ${envelope.result?.error?.message ?? 'invalid response'}`)
  }
  return envelope.result.value as T
}

/** The session-list running bit is the frozen DSH activity introspection seam. */
export function runningAgentFromResponse(body: string): boolean {
  const envelope = JSON.parse(body) as {
    result?: { ok: boolean, value?: { items?: Array<{ running?: unknown }> }, error?: { message?: unknown } }
  }
  if (envelope.result?.ok !== true || !Array.isArray(envelope.result.value?.items)) {
    throw new Error(`DSH activity query failed: ${String(envelope.result?.error?.message ?? 'invalid response')}`)
  }
  return envelope.result.value.items.some(item => item.running === true)
}

export function streamOpenFrame(streamId: string, endpoint: string, args: object): string {
  return JSON.stringify({ type: 'open', streamId, endpoint, payload: { args } })
}

export function streamFrameValue<T>(body: string, streamId: string, endpoint: string): T | undefined {
  const frame = JSON.parse(body) as { streamId?: string, type?: string, value?: T, error?: { message?: string } }
  if (frame.streamId !== streamId) return undefined
  if (frame.type === 'item') return frame.value
  if (frame.type === 'error') throw new Error(`DSH ${endpoint} stream failed: ${frame.error?.message ?? 'unknown error'}`)
  return undefined
}
