import { createServer } from 'node:http'
import { once } from 'node:events'
import { expect, it } from 'vitest'
import { NativeInstallAuthority } from '../src/adapters/native-install-authority.js'
import { SignedNativeInstallTransport } from '../src/adapters/native-install-transport.js'
import { nativeInstallVerifierModule } from '../src/dsh/native-plugin-install.js'

it('exchanges native cookies and sends a signed installation bound to the captured launch', async () => {
  const authority = new NativeInstallAuthority(
    () => 100000,
    () => 'request-nonce',
  )
  const module = await import('data:text/javascript;base64,' + Buffer.from(nativeInstallVerifierModule).toString('base64'))
  const verifier = module.createVerifier(authority.publicKey, 'member', 'launch-one', () => 100000)
  const requests: string[] = []
  const server = createServer(async (request, response) => {
    requests.push(request.url!)
    if (request.url === '/launch') {
      response.writeHead(303, { 'set-cookie': 'native=fixture; HttpOnly', location: '/' }).end()
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = Buffer.concat(chunks).toString()
    expect(request.headers.host).toBe('platform.example')
    expect(request.headers.origin).toBe('https://platform.example')
    expect(request.headers.cookie).toBe('native=fixture')
    expect(
      verifier.check(
        { proof: request.headers['x-phalanx-install-proof'], signature: request.headers['x-phalanx-install-signature'] },
        request.method,
        request.url,
        body,
      ),
    ).toEqual({ ok: true })
    expect(JSON.parse(body)).toMatchObject({
      method: 'pluginManager/installBundle',
      payload: { args: { spec: '/fixture/plugin.tgz', options: { registry: 'https://registry.example', requestId: 'request-one' } } },
    })
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ result: { ok: true, value: { application: 'applied' } } }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address() as { port: number }
  const origin = `http://127.0.0.1:${address.port}`
  try {
    const transport = new SignedNativeInstallTransport(authority)
    await expect(
      transport.install(
        { userId: 'member', resourceKey: 'launch-one', processId: 1, origin, launchUrl: origin + '/launch' },
        new URL('https://platform.example'),
        { spec: '/fixture/plugin.tgz', registry: 'https://registry.example', requestId: 'request-one' },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ application: 'applied' })
    expect(requests).toEqual(['/launch', '/api/phalanx/native-plugins/install'])
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())))
  }
})
