/** The default DeepSeek adapter's Anthropic Messages transport seam. */
export const MODEL_GATEWAY_BASE_PATH = '/_dsh-phalanx/model'
export const MODEL_GATEWAY_PATH = `${MODEL_GATEWAY_BASE_PATH}/v1/messages`
export function modelUpstreamUrl(baseUrl: string): URL {
  const url = new URL(baseUrl)
  url.pathname = `${url.pathname.replace(/\/+$/u, '')}/anthropic/v1/messages`
  return url
}

/** Messages Base URL includes any provider-specific prefix supplied by the administrator. */
export function messagesUpstreamUrl(baseUrl: string): URL {
  const url = new URL(baseUrl)
  url.pathname = `${url.pathname.replace(/\/+$/u, '')}/v1/messages`
  return url
}

/** Outgoing Messages headers shared by community and retained migration transport. */
export function modelUpstreamHeaders(apiKey: string, accept: string): Record<string, string> {
  return { accept, 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
}

/** Bounded Messages metadata observation; forwarding never waits for parsing or persistence. */
export function modelUsageObserver(contentType: string) {
  const decoder = new TextDecoder('utf-8', { fatal: true }), encoder = new TextEncoder()
  const tokens = { input: null as number | null, output: null as number | null, cacheRead: null as number | null, cacheWrite: null as number | null }
  const streaming = /^text\/event-stream\b/iu.test(contentType), totalLimit = 2 * 1024 * 1024, eventLimit = 64 * 1024
  let text = '', pending = '', data: string[] = [], bytes = 0, eventBytes = 0, lineBytes = 0, awaitingCR = false, unknown = false, stopped = false
  const stop = () => { unknown = true; stopped = true; text = ''; pending = ''; data = [] }
  const usage = (value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { unknown = true; return }
    for (const [key, field] of [['input', 'input_tokens'], ['output', 'output_tokens'], ['cacheRead', 'cache_read_input_tokens'], ['cacheWrite', 'cache_creation_input_tokens']] as const) {
      const count = (value as Record<string, unknown>)[field]
      if (count === null || count === undefined) continue
      if (Number.isSafeInteger(count) && (count as number) >= 0) tokens[key] = count as number
      else unknown = true
    }
  }
  const dispatch = () => {
    if (data.length) try {
      const event = JSON.parse(data.join('\n')) as Record<string, unknown>
      if (event.type === 'message_start') usage((event.message as Record<string, unknown> | undefined)?.usage)
      else if (event.type === 'message_delta') usage(event.usage)
      else if (event.type === 'error') unknown = true
    } catch { unknown = true }
    data = []; eventBytes = 0
  }
  const appendLine = (fragment: string) => {
    lineBytes += encoder.encode(fragment).byteLength
    if (eventBytes + lineBytes > eventLimit) { stop(); return }
    pending += fragment
  }
  const endLine = (delimiterBytes: number) => {
    eventBytes += lineBytes + delimiterBytes
    if (eventBytes > eventLimit) { stop(); return }
    const line = pending
    pending = ''; lineBytes = 0
    if (line === '') dispatch()
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /u, ''))
  }
  const consume = (fragment: string, final = false) => {
    let cursor = 0
    if (awaitingCR) {
      if (!fragment && !final) return
      awaitingCR = false
      const paired = fragment.startsWith('\n')
      endLine(paired ? 2 : 1)
      if (paired) cursor = 1
    }
    const endings = /\r\n|\r|\n/gu
    endings.lastIndex = cursor
    let match: RegExpExecArray | null
    while (!stopped && (match = endings.exec(fragment))) {
      appendLine(fragment.slice(cursor, match.index))
      if (stopped) return
      cursor = match.index + match[0].length
      if (!final && match[0] === '\r' && cursor === fragment.length) awaitingCR = true
      else endLine(match[0].length)
    }
    if (!stopped) appendLine(fragment.slice(cursor))
  }
  return {
    observe(chunk: Uint8Array): void {
      if (stopped) return
      try {
        const remaining = totalLimit - bytes, fragment = decoder.decode(chunk.subarray(0, remaining), { stream: true })
        bytes += Math.min(chunk.byteLength, remaining)
        if (streaming) consume(fragment); else text += fragment
        if (chunk.byteLength > remaining) stop()
      } catch { stop() }
    },
    finish() {
      if (!stopped) try {
        const last = decoder.decode()
        if (streaming) { consume(last, true); if (data.length || pending && !pending.startsWith(':')) unknown = true }
        else {
          const message = JSON.parse(text + last) as Record<string, unknown>
          if (message?.type === 'message') usage(message.usage); else unknown = true
        }
      } catch { unknown = true }
      text = ''; pending = ''; data = []; stopped = true
      return { tokens: { ...tokens }, usageUnknown: unknown || Object.values(tokens).some(value => value === null) }
    },
  }
}
