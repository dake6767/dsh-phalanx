import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { NativeMemberPluginManager } from '../src/adapters/member-plugin-manager.js'
import { DSH_CONTAINER_PROFILE } from '../src/dsh/profile-layout.js'

it('uses the native remove RPC and rejects failed business results even over HTTP 200', async () => {
  let application = 'applied'
  const requests: { method: string; args: object }[] = []
  const server = createServer(async (request, response) => {
    if (request.url === '/launch') {
      response.writeHead(303, { 'set-cookie': 'native-session=fixture; HttpOnly', location: '/' }).end()
      return
    }
    let text = ''
    for await (const chunk of request) text += chunk
    const body = JSON.parse(text)
    requests.push({ method: body.method, args: body.payload.args })
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ result: { ok: true, value: { application, changed: true, error: { code: 'not-removable' } } } }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('Not listening')
  const origin = new URL(`http://127.0.0.1:${address.port}`),
    instance = { userId: 'alice', processId: 1, origin: origin.href, launchUrl: new URL('/launch', origin).href }
  try {
    const manager = new NativeMemberPluginManager()
    expect(await manager.remove(instance, origin, 'sample', new AbortController().signal)).toBe('applied')
    expect(requests).toEqual([{ method: 'pluginManager/removeBundle', args: { name: 'sample' } }])
    application = 'failed'
    await expect(manager.remove(instance, origin, 'sample', new AbortController().signal)).rejects.toMatchObject({
      code: 'plugin-install-failed',
      params: { reason: 'not-removable' },
    })
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

it('installs only a cached local path with call-scoped registry/request id and never approves build scripts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-plugin-manager-')),
    integrity = 'sha512-' + Buffer.alloc(64, 1).toString('base64')
  const cache = join(DSH_CONTAINER_PROFILE, '.phalanx-market', Buffer.alloc(64, 1).toString('hex') + '.tgz'),
    cli = join(root, 'container-cli')
  await writeFile(cli, `#!/bin/sh\nprintf '%s' '${cache}'\n`, { mode: 0o700 })
  let result = { application: 'restart-required', changed: true, packageResult: { kind: 'none' } },
    received: object | undefined
  const server = createServer(async (request, response) => {
    if (request.url === '/launch') {
      response.writeHead(303, { 'set-cookie': 'native-session=fixture', location: '/' }).end()
      return
    }
    let text = ''
    for await (const chunk of request) text += chunk
    received = JSON.parse(text)
    response.end(JSON.stringify({ result: { ok: true, value: result } }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('Not listening')
  const origin = new URL(`http://127.0.0.1:${address.port}`),
    instance = { userId: 'alice', processId: 1, origin: origin.href, launchUrl: new URL('/launch', origin).href, containerName: 'member' }
  const manager = new NativeMemberPluginManager({ container: { runtime: cli, image: 'fixture', internalPort: 1, gatewayPort: 2 } })
  try {
    expect(
      await manager.install(
        instance,
        origin,
        { url: 'http://plugins.dsh-phalanx.invalid/plugin-archive/fixture.tgz', integrity },
        { registry: 'https://registry.npmjs.org', requestId: 'native-1' },
        new AbortController().signal,
      ),
    ).toBe('restart-required')
    expect(received).toMatchObject({
      method: 'pluginManager/installBundle',
      payload: { args: { spec: cache, options: { registry: 'https://registry.npmjs.org', requestId: 'native-1' } } },
    })
    expect(JSON.stringify(received)).not.toMatch(/approvedBuilds|plugin-archive/)
    result = { ...result, application: 'failed', packageResult: { kind: 'build-blocked' } }
    await expect(
      manager.install(
        instance,
        origin,
        { url: 'http://plugins.dsh-phalanx.invalid/plugin-archive/fixture.tgz', integrity },
        { registry: 'https://registry.npmjs.org', requestId: 'native-2' },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'plugin-install-failed', params: { reason: 'build-blocked' } })
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
})

it('distinguishes current retained archive dependencies from independently installed native copies', async () => {
  const prefix = 'file:' + DSH_CONTAINER_PROFILE + '/.phalanx-market/'
  const server = createServer((request, response) => {
    if (request.url === '/launch') {
      response.writeHead(303, { 'set-cookie': 'native=fixture' }).end()
      return
    }
    response.end(
      JSON.stringify({
        result: {
          ok: true,
          value: [
            { name: 'retained', version: '1.0.0', installed: true, source: prefix + 'a'.repeat(128) + '.tgz' },
            { name: 'upgraded', version: '2.0.0', installed: true, source: 'upgraded@^2.0.0' },
            { name: 'unknown', version: '1.0.0', installed: true },
            { name: 'foreign', version: '1.0.0', installed: true, source: 'file:/tmp/' + 'a'.repeat(128) + '.tgz' },
            { name: 'nested', version: '1.0.0', installed: true, source: prefix + '../' + 'a'.repeat(128) + '.tgz' },
            { name: 'broken', installed: true, source: 'broken@1.0.0' },
            { name: 'missing', version: '1.0.0', installed: false, source: prefix + 'a'.repeat(128) + '.tgz' },
          ],
        },
      }),
    )
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('Not listening')
  const origin = new URL(`http://127.0.0.1:${address.port}`)
  try {
    const rows = await new NativeMemberPluginManager().list(
      { userId: 'alice', processId: 1, origin: origin.href, launchUrl: new URL('/launch', origin).href },
      origin,
      new AbortController().signal,
    )
    expect(rows).toEqual([
      { packageName: 'retained', version: '1.0.0', retainedArchive: true },
      { packageName: 'upgraded', version: '2.0.0' },
      { packageName: 'unknown', version: '1.0.0' },
      { packageName: 'foreign', version: '1.0.0' },
      { packageName: 'nested', version: '1.0.0' },
      { packageName: 'broken' },
    ])
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
