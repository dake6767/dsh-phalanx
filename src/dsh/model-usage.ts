import type { CommunityProviderProtocol } from '../domain/admin-contract.js'
import type { ModelTokenUsage } from '../domain/usage-record.js'

/** Bounded Messages metadata observation; forwarding never waits for parsing or persistence. */
function messagesUsageObserver(contentType: string) {
  const decoder = new TextDecoder('utf-8', { fatal: true }),
    encoder = new TextEncoder()
  const tokens = {
    input: null as number | null,
    output: null as number | null,
    cacheRead: null as number | null,
    cacheWrite: null as number | null,
    reasoning: null as number | null,
  }
  const streaming = /^text\/event-stream\b/iu.test(contentType),
    totalLimit = 2 * 1024 * 1024,
    eventLimit = 64 * 1024
  let text = '',
    pending = '',
    data: string[] = [],
    bytes = 0,
    eventBytes = 0,
    lineBytes = 0,
    awaitingCR = false,
    unknown = false,
    stopped = false
  const stop = () => {
    unknown = true
    stopped = true
    text = ''
    pending = ''
    data = []
  }
  const usage = (value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      unknown = true
      return
    }
    for (const [key, field] of [
      ['input', 'input_tokens'],
      ['output', 'output_tokens'],
      ['cacheRead', 'cache_read_input_tokens'],
      ['cacheWrite', 'cache_creation_input_tokens'],
    ] as const) {
      const count = (value as Record<string, unknown>)[field]
      if (count === null || count === undefined) continue
      if (Number.isSafeInteger(count) && (count as number) >= 0) tokens[key] = count as number
      else unknown = true
    }
    const reasoning = reasoningUsage(value as Record<string, unknown>, 'output_tokens_details', 'thinking_tokens')
    if (reasoning.present) tokens.reasoning = reasoning.count
    unknown ||= reasoning.invalid
  }
  const dispatch = () => {
    if (data.length)
      try {
        const event = JSON.parse(data.join('\n')) as Record<string, unknown>
        if (event.type === 'message_start') usage((event.message as Record<string, unknown> | undefined)?.usage)
        else if (event.type === 'message_delta') usage(event.usage)
        else if (event.type === 'error') unknown = true
      } catch {
        unknown = true
      }
    data = []
    eventBytes = 0
  }
  const appendLine = (fragment: string) => {
    lineBytes += encoder.encode(fragment).byteLength
    if (eventBytes + lineBytes > eventLimit) {
      stop()
      return
    }
    pending += fragment
  }
  const endLine = (delimiterBytes: number) => {
    eventBytes += lineBytes + delimiterBytes
    if (eventBytes > eventLimit) {
      stop()
      return
    }
    const line = pending
    pending = ''
    lineBytes = 0
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
        const remaining = totalLimit - bytes,
          fragment = decoder.decode(chunk.subarray(0, remaining), { stream: true })
        bytes += Math.min(chunk.byteLength, remaining)
        if (streaming) consume(fragment)
        else text += fragment
        if (chunk.byteLength > remaining) stop()
      } catch {
        stop()
      }
    },
    finish() {
      if (!stopped)
        try {
          const last = decoder.decode()
          if (streaming) {
            consume(last, true)
            if (data.length || (pending && !pending.startsWith(':'))) unknown = true
          } else {
            const message = JSON.parse(text + last) as Record<string, unknown>
            if (message?.type === 'message') usage(message.usage)
            else unknown = true
          }
        } catch {
          unknown = true
        }
      text = ''
      pending = ''
      data = []
      stopped = true
      return {
        tokens: { ...tokens },
        usageUnknown: unknown || [tokens.input, tokens.output, tokens.cacheRead, tokens.cacheWrite].some(value => value === null),
      }
    },
  }
}

const observationLimit = 2 * 1024 * 1024
const counter = (value: unknown): number | null => (Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : null)
/** The platform records non-cached input; OpenAI totals include cache reads and writes. */
const normalizedInput = (total: unknown, cacheRead: number | null, cacheWrite: number | null): number | null => {
  const input = counter(total)
  if (input === null || cacheRead === null || cacheWrite === null) return null
  // Inconsistent upstream counters are unknown, never clamped to a fabricated zero.
  return input < cacheRead + cacheWrite ? null : input - cacheRead - cacheWrite
}
const detail = (value: unknown, field: string): number | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return counter((value as Record<string, unknown>)[field])
}

