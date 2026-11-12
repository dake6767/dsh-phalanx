// Public member-side proxy probe. Each private input file contains only that member's fictional credential.
import { readFileSync } from 'node:fs'
import { request } from 'node:http'
import { connect } from 'node:tls'

const input = JSON.parse(readFileSync(new URL('./member-network-probe.json', import.meta.url), 'utf8'))
const [mode, target, marker] = process.argv.slice(2)
const headers = { 'proxy-authorization': 'Basic ' + Buffer.from('dsh:' + input.token).toString('base64') }
const gateway = { host: '127.0.0.1', port: input.gateway, agent: false, headers }
const finish = prefix => console.log(prefix + '_PROBE_FINISHED_' + marker)

function plaintext() {
  return new Promise((resolve, reject) => {
    const outgoing = request({ ...gateway, path: input.http }, incoming => {
      let body = ''
      incoming.on('data', part => {
        body += part
        if (body.length > 16384) outgoing.destroy(new Error('Oversized fixture response'))
      })
      incoming.on('error', reject)
      incoming.on('end', () => {
        try {
          if (incoming.statusCode !== 200 || typeof JSON.parse(body).model !== 'number') throw new Error('HTTP fixture failed')
          resolve()
        } catch (error) {
          reject(error)
        }
      })
    })
    outgoing.on('error', reject)
    outgoing.setTimeout(10000, () => outgoing.destroy(new Error('HTTP deadline')))
    outgoing.end()
  })
}

function encrypted() {
  return new Promise((resolve, reject) => {
    const destination = new URL(input.https)
    const outgoing = request({ ...gateway, method: 'CONNECT', path: destination.host })
    outgoing.on('response', incoming => {
      incoming.resume()
      reject(new Error('CONNECT denied'))
    })
    outgoing.on('connect', (incoming, socket, head) => {
      if (incoming.statusCode !== 200) {
        socket.destroy()
        reject(new Error('CONNECT denied'))
        return
      }
      if (head.length) socket.unshift(head)
      // With an existing socket, host still supplies the certificate identity. SNI is unnecessary for the IP fixture.
      const client = connect({ socket, host: destination.hostname, ca: input.ca, rejectUnauthorized: true }, () => {
        client.write('GET ' + destination.pathname + ' HTTP/1.1\r\nHost: ' + destination.host + '\r\nConnection: close\r\n\r\n')
      })
      let body = ''
      client.on('data', part => {
        body += part
        if (body.length > 16384) client.destroy(new Error('Oversized TLS fixture response'))
      })
      client.on('error', error => {
        outgoing.destroy()
        reject(error)
      })
      client.setTimeout(10000, () => client.destroy(new Error('TLS deadline')))
      client.on('end', () => {
        try {
          if (!client.authorized || !/^HTTP\/1\.[01] 200/u.test(body) || typeof JSON.parse(body.split('\r\n\r\n')[1]).model !== 'number')
            throw new Error('HTTPS fixture failed')
          resolve()
        } catch (error) {
          reject(error)
        } finally {
          client.destroy()
          outgoing.destroy()
        }
      })
    })
    outgoing.on('error', reject)
    outgoing.setTimeout(10000, () => outgoing.destroy(new Error('CONNECT deadline')))
    outgoing.end()
  })
}

if (mode === 'connect') {
  const outgoing = request({ ...gateway, method: 'CONNECT', path: target })
  const result = (incoming, socket) => {
    finish('STATUS_' + incoming.statusCode)
    socket?.destroy()
    incoming.resume()
  }
  outgoing.on('connect', result)
  outgoing.on('response', result)
  outgoing.on('error', () => {
    finish('CONNECT_ERROR')
    process.exitCode = 1
  })
  outgoing.setTimeout(10000, () => outgoing.destroy(new Error('CONNECT deadline')))
  outgoing.end()
} else if (mode === 'public') {
  try {
    await plaintext()
    await encrypted()
    finish('HTTP_200_HTTPS_200')
  } catch (error) {
    finish('PUBLIC_PROXY_FAILED_' + (error.code ?? 'REQUEST'))
    process.exitCode = 1
  }
} else {
  throw new Error('Choose connect or public')
}
