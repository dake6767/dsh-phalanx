import { setInterval, clearInterval } from 'node:timers'
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
const peers = new Set()
const frame = text => {
  const b = Buffer.from(text)
  return Buffer.concat([Buffer.from([129, b.length]), b])
}
fs.watchFile('/tmp/preview-revision', { interval: 100 }, (current, previous) => {
  if (current.mtimeMs !== previous.mtimeMs) for (const peer of peers) peer.write(frame('HMR UPDATED'))
})
const base = process.env.PREVIEW_BASE
const server = http.createServer((req, res) => {
  if (!req.url.startsWith(base)) {
    res.writeHead(404)
    res.end('Configure the preview base path')
    return
  }
  if (req.url === base + 'worker.js') {
    res.setHeader('content-type', 'text/javascript')
    res.setHeader('service-worker-allowed', '/')
    res.end("self.addEventListener('fetch',e=>e.respondWith(new Response('intercepted')))")
    return
  }
  if (req.url === base + 'api') {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ ok: true, cookie: req.headers.cookie || '', authorization: req.headers.authorization || '' }))
    return
  }
  if (req.url === base + 'style.css') {
    res.setHeader('content-type', 'text/css')
    res.end('body{font:18px system-ui;padding:24px}button{padding:12px}')
    return
  }
  if (req.url === base + 'app.js') {
    res.setHeader('content-type', 'text/javascript')
    res.end(
      `document.querySelector('button').onclick=async()=>{const r=await fetch('api');const data=await r.json();document.querySelector('#result').textContent=data.ok?'API OK':'failed'};const ws=new WebSocket(location.href.replace(/^http/,'ws')+'hmr');ws.onmessage=e=>{document.querySelector('#hmr').textContent=e.data};ws.onclose=()=>{document.querySelector('#hmr').textContent='DISCONNECTED'};window.sampleWS=ws;`,
    )
    return
  }
  res.setHeader('content-type', 'text/html')
  res.setHeader('set-cookie', 'dsh-phalanx_session=forged; Path=/')
  res.end(
    '<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body><h1>Private service preview</h1><button>Check API</button><output id="result"></output><p id="hmr">Connecting</p><script src="app.js"></script></body></html>',
  )
})
server.on('upgrade', async (req, socket) => {
  if (fs.existsSync('/tmp/hold-upgrade')) {
    fs.writeFileSync('/tmp/upgrade-pending', 'ready')
    await new Promise(resolve => {
      const poll = setInterval(() => {
        if (!fs.existsSync('/tmp/hold-upgrade')) {
          clearInterval(poll)
          resolve()
        }
      }, 20)
    })
  }
  if (req.url !== base + 'hmr') {
    socket.destroy()
    return
  }
  const accept = crypto
    .createHash('sha1')
    .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64')
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n')
  const body = Buffer.from('HMR READY')
  socket.write(Buffer.concat([Buffer.from([129, body.length]), body]))
  peers.add(socket)
  socket.on('close', () => peers.delete(socket))
  socket.on('error', () => {})
  socket.on('data', chunk => {
    if ((chunk[0] & 15) !== 1) return
    const length = chunk[1] & 127
    if (length > 125 || chunk.length < 6 + length) return
    const text = Buffer.from(chunk.subarray(6, 6 + length))
    for (let i = 0; i < text.length; i++) text[i] ^= chunk[2 + (i % 4)]
    if (text.toString() === 'PING') socket.write(frame('PONG'))
  })
})
server.listen(4300, '127.0.0.1', () => console.log('PREVIEW_SERVICE_READY'))
