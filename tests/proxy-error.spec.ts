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

it('checks only refused/reset transfers without retrying or treating unrelated failures as dead carriers', async () => {
  const { checkFailedRuntime } = await import('../src/inbound/proxy-error.js')
  const instance = { userId: 'alice', processId: 101, origin: 'http://127.0.0.1:4101', launchUrl: '/' }
  const checked: number[] = []
  const check = async (value: typeof instance) => { checked.push(value.processId) }
  await checkFailedRuntime(Object.assign(new Error('fixture'), { code: 'ECONNREFUSED' }), instance, check)
  await checkFailedRuntime(Object.assign(new Error('fixture'), { code: 'ECONNRESET' }), instance, check)
  await checkFailedRuntime(Object.assign(new Error('ECONNREFUSED'), { code: 'ETIMEDOUT' }), instance, check)
  expect(checked).toEqual([101, 101])
})

it('checks a truncated upstream once even if both aborted and error events arrive', async () => {
  const { monitorRuntimeProxy } = await import('../src/inbound/proxy-error.js')
  const request = new IncomingMessage(new Socket()), upstream = new IncomingMessage(new Socket()), response = new ServerResponse(request)
  const instance = { userId: 'alice', processId: 101, origin: 'http://127.0.0.1:4101', launchUrl: '/' }
  const checked: number[] = []
  monitorRuntimeProxy(request, instance, async value => { checked.push(value.processId) })
  closeIncompleteProxyResponse(upstream, request, response)
  upstream.emit('aborted'); upstream.emit('error', Object.assign(new Error('fixture'), { code: 'ECONNRESET' }))
  expect(response.destroyed).toBe(true)
  expect(checked).toEqual([101])
})
