import { describe, expect, it } from 'vitest'
import { modelUsageObserver } from '../src/dsh/model-usage.js'

const observe = (protocol: 'anthropic-messages' | 'openai-completions' | 'openai-responses', contentType: string, chunks: string[]) => {
  const observer = modelUsageObserver(protocol, contentType)
  for (const chunk of chunks) observer.observe(new TextEncoder().encode(chunk))
  return observer.finish()
}

describe('model usage observers', () => {
  it('reads Anthropic Messages usage from a streamed message', () => {
    const sse =
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":1,"cache_read_input_tokens":2,"cache_creation_input_tokens":3}}}\n\n' +
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":12}}\n\n' +
      'event: message_stop\ndata: {"type":"message_stop"}\n\n'
    expect(observe('anthropic-messages', 'text/event-stream', [sse])).toEqual({
      tokens: { input: 10, output: 12, cacheRead: 2, cacheWrite: 3, reasoning: null },
      usageUnknown: false,
    })
  })

  it('reads Anthropic Messages usage from a buffered message', () => {
    const body = JSON.stringify({
      type: 'message',
      usage: { input_tokens: 7, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 1 },
    })
    expect(observe('anthropic-messages', 'application/json', [body])).toEqual({
      tokens: { input: 7, output: 5, cacheRead: 0, cacheWrite: 1, reasoning: null },
      usageUnknown: false,
    })
  })

  it('reads OpenAI Chat Completions usage from the final streamed chunk across split bytes', () => {
    const sse =
      'data: {"choices":[{"delta":{"content":"hi"}}],"usage":null}\n\n' +
      'data: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":4,"prompt_tokens_details":{"cached_tokens":2,"cache_write_tokens":1}}}\n\n' +
      'data: [DONE]\n\n'
    const split = sse.indexOf('cached') + 2
    expect(observe('openai-completions', 'text/event-stream', [sse.slice(0, split), sse.slice(split)])).toEqual({
      tokens: { input: 6, output: 4, cacheRead: 2, cacheWrite: 1, reasoning: null },
      usageUnknown: false,
    })
  })

  it('keeps missing Chat Completions cache counters unknown instead of inventing zero', () => {
    const sse =
      'data: {"choices":[{"delta":{"content":"hi"}}],"usage":null}\n\n' +
      'data: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":4,"prompt_tokens_details":{"cached_tokens":2}}}\n\n' +
      'data: [DONE]\n\n'
    expect(observe('openai-completions', 'text/event-stream', [sse])).toEqual({
      tokens: { input: null, output: 4, cacheRead: 2, cacheWrite: null, reasoning: null },
      usageUnknown: true,
    })
  })

  it('reads buffered Chat Completions usage and refuses malformed counters', () => {
    expect(
      observe('openai-completions', 'application/json', [
        JSON.stringify({ usage: { prompt_tokens: 3, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 1, cache_write_tokens: 0 } } }),
      ]),
    ).toEqual({ tokens: { input: 2, output: 2, cacheRead: 1, cacheWrite: 0, reasoning: null }, usageUnknown: false })
    expect(
      observe('openai-completions', 'application/json', [
        JSON.stringify({ usage: { prompt_tokens: -1, completion_tokens: 2.5, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } } }),
      ]),
    ).toEqual({ tokens: { input: null, output: null, cacheRead: 0, cacheWrite: 0, reasoning: null }, usageUnknown: true })
    // Inconsistent upstream totals are unknown instead of a clamped fabricated input.
    expect(
      observe('openai-completions', 'application/json', [
        JSON.stringify({ usage: { prompt_tokens: 5, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 10, cache_write_tokens: 0 } } }),
      ]),
    ).toEqual({ tokens: { input: null, output: 1, cacheRead: 10, cacheWrite: 0, reasoning: null }, usageUnknown: true })
  })

  it('reads OpenAI Responses usage from the completed event and the buffered response', () => {
    const sse =
      'event: response.created\ndata: {"type":"response.created","response":{"usage":null}}\n\n' +
      'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":11,"output_tokens":6,"input_tokens_details":{"cached_tokens":4,"cache_write_tokens":2}}}}\n\n'
    expect(observe('openai-responses', 'text/event-stream', [sse])).toEqual({
      tokens: { input: 5, output: 6, cacheRead: 4, cacheWrite: 2, reasoning: null },
      usageUnknown: false,
    })
    const buffered = JSON.stringify({ usage: { input_tokens: 5, output_tokens: 3, input_tokens_details: { cached_tokens: 1, cache_write_tokens: 0 } } })
    expect(observe('openai-responses', 'application/json', [buffered])).toEqual({
      tokens: { input: 4, output: 3, cacheRead: 1, cacheWrite: 0, reasoning: null },
      usageUnknown: false,
    })
  })

  it('reports unknown when a stream ends before any usage arrives or exceeds the observation bound', () => {
    expect(observe('openai-responses', 'text/event-stream', ['event: response.created\ndata: {"type":"response.created"}\n\n'])).toEqual({
      tokens: { input: null, output: null, cacheRead: null, cacheWrite: null, reasoning: null },
      usageUnknown: true,
    })
    expect(observe('openai-completions', 'application/json', ['this is not json']).usageUnknown).toBe(true)
    expect(observe('openai-completions', 'text/event-stream', ['data: ' + 'x'.repeat(2 * 1024 * 1024 + 8) + '\n\n']).usageUnknown).toBe(true)
  })
})
