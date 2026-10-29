import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { Duplex } from 'node:stream'
import type { PreviewTarget, ServicePreviewTransportPort } from '../ports/service-preview.js'

/** Connects exclusively to an admitted container's loopback; no published host port. */
export class ContainerServicePreviewTransport implements ServicePreviewTransportPort {
  constructor(private readonly executable: string) {}
  connect(target: PreviewTarget): Duplex {
    const script = `const s=require('node:net').connect(${target.port},'127.0.0.1');process.stdin.pipe(s);s.pipe(process.stdout);s.on('error',()=>process.exit(1));s.on('close',()=>process.exit());`
    const child = spawn(this.executable, ['exec', '-i', target.instance.containerName!, 'node', '-e', script], { stdio: ['pipe', 'pipe', 'pipe'] })
    child.stderr.resume()
    const stream = new Duplex({
      read() {
        child.stdout.resume()
      },
      write(chunk, encoding, callback) {
        child.stdin.write(chunk, encoding, callback)
      },
      final(callback) {
        child.stdin.end(callback)
      },
      destroy(error, callback) {
        child.stdin.destroy()
        child.stdout.destroy()
        child.kill()
        callback(error)
      },
    })
    child.stdout.on('data', (chunk: Buffer) => {
      if (!stream.push(chunk)) child.stdout.pause()
    })
    child.stdout.once('end', () => stream.push(null))
    child.stdin.on('error', error => stream.destroy(error))
    child.stdout.on('error', error => stream.destroy(error))
    child.once('error', error => stream.destroy(error))
    child.once('exit', code => {
      if (code) stream.destroy(new Error('Preview service stopped'))
    })
    stream.on('error', () => {})
    return stream
  }
}

export class RandomPreviewCapabilities {
  issue(): string {
    return randomBytes(32).toString('hex')
  }
}