/** The usage object of one OpenAI protocol payload, or undefined when the payload carries none. */
function openAIUsage(protocol: CommunityProviderProtocol, payload: unknown): Record<string, unknown> | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined
  const event = payload as Record<string, unknown>
  if (protocol === 'openai-completions')
    return event.usage && typeof event.usage === 'object' && !Array.isArray(event.usage) ? (event.usage as Record<string, unknown>) : undefined
  if (event.type === 'response.completed' || event.type === 'response.incomplete') {
    const response = event.response
    if (!response || typeof response !== 'object' || Array.isArray(response)) return undefined
    const usage = (response as Record<string, unknown>).usage
    return usage && typeof usage === 'object' && !Array.isArray(usage) ? (usage as Record<string, unknown>) : undefined
  }
  return event.type === undefined && event.usage && typeof event.usage === 'object' && !Array.isArray(event.usage)
    ? (event.usage as Record<string, unknown>)
    : undefined
}

function openAIUsageObserver(protocol: 'openai-completions' | 'openai-responses', contentType: string) {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const streaming = /^text\/event-stream\b/iu.test(contentType)
  let text = '',
    bytes = 0,
    stopped = false,
    usage: Record<string, unknown> | undefined,
    malformed = false
  const readStream = (content: string) => {
    for (const line of content.split(/\r\n|\r|\n/u)) {
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '' || data === '[DONE]') continue
      try {
        usage = openAIUsage(protocol, JSON.parse(data)) ?? usage
      } catch {
        malformed = true
      }
    }
  }
  return {
    observe(chunk: Uint8Array): void {
      if (stopped) return
      try {
        const remaining = observationLimit - bytes,
          fragment = decoder.decode(chunk.subarray(0, remaining), { stream: true })
        bytes += Math.min(chunk.byteLength, remaining)
        text += fragment
        if (chunk.byteLength > remaining) stopped = true
      } catch {
        stopped = true
      }
    },
    finish() {
      try {
        if (!stopped) {
          const content = text + decoder.decode()
          if (streaming) readStream(content)
          else usage = openAIUsage(protocol, JSON.parse(content))
        }
      } catch {
        malformed = true
      }
      const truncated = stopped
      text = ''
      stopped = true
      let tokens: ModelTokenUsage
      if (usage === undefined) tokens = { input: null, output: null, cacheRead: null, cacheWrite: null, reasoning: null }
      else if (protocol === 'openai-completions') {
        const cacheRead = detail(usage.prompt_tokens_details, 'cached_tokens'),
          cacheWrite = detail(usage.prompt_tokens_details, 'cache_write_tokens')
        tokens = {
          input: normalizedInput(usage.prompt_tokens, cacheRead, cacheWrite),
          output: counter(usage.completion_tokens),
          cacheRead,
          cacheWrite,
          reasoning: reasoningUsage(usage, 'completion_tokens_details', 'reasoning_tokens').count,
        }
      } else {
        const cacheRead = detail(usage.input_tokens_details, 'cached_tokens'),
          cacheWrite = detail(usage.input_tokens_details, 'cache_write_tokens')
        tokens = {
          input: normalizedInput(usage.input_tokens, cacheRead, cacheWrite),
          output: counter(usage.output_tokens),
          cacheRead,
          cacheWrite,
          reasoning: reasoningUsage(usage, 'output_tokens_details', 'reasoning_tokens').count,
        }
      }
      if (usage)
        malformed ||= reasoningUsage(
          usage,
          protocol === 'openai-completions' ? 'completion_tokens_details' : 'output_tokens_details',
          'reasoning_tokens',
        ).invalid
      return {
        tokens,
        usageUnknown:
          truncated || malformed || usage === undefined || [tokens.input, tokens.output, tokens.cacheRead, tokens.cacheWrite].some(value => value === null),
      }
    },
  }
}

/** Bounded per-protocol observation; forwarding never waits for parsing or persistence. */
export function modelUsageObserver(protocol: CommunityProviderProtocol, contentType: string) {
  return protocol === 'anthropic-messages' ? messagesUsageObserver(contentType) : openAIUsageObserver(protocol, contentType)
}

/** A missing optional detail is unknown; a supplied malformed detail also marks parsing incomplete. */
function reasoningUsage(usage: Record<string, unknown>, details: string, field: string) {
  const value = usage[details]
  if (value === undefined || value === null) return { count: null, present: false, invalid: false }
  if (typeof value !== 'object' || Array.isArray(value)) return { count: null, present: true, invalid: true }
  const raw = (value as Record<string, unknown>)[field]
  const count = counter(raw)
  return { count, present: raw !== undefined, invalid: raw !== undefined && count === null }
}
