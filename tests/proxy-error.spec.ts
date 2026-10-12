import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { expect, it } from 'vitest'
import { closeIncompleteProxyResponse } from '../src/inbound/proxy-error.js'

it('ends the browser response when a proxied source stream fails after its headers', () => {
  const request = new IncomingMessage(new Socket())
  const upstream = new IncomingMessage(new Socket())
  const downstream = new ServerResponse(request)
  closeIncompleteProxyResponse(upstream, request, downstream)
  upstream.emit('aborted')
  expect(downstream.destroyed).toBe(true)
  expect(() => upstream.emit('error', new Error('Source changed'))).not.toThrow()
})
