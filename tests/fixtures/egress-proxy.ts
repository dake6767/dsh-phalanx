import { execFileSync } from 'node:child_process'
import { createServer as httpsServer } from 'node:https'
import { createServer as httpServer } from 'node:http'
import { connect, type Socket } from 'node:net'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** A real authenticated CONNECT hop to a local certificate-verified origin. */
export async function egressProxy() {
  const root = await mkdtemp(join(tmpdir(), 'egress-proxy-'))
  await writeFile(join(root, 'cert.cnf'), '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=proxy-fixture.test\n[ext]\nsubjectAltName=DNS:proxy-fixture.test,DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-config', join(root, 'cert.cnf'), '-keyout', join(root, 'key.pem'), '-out', join(root, 'cert.pem')], { stdio: 'ignore' })
  const sockets = new Set<Socket>(), connects: string[] = []
  const track = (socket: Socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) }
  const origin = httpsServer({ key: await readFile(join(root, 'key.pem')), cert: await readFile(join(root, 'cert.pem')) }, (_request, response) => response.end('#!/bin/sh\necho proxy-ready\n'))
  origin.on('connection', track)
  await new Promise<void>(resolve => origin.listen(0, '127.0.0.1', resolve))
  const port = (origin.address() as { port: number }).port
  const proxy = httpServer(); proxy.on('connection', track)
  let unavailable = false
  proxy.on('connect', (request, client, head) => {
    if (unavailable) { client.end('HTTP/1.1 503 Unavailable\r\n\r\n'); return }
    if (request.headers['proxy-authorization'] !== 'Basic '+Buffer.from('fixture-user:fixture-proxy-password').toString('base64') || request.url !== 'proxy-fixture.test:443') { client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return }
    connects.push(request.url)
    const upstream = connect(port, '127.0.0.1', () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); client.pipe(upstream).pipe(client) })
    track(upstream); client.on('error', () => upstream.destroy()); upstream.on('error', () => client.destroy()); client.on('close', () => upstream.destroy())
  })
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))
  return { proxy: `http://fixture-user:fixture-proxy-password@127.0.0.1:${(proxy.address() as { port: number }).port}`, ca: join(root, 'cert.pem'), connects,
    url: 'https://proxy-fixture.test/tool', direct: `https://localhost:${port}/tool`, fail: () => { unavailable = true },
    close: async () => { for (const socket of sockets) socket.destroy(); await Promise.all([new Promise<void>(resolve => proxy.close(() => resolve())), new Promise<void>(resolve => origin.close(() => resolve()))]); await rm(root, { recursive: true, force: true }) } }
}
