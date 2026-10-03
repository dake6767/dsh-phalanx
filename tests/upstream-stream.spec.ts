import { EventEmitter } from 'node:events'
import type { ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import { pipeUpstreamBody } from '../src/inbound/upstream-stream.js'

describe('shared upstream streaming primitive', () => {
  it('holds the next upstream chunk until a paused downstream drains', async () => {
    let signalFirstWrite = (): void => {}
    const firstWrite = new Promise<void>(resolve => { signalFirstWrite = resolve })
    class ControlledResponse extends EventEmitter {
      destroyed = false
      writableFinished = false
      ended = false
      readonly writes: string[] = []

      write(chunk: Buffer): boolean {
        this.writes.push(chunk.toString('utf8'))
        if (this.writes.length === 1) { signalFirstWrite(); return false }
        return true
      }

      end(): void { this.ended = true; this.writableFinished = true }
      destroy(): void { this.destroyed = true; this.emit('close') }
    }
    const response = new ControlledResponse()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from('first'))
        controller.enqueue(Buffer.from('second'))
        controller.close()
      },
    })
    const piping = pipeUpstreamBody(response as unknown as ServerResponse, body as Response['body'], new AbortController())
    await firstWrite
    // Flush one event-loop turn while the controlled downstream remains paused.
    await new Promise<void>(resolve => { setImmediate(resolve) })
    expect(response.writes).toEqual(['first'])
    expect(response.ended).toBe(false)
    response.emit('drain')
    await piping
    expect(response.writes).toEqual(['first', 'second'])
    expect(response.ended).toBe(true)
  })
})
