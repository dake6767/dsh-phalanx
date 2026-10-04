export function latestHumanText(body: unknown): string {
  const messages = isRecord(body) && Array.isArray(body.messages) ? body.messages : []
  let currentUserText = ''
  for (const message of messages) {
    if (!isRecord(message) || message.role !== 'user') continue
    const content = message.content
    const textBlocks = typeof content === 'string'
      ? [content]
      : Array.isArray(content)
        ? content.filter(block => isRecord(block) && block.type === 'text').map(block => String(block.text ?? ''))
        : []
    // Native Anthropic adapters serialize DSH's synthetic time context as a user message.
    const humanText = textBlocks.filter(text => !text.startsWith('Current runtime context')
      && !text.startsWith('Time sampled while preparing turn ')).join(' ')
    if (humanText.trim() !== '') currentUserText = humanText
  }
  return currentUserText
}

export function hasToolResult(body: unknown, toolUseId: string, failed: boolean): boolean {
  const messages = isRecord(body) && Array.isArray(body.messages) ? body.messages : []
  return messages.some(message => isRecord(message) && Array.isArray(message.content)
    && message.content.some(block => isRecord(block) && block.type === 'tool_result'
      && block.tool_use_id === toolUseId && (block.is_error === true) === failed))
}

function sseEvent(event: Record<string, unknown>): string {
  return `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`
}

export function streamText(response: import('node:http').ServerResponse, text: string): void {
  response.write(sseEvent({ type: 'message_start', message: { usage: { input_tokens: 3, output_tokens: 0 } } }))
  response.write(sseEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
  response.write(sseEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }))
  response.write(sseEvent({ type: 'content_block_stop', index: 0 }))
  response.write(sseEvent({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 20 } }))
  response.end(sseEvent({ type: 'message_stop' }))
}

export async function streamGatedText(
  response: import('node:http').ServerResponse,
  first: string,
  release: Promise<void>,
  last: string,
): Promise<void> {
  response.write(sseEvent({ type: 'message_start', message: { usage: { input_tokens: 3, output_tokens: 0 } } }))
  response.write(sseEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
  response.write(sseEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: first } }))
  await release
  response.write(sseEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: last } }))
  response.write(sseEvent({ type: 'content_block_stop', index: 0 }))
  response.write(sseEvent({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 20 } }))
  response.end(sseEvent({ type: 'message_stop' }))
}

export function streamToolCall(
  response: import('node:http').ServerResponse,
  id: string,
  name: string,
  input: Record<string, unknown>,
): void {
  response.write(sseEvent({ type: 'message_start', message: { usage: { input_tokens: 3, output_tokens: 0 } } }))
  response.write(sseEvent({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } }))
  response.write(sseEvent({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }))
  response.write(sseEvent({ type: 'content_block_stop', index: 0 }))
  response.write(sseEvent({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } }))
  response.end(sseEvent({ type: 'message_stop' }))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
